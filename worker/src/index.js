/**
 * JP-Lyrics-Sing 歌词代理
 *
 * 面向 GitHub Pages 的轻量后端：
 *   GET /api/search?q=Bloody%20Stream&limit=10
 *   GET /api/lyric?id=26239032
 *   GET /api/lyric?title=Bloody%20Stream&artist=Coda
 *
 * 数据源：网易云音乐网页端歌词接口（无需登录）。
 * 返回统一结构，优先提供 yrc 逐字时间轴、ytlrc 中文翻译、yromalrc 罗马音。
 */

const UPSTREAM_TIMEOUT_MS = 12000;
const SEARCH_CACHE_TTL = 60 * 60; // 1 小时
const LYRIC_CACHE_TTL = 7 * 24 * 60 * 60; // 7 天

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://music.163.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
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

      if (path === '/api/search') {
        return await handleSearch(request, url, env, ctx);
      }

      if (path === '/api/lyric') {
        return await handleLyric(request, url, env, ctx);
      }

      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      return errorResponse(error, request, env);
    }
  },
};

async function handleSearch(request, url, env, ctx) {
  const q = cleanQuery(url.searchParams.get('q'));
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
      const results = await searchNetease(q, limit);
      return { source: 'netease', query: q, count: results.length, results };
    }
  );

  return jsonResponse(
    cached.data,
    {
      request,
      env,
      cacheControl: `public, max-age=${SEARCH_CACHE_TTL}`,
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
        const results = await searchNetease(q, 10);
        return { results };
      }
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

async function searchNetease(query, limit) {
  const api = new URL('https://music.163.com/api/search/get');
  api.searchParams.set('s', query);
  api.searchParams.set('type', '1');
  api.searchParams.set('limit', String(limit));
  api.searchParams.set('offset', '0');

  const response = await fetchUpstream(api.toString());
  if (!response.ok) {
    throw new ApiError(502, 'UPSTREAM_SEARCH_FAILED', `网易云搜索返回 ${response.status}`);
  }

  const data = await readJson(response, '网易云搜索返回了非 JSON 内容');
  const songs = data?.result?.songs;

  if (!Array.isArray(songs)) return [];

  return songs
    .map((song) => ({
      id: Number(song?.id),
      title: cleanText(song?.name || song?.title || ''),
      artist: (Array.isArray(song?.artists) ? song.artists : Array.isArray(song?.ar) ? song.ar : [])
        .map((item) => cleanText(item?.name || ''))
        .filter(Boolean)
        .join(' / '),
      album: cleanText(song?.album?.name || song?.al?.name || ''),
      duration: Number(song?.duration || song?.dt || 0) || 0,
    }))
    .filter((song) => Number.isFinite(song.id) && song.id > 0);
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

async function fetchUpstream(url, retries = 1) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: UPSTREAM_HEADERS,
        signal: controller.signal,
        redirect: 'follow',
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

async function cachedJson(ctx, request, bucket, params, ttlSeconds, producer) {
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
  keyUrl.searchParams.set('__cache', bucket);

  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) {
    try {
      return { data: await hit.json(), state: 'HIT' };
    } catch {
      // 缓存内容损坏时直接重新取。
    }
  }

  const data = await producer();
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
