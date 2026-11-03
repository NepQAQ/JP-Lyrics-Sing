/**
 * JP-Lyrics-Sing 歌词代理
 *
 * 面向 GitHub Pages 的轻量后端：
 *   GET /api/search?q=Bloody%20Stream&limit=10
 *   GET /api/lyric?id=26239032
 *   GET /api/lyric?title=Bloody%20Stream&artist=Coda
 *   GET /api/marumaru/search/<关键词>
 *   GET /api/marumaru/lyric?url=japanese-song/play-xxxx
 *
 * 数据源：
 *   - 网易云音乐网页端歌词接口（无需登录），提供 yrc 逐字时间轴、ytlrc 中文翻译、yromalrc 罗马音。
 *   - marumaru-x.com（国内直连）：补充带 ruby 注音的歌词与中文翻译。
 */

const UPSTREAM_TIMEOUT_MS = 12000;
const SEARCH_CACHE_TTL = 60 * 60; // 1 小时
const LYRIC_CACHE_TTL = 7 * 24 * 60 * 60; // 7 天
const MARUMARU_BASE = 'https://www.marumaru-x.com';

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://music.163.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
  // 网易云对无 Cookie 的请求更容易判定为异常，带上客户端标识可降低风控概率
  'Cookie': 'appver=2.0.2; os=pc; NMTID=00O',
};

// marumaru-x.com 是普通 HTML 站点，带浏览器头即可正常访问（国内直连）
const MARUMARU_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': MARUMARU_BASE + '/',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja;q=0.9,zh-CN,zh;q=0.8,en;q=0.7',
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const origin = request.headers.get('Origin');

    if (origin && !isAllowedOrigin(origin, env)) {
      return jsonResponse(
        { error: { code: 'ORIGIN_NOT_ALLOWED', message: '该来源未被允许访问歌词代理' } },
        { status: 403, request, env }
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse(
        { error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET 请求' } },
        { status: 405, request, env }
      );
    }

    try {
      if (path === '/' || path === '/api') {
        return jsonResponse(
          {
            service: 'jp-lyrics-proxy',
            version: '0.1.0',
            endpoints: {
              health: '/api/health',
              search: '/api/search?q=Bloody%20Stream&limit=10',
              lyricById: '/api/lyric?id=26239032',
              lyricByTitle: '/api/lyric?title=Bloody%20Stream&artist=Coda',
              marumaruSearch: '/api/marumaru/search/<关键词>',
              marumaruLyric: '/api/marumaru/lyric?url=japanese-song/play-xxxx',
            },
          },
          { request, env, cacheControl: 'no-store' }
        );
      }

      if (path === '/api/health') {
        return jsonResponse(
          {
            ok: true,
            service: 'jp-lyrics-proxy',
            time: new Date().toISOString(),
          },
          { request, env, cacheControl: 'no-store' }
        );
      }

      if (path === '/api/search' || path.startsWith('/api/search/')) {
        return await handleSearch(request, url, env, ctx);
      }

      if (path === '/api/lyric') {
        return await handleLyric(request, url, env, ctx);
      }

      if (path === '/api/marumaru/search' || path.startsWith('/api/marumaru/search/')) {
        return await handleMarumaruSearch(request, url, env, ctx);
      }

      if (path === '/api/marumaru/lyric') {
        return await handleMarumaruLyric(request, url, env, ctx);
      }

      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      return errorResponse(error, request, env);
    }
  },
};

async function handleSearch(request, url, env, ctx) {
  const q = searchQuery(url);
  if (!q) {
    throw new ApiError(400, 'MISSING_QUERY', '缺少搜索关键词 q');
  }
  const limit = clampInt(url.searchParams.get('limit'), 1, 20, 10);

  const cached = await cachedJson(
    ctx,
    request,
    'search',
    { q, limit },
    SEARCH_CACHE_TTL,
    async () => {
      const { results, via, attempts } = await searchNetease(q, limit);
      // 上游偶发返回与关键词无关的结果（手机端出现过搜「群青」拿到「94」的歌），
      // 一旦写入缓存会被固化。宁可报错让前端重试，也绝不返回/缓存错乱结果。
      if (results.length && !results.some((song) => resultMatchesQuery(q, song))) {
        console.log('[diag][mismatch]', JSON.stringify({ q, top: results.slice(0, 3).map((r) => r.title) }));
        throw new ApiError(502, 'UPSTREAM_SEARCH_MISMATCH', '搜索结果与关键词不符，请重试');
      }
      return {
        source: 'netease',
        query: q,
        count: results.length,
        results,
        ...(via ? { via } : {}),
        ...(results.length ? {} : { attempts }),
      };
    },
    (data) => data.count > 0,
    // 缓存命中的结果必须确实属于当前关键词，否则视为脏缓存重新取
    (data) => sameQuery(data?.query, q)
  );

  // 临时诊断：记录缓存命中状态与最终返回内容
  console.log('[diag][search]', JSON.stringify({
    q,
    cacheState: cached.state,
    count: cached.data?.count ?? null,
    top: (cached.data?.results || []).slice(0, 3).map((r) => r.title),
  }));
  return jsonResponse(
    cached.data,
    {
      request,
      env,
      // 搜索结果一律不缓存到浏览器/中间链路：一旦被按路径缓存，
      // 不同关键词会互相串结果（手机端出现过搜「群青」拿到「94」的结果）。
      cacheControl: 'no-store',
      headers: { 'X-Cache': cached.state },
    }
  );
}

async function handleLyric(request, url, env, ctx) {
  const idParam = cleanQuery(url.searchParams.get('id'));
  const title = cleanQuery(url.searchParams.get('title'));
  const artist = cleanQuery(url.searchParams.get('artist'));
  const duration = parsePositiveInt(url.searchParams.get('duration'));

  let target = null;

  if (idParam) {
    if (!/^\d{1,20}$/.test(idParam)) {
      throw new ApiError(400, 'INVALID_ID', 'id 必须是数字');
    }
    target = {
      id: Number(idParam),
      title,
      artist,
      album: '',
      duration,
      matchScore: null,
    };
  } else {
    if (!title) {
      throw new ApiError(400, 'MISSING_TITLE', '需要提供 id 或 title');
    }

    const q = [title, artist].filter(Boolean).join(' ');
    const cachedSearch = await cachedJson(
      ctx,
      request,
      'lyric-search',
      { q, limit: 10 },
      SEARCH_CACHE_TTL,
      async () => {
        const { results } = await searchNetease(q, 10);
        return { results };
      },
      (data) => Array.isArray(data.results) && data.results.length > 0
    );

    target = pickBestCandidate(cachedSearch.data.results || [], title, artist, duration);
    if (!target) {
      throw new ApiError(404, 'SONG_NOT_FOUND', '没有找到匹配的歌曲');
    }
  }

  const cached = await cachedJson(
    ctx,
    request,
    'lyric',
    { id: target.id },
    LYRIC_CACHE_TTL,
    async () => fetchLyricData(target)
  );

  return jsonResponse(
    cached.data,
    {
      request,
      env,
      cacheControl: 'public, max-age=21600',
      headers: { 'X-Cache': cached.state },
    }
  );
}

/* ---------------- marumaru-x.com（注音歌词 + 中文翻译） ---------------- */

// 搜索：GET /api/marumaru/search/<关键词>
// 上游是 https://www.marumaru-x.com/japanese-song/search-all/<关键词> 的隐藏接口。
async function handleMarumaruSearch(request, url, env, ctx) {
  const q = marumaruSearchQuery(url);
  if (!q) {
    throw new ApiError(400, 'MISSING_QUERY', '缺少搜索关键词');
  }

  const cached = await cachedJson(
    ctx,
    request,
    'marumaru-search',
    { q },
    SEARCH_CACHE_TTL,
    async () => {
      const results = await searchMarumaru(q);
      return {
        source: 'marumaru',
        query: q,
        count: results.length,
        results,
      };
    },
    (data) => data.count > 0,
    (data) => sameQuery(data?.query, q)
  );

  return jsonResponse(
    cached.data,
    {
      request,
      env,
      cacheControl: 'no-store',
      headers: { 'X-Cache': cached.state },
    }
  );
}

// 歌词详情：GET /api/marumaru/lyric?url=japanese-song/play-xxxx
// 只做粗粒度切片（行 → 日文原文 HTML / 中文翻译），ruby 注音的精算交给前端 DOMParser。
async function handleMarumaruLyric(request, url, env, ctx) {
  const raw = cleanQuery(url.searchParams.get('url'));
  const path = marumaruLyricPath(raw);
  if (!path) {
    throw new ApiError(400, 'INVALID_URL', 'url 必须是 marumaru-x.com 的 japanese-song/play-xxx 页面');
  }

  const cached = await cachedJson(
    ctx,
    request,
    'marumaru-lyric',
    { path },
    LYRIC_CACHE_TTL,
    async () => fetchMarumaruLyric(path)
  );

  return jsonResponse(
    cached.data,
    {
      request,
      env,
      cacheControl: 'public, max-age=21600',
      headers: { 'X-Cache': cached.state },
    }
  );
}

async function searchMarumaru(query) {
  const target = `${MARUMARU_BASE}/japanese-song/search-all/${encodeURIComponent(query)}`;
  const response = await fetchUpstream(target, 1, { headers: MARUMARU_HEADERS, timeoutMs: 20000 });
  if (!response.ok) {
    throw new ApiError(502, 'MARUMARU_SEARCH_FAILED', `Marumaru 搜索返回 ${response.status}`);
  }
  const html = await response.text();
  return parseMarumaruSearchHtml(html);
}

async function fetchMarumaruLyric(path) {
  const response = await fetchUpstream(`${MARUMARU_BASE}/${path}`, 1, { headers: MARUMARU_HEADERS, timeoutMs: 20000 });
  if (!response.ok) {
    throw new ApiError(502, 'MARUMARU_LYRIC_FAILED', `Marumaru 歌词页返回 ${response.status}`);
  }
  const html = await response.text();
  const data = parseMarumaruLyricHtml(html);
  if (!data.lines.length) {
    throw new ApiError(404, 'NO_LYRIC', 'Marumaru 页面未能解析出歌词');
  }
  return data;
}

// 搜索结果页结构（探测结论）：
//   <div id="vt-data-list"> 内若干 <div class="song-list-root">，
//   每条：h2.card-title > a[href="japanese-song/play-xxx"][title="歌名"]，后随 h3.card-subtitle（歌手）。
function parseMarumaruSearchHtml(html) {
  const results = [];
  const rowRe =
    /<h2[^>]*class="[^"]*card-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<\/a>\s*<\/h2>\s*<h3[^>]*class="[^"]*card-subtitle[^"]*"[^>]*>([\s\S]*?)<\/h3>/g;

  let match;
  while ((match = rowRe.exec(html))) {
    let href = match[1].trim();
    if (!/japanese-song\/play-[\w-]+/i.test(href)) continue;
    // href 是站内相对路径，统一挂到站点根，方便前端直接回传给歌词接口
    if (!/^https?:\/\//i.test(href)) href = MARUMARU_BASE + '/' + href.replace(/^\/+/, '');
    const title = decodeHtmlEntities(match[2] || '').trim();
    const artist = decodeHtmlEntities(stripTags(match[3] || '')).trim();
    if (!title) continue;
    results.push({ url: href, title, artist });
  }
  return results;
}

// 歌词详情页结构（探测结论）：
//   <ul id="lyrics-list"> 内若干 <li class="mr-lyrics-list">，
//   每行：<p lang="ja">（含 <ruby><rb>漢字</rb><rt>かな</rt></ruby> 注音）、
//         <p class="lyrics-translate-zh">、<p class="lyrics-translate-en">。
function parseMarumaruLyricHtml(html) {
  const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const title = titleMatch ? decodeHtmlEntities(stripRt(titleMatch[1])).trim() : '';

  const lines = [];
  const liRe = /<li[^>]*class="[^"]*mr-lyrics-list[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRe.exec(html))) {
    const row = liMatch[1];
    const jaMatch = row.match(/<p[^>]*lang="ja"[^>]*>([\s\S]*?)<\/p>/);
    if (!jaMatch) continue;
    const zhMatch = row.match(/<p[^>]*class="[^"]*lyrics-translate-zh[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    lines.push({
      ja: jaMatch[1].trim(),
      zh: zhMatch ? decodeHtmlEntities(stripTags(zhMatch[1])).trim() : '',
    });
  }
  return { source: 'marumaru', url: '', title, lineCount: lines.length, lines };
}

function marumaruSearchQuery(url) {
  const match = String(url.pathname || '').match(/^\/api\/marumaru\/search\/(.+)$/);
  if (match) {
    try {
      return cleanQuery(decodeURIComponent(match[1]));
    } catch {
      return '';
    }
  }
  return cleanQuery(url.searchParams.get('q'));
}

// 只接受站内歌词页路径（绝对 URL 或相对路径均可），防 SSRF
function marumaruLyricPath(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(?:https:\/\/www\.marumaru-x\.com)?\/?(japanese-song\/play-[A-Za-z0-9_-]+)\/?$/i);
  return match ? match[1] : null;
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '');
}

// 去掉注音 <rt> 内容（标题里的 ruby 会把读音混进纯文本）
function stripRt(value) {
  return String(value || '').replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

// 网易云搜索有多条等价入口，其中任一入口被风控或限流时空结果；
// 依次尝试，任一返回歌曲即用，全部为空才判定为「没有结果」。
const SEARCH_STRATEGIES = [
  {
    name: 'search/get',
    url: (query, limit) => {
      const api = new URL('https://music.163.com/api/search/get');
      api.searchParams.set('s', query);
      api.searchParams.set('type', '1');
      api.searchParams.set('limit', String(limit));
      api.searchParams.set('offset', '0');
      api.searchParams.set('total', 'true');
      return { url: api.toString(), method: 'GET' };
    },
  },
  {
    name: 'cloudsearch/pc',
    url: (query, limit) => ({
      url: 'https://music.163.com/api/cloudsearch/pc',
      method: 'POST',
      body: new URLSearchParams({
        s: query,
        type: '1',
        limit: String(limit),
        offset: '0',
        total: 'true',
      }).toString(),
    }),
  },
  {
    name: 'v1/search/get',
    url: (query, limit) => {
      const api = new URL('https://music.163.com/api/v1/search/get');
      api.searchParams.set('s', query);
      api.searchParams.set('type', '1');
      api.searchParams.set('limit', String(limit));
      api.searchParams.set('offset', '0');
      return { url: api.toString(), method: 'GET' };
    },
  },
  {
    name: 'search/get(英文参数)',
    url: (query, limit) => {
      const api = new URL('https://music.163.com/api/search/get');
      api.searchParams.set('s', query);
      api.searchParams.set('type', '1');
      api.searchParams.set('limit', String(limit));
      api.searchParams.set('offset', '0');
      api.searchParams.set('keyword', query);
      return { url: api.toString(), method: 'GET' };
    },
  },
];

async function searchNetease(query, limit) {
  const attempts = [];
  let lastError = null;

  for (const strategy of SEARCH_STRATEGIES) {
    try {
      const request = strategy.url(query, limit);
      const init = {
        method: request.method,
        headers: request.body
          ? { ...UPSTREAM_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }
          : UPSTREAM_HEADERS,
        ...(request.body ? { body: request.body } : {}),
      };
      const response = await fetchUpstream(request.url, 0, init);
      if (!response.ok) {
        attempts.push({ via: strategy.name, status: response.status });
        continue;
      }
      const data = await readJson(response, '网易云搜索返回了非 JSON 内容');
      const songs = data?.result?.songs;
      const code = data?.code ?? null;
      // 临时诊断：记录 worker 实际发给网易云的关键词与上游返回内容
      console.log('[diag][netease]', JSON.stringify({
        via: strategy.name,
        query,
        upstreamUrl: request.url,
        code,
        songCount: Array.isArray(songs) ? songs.length : null,
        top: (Array.isArray(songs) ? songs : []).slice(0, 3).map((s) => s?.name || s?.title || ''),
      }));
      if (!Array.isArray(songs) || !songs.length) {
        attempts.push({ via: strategy.name, status: 200, code, count: 0 });
        continue;
      }
      const mapped = songs
        .map((song) => ({
          id: Number(song?.id),
          title: cleanText(song?.name || song?.title || ''),
          artist: (Array.isArray(song?.artists)
            ? song.artists
            : Array.isArray(song?.ar)
              ? song.ar
              : []
          )
            .map((item) => cleanText(item?.name || ''))
            .filter(Boolean)
            .join(' / '),
          album: cleanText(song?.album?.name || song?.al?.name || ''),
          duration: Number(song?.duration || song?.dt || 0) || 0,
        }))
        .filter((song) => Number.isFinite(song.id) && song.id > 0);
      // 网易云对部分出口 IP 偶发返回与关键词完全无关的错乱结果
      // （出现过 s=群青 却返回「94」的歌曲列表）：视为该通道无效，降级尝试下一通道
      if (mapped.length && !mapped.some((song) => resultMatchesQuery(query, song))) {
        console.log('[diag][mismatch-fallback]', JSON.stringify({ via: strategy.name, query, top: mapped.slice(0, 3).map((r) => r.title) }));
        attempts.push({ via: strategy.name, status: 200, code, count: mapped.length, mismatch: true });
        continue;
      }
      return { via: strategy.name, attempts, results: mapped };
    } catch (error) {
      lastError = error;
      attempts.push({ via: strategy.name, error: error.message });
    }
  }

  if (attempts.every((item) => item.error)) {
    throw lastError || new ApiError(502, 'UPSTREAM_SEARCH_FAILED', '网易云搜索全部入口失败');
  }

  // 所有通道都返回了与关键词无关的错乱结果：大概率是上游对当前出口 IP 的风控。
  // 报错让前端重试（重试可能落到正常出口），绝不把错乱结果当成功返回。
  if (attempts.length && attempts.every((item) => item.mismatch)) {
    throw new ApiError(502, 'UPSTREAM_SEARCH_MISMATCH', '搜索结果与关键词不符，请重试');
  }

  return { via: null, attempts, results: [] };
}

async function fetchLyricData(target) {
  const api = new URL('https://music.163.com/api/song/lyric');
  api.searchParams.set('os', 'pc');
  api.searchParams.set('id', String(target.id));
  api.searchParams.set('lv', '-1');
  api.searchParams.set('tv', '-1');
  api.searchParams.set('yv', '-1');

  const response = await fetchUpstream(api.toString());
  if (!response.ok) {
    throw new ApiError(502, 'UPSTREAM_LYRIC_FAILED', `网易云歌词返回 ${response.status}`);
  }

  const data = await readJson(response, '网易云歌词返回了非 JSON 内容');

  if (data?.nolyric || data?.uncollected || data?.code === 404) {
    throw new ApiError(404, 'NO_LYRIC', '这首歌暂时没有可用歌词');
  }

  const lrcText = cleanText(data?.lrc?.lyric || '');
  const yrcText = cleanText(data?.yrc?.lyric || '');
  const translationText =
    cleanText(data?.ytlrc?.lyric || '') || cleanText(data?.tlyric?.lyric || '');
  const romajiText =
    cleanText(data?.yromalrc?.lyric || '') || cleanText(data?.romalrc?.lyric || '');

  let lines = yrcText ? parseYrc(yrcText) : [];
  let timing = lines.length ? 'word' : 'line';

  if (!lines.length && lrcText) {
    lines = parseLrc(lrcText);
    timing = 'line';
  }

  if (!lines.length) {
    throw new ApiError(404, 'NO_LYRIC', '这首歌暂时没有可用歌词');
  }

  const translationMap = buildLineMap(translationText);
  const romajiMap = buildLineMap(romajiText);

  const normalizedLines = lines.map((line) => {
    const lineMs = Math.round(line.time * 1000);
    const translation = lookupLine(translationMap, lineMs);
    return {
      time: round3(line.time),
      duration: round3(line.duration || 0),
      text: cleanText(line.text),
      // zh 与前端现有 LRC 行结构保持一致，translation 作为语义化别名保留。
      zh: translation,
      translation,
      romaji: lookupLine(romajiMap, lineMs),
      ...(line.wordTiming && line.wordTiming.length
        ? {
            wordTiming: line.wordTiming.map((word) => ({
              text: word.text,
              starttime: word.starttime,
              endtime: word.endtime,
            })),
          }
        : {}),
    };
  });

  return {
    source: 'netease',
    id: target.id,
    title: target.title || '',
    artist: target.artist || '',
    album: target.album || '',
    duration: target.duration || 0,
    matchScore: target.matchScore ?? null,
    timing,
    hasWordTiming: timing === 'word',
    hasTranslation: translationMap.size > 0,
    hasRomaji: romajiMap.size > 0,
    lineCount: normalizedLines.length,
    lines: normalizedLines,
  };
}

/**
 * 解析网易云 yrc 逐字歌词。
 * 格式：[行开始ms,行时长ms](字开始ms,字时长ms,0)文字(...)
 * 时间戳均为毫秒，返回 time/duration 为秒，wordTiming 保留毫秒。
 */
function parseYrc(text) {
  const lines = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!header) continue;

    const lineStart = Number(header[1]);
    const lineDuration = Number(header[2]);
    const body = header[3];

    const metas = [...body.matchAll(/\((\d+),(\d+),(\d+)\)/g)];
    if (!metas.length) {
      const plain = cleanText(body);
      if (plain) {
        lines.push({
          time: lineStart / 1000,
          duration: lineDuration / 1000,
          text: plain,
          wordTiming: null,
        });
      }
      continue;
    }

    const wordTiming = [];
    let lineText = '';

    for (let i = 0; i < metas.length; i += 1) {
      const meta = metas[i];
      const start = Number(meta[1]);
      const duration = Number(meta[2]);
      const textStart = meta.index + meta[0].length;
      const textEnd = i + 1 < metas.length ? metas[i + 1].index : body.length;
      const chunk = body.slice(textStart, textEnd);

      if (!chunk) continue;

      wordTiming.push({
        text: chunk,
        starttime: start,
        endtime: start + duration,
      });
      lineText += chunk;
    }

    const finalText = cleanText(lineText);
    if (!finalText) continue;

    lines.push({
      time: lineStart / 1000,
      duration: lineDuration / 1000,
      text: finalText,
      wordTiming,
    });
  }

  return lines;
}

/**
 * 解析普通 LRC。支持一行多个时间标签，返回按时间排序的行。
 */
function parseLrc(text) {
  const lines = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;

    const content = cleanText(line.replace(/\[[^\]]*\]/g, ''));
    if (!content) continue;

    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const fraction = (tag[3] || '0').padEnd(3, '0').slice(0, 3);
      const time = minutes * 60 + seconds + Number(fraction) / 1000;

      lines.push({
        time,
        duration: 0,
        text: content,
        wordTiming: null,
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

function buildLineMap(text) {
  const map = new Map();
  if (!text) return map;

  for (const line of parseLrc(text)) {
    const key = Math.round(line.time * 1000);
    if (!map.has(key)) map.set(key, line.text);
  }

  return map;
}

function lookupLine(map, lineMs) {
  if (!map || map.size === 0) return '';

  const exact = map.get(lineMs);
  if (exact) return exact;

  let closestText = '';
  let closestDiff = Infinity;

  for (const [key, value] of map) {
    const diff = Math.abs(key - lineMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestText = value;
    }
  }

  // 允许翻译时间轴存在几十毫秒的取整误差，但不能跨行硬套。
  return closestDiff <= 120 ? closestText : '';
}

function pickBestCandidate(candidates, title, artist, duration) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const normalizedTitle = normalizeMatchText(title);
  const normalizedArtist = normalizeMatchText(artist);
  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    let score = 0;
    const candidateTitle = normalizeMatchText(candidate.title);
    const candidateArtist = normalizeMatchText(candidate.artist);

    if (candidateTitle === normalizedTitle) {
      score += 100;
    } else if (
      candidateTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(candidateTitle)
    ) {
      score += 55;
    }

    if (normalizedArtist) {
      if (candidateArtist === normalizedArtist) {
        score += 60;
      } else if (
        candidateArtist.includes(normalizedArtist) ||
        normalizedArtist.includes(candidateArtist)
      ) {
        score += 35;
      }
    }

    if (duration && candidate.duration) {
      const diff = Math.abs(duration - candidate.duration);
      if (diff <= 2000) score += 25;
      else if (diff <= 5000) score += 10;
      else if (diff > 20000) score -= 10;
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best ? { ...best, matchScore: bestScore } : null;
}

async function fetchUpstream(url, retries = 1, init = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    // marumaru 页面偶发较慢，允许按调用点放宽超时
    const timer = setTimeout(() => controller.abort(), init.timeoutMs || UPSTREAM_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: init.method || 'GET',
        headers: init.headers || UPSTREAM_HEADERS,
        signal: controller.signal,
        redirect: 'follow',
        ...(init.body ? { body: init.body } : {}),
      });
      clearTimeout(timer);

      if (response.status === 429 || response.status >= 500) {
        lastError = new ApiError(
          502,
          'UPSTREAM_BAD_STATUS',
          `网易云暂时不可用（HTTP ${response.status}）`
        );
        if (attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return response;
      }

      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
      }
    }
  }

  if (lastError instanceof ApiError) throw lastError;
  throw new ApiError(504, 'UPSTREAM_TIMEOUT', '网易云请求超时');
}

async function readJson(response, message) {
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, 'UPSTREAM_INVALID_JSON', message);
  }
}

async function cachedJson(ctx, request, bucket, params, ttlSeconds, producer, shouldCache, validateHit) {
  let cache = null;
  try {
    cache = caches.default;
  } catch {
    cache = null;
  }

  if (!cache) {
    return { data: await producer(), state: 'BYPASS' };
  }

  const keyUrl = new URL(request.url);
  keyUrl.search = '';
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      keyUrl.searchParams.set(key, String(value));
    }
  }
  // v4：废弃历史上被上游污染的搜索缓存（出现过 query=群青 但内容是「94」的脏数据）
  keyUrl.searchParams.set('__cache', `${bucket}:v4`);

  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) {
    try {
      const data = await hit.json();
      if (!validateHit || validateHit(data)) {
        return { data, state: 'HIT' };
      }
    } catch {
      // 缓存内容损坏时直接重新取。
    }
  }

  const data = await producer();
  // 空结果不进缓存：风控/限流导致的临时空返回不能被固化，
  // 否则用户要等整个 TTL 过期才能重新搜到（历史上正是这样出现过「搜不到」）。
  if (shouldCache && !shouldCache(data)) {
    return { data, state: 'SKIP' };
  }
  const stored = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttlSeconds}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, stored));
  return { data, state: 'MISS' };
}

function errorResponse(error, request, env) {
  if (error instanceof ApiError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      { status: error.status, request, env }
    );
  }

  console.error('[jp-lyrics-proxy]', error);
  return jsonResponse(
    { error: { code: 'INTERNAL_ERROR', message: '歌词服务暂时不可用' } },
    { status: 500, request, env }
  );
}

function jsonResponse(data, { status = 200, request, env, cacheControl = 'no-store', headers = {} } = {}) {
  const responseHeaders = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(request, env),
  });

  for (const [key, value] of Object.entries(headers)) {
    responseHeaders.set(key, value);
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

function corsHeaders(request, env) {
  const origin = request?.headers?.get('Origin');
  if (!origin || !isAllowedOrigin(origin, env)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'X-Cache',
    'Vary': 'Origin',
  };
}

function isAllowedOrigin(origin, env) {
  if (typeof origin !== 'string' || !origin) return false;
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) return true;

  const allowed = String(env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return allowed.includes(origin);
}

function normalizePath(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '');
  return path || '/';
}

function cleanQuery(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 120);
}

// 关键词支持两种写法：/api/search/<关键词> 或 /api/search?q=<关键词>。
// 路径式用于绕开会丢弃 URL 查询串的移动网络/中间缓存，避免不同关键词互相串结果。
function searchQuery(url) {
  const match = String(url.pathname || '').match(/^\/api\/search\/(.+)$/);
  if (match) {
    try {
      return cleanQuery(decodeURIComponent(match[1]));
    } catch {
      return '';
    }
  }
  return cleanQuery(url.searchParams.get('q'));
}

function sameQuery(value, expected) {
  return String(value || '').trim().toLowerCase() === String(expected || '').trim().toLowerCase();
}

function cleanText(value) {
  return String(value || '')
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/\u2005/g, ' ')
    .trim();
}

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_'"“”‘’・·.,，。!！?？:：()（）[\]【】]/g, '');
}

// 宽松相关性自检：query 的每个词都出现在同一首歌的标题/歌手/专辑里才算有效。
// 拦截上游偶发的错乱返回（如搜「群青」返回「94」），避免错数据被返回或固化进缓存。
function resultMatchesQuery(query, song) {
  const tokens = String(query || '')
    .trim()
    .split(/\s+/)
    .map((token) => normalizeMatchText(token))
    .filter(Boolean);
  if (!tokens.length) return true;
  const haystack = normalizeMatchText([song?.title, song?.artist, song?.album].join(' '));
  return tokens.every((token) => haystack.includes(token));
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parsePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
