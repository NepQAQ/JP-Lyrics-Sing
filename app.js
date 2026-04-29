/* 日语跟唱 App - main logic */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const audio = $('#audio');
const lyricsView = $('#lyrics-view');
const statusEl = $('#status');
const searchInput = $('#search-input');
const searchResults = $('#search-results');

let kuroshiro = null;
let kuroshiroReady = null;
let lrcLines = [];
let activeIdx = -1;
let translationCache = new Map();

/* ---------------- Theme ---------------- */
const THEME_KEY = 'jplrc-theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#btn-theme .theme-icon').textContent = theme === 'dark' ? '🌙' : '☀️';
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b0d24' : '#f5f7ff');
  localStorage.setItem(THEME_KEY, theme);
}
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
})();
$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

/* ---------------- UI helpers ---------------- */
function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

function applyToggleClasses() {
  const hideF = !$('#show-furigana').checked;
  const hideR = !$('#show-romaji').checked;
  const hideZ = !$('#show-zh').checked;
  $$('.lrc-line').forEach(el => {
    el.classList.toggle('hide-furigana', hideF);
    el.classList.toggle('hide-romaji', hideR);
    el.classList.toggle('hide-zh', hideZ);
  });
}
['show-furigana', 'show-romaji', 'show-zh'].forEach(id => {
  $('#' + id).addEventListener('change', applyToggleClasses);
});

$('#btn-toggle-panel').addEventListener('click', () => {
  $('#panel').classList.toggle('hidden');
});

/* ---------------- Tabs ---------------- */
$$('.source-tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    $$('.source-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
    $$('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === target));
  });
});

/* ---------------- Kuroshiro ---------------- */
async function ensureKuroshiro() {
  if (kuroshiroReady) return kuroshiroReady;
  setStatus('正在加载日语分词器（首次约 2-5MB，请稍候）...');
  kuroshiroReady = (async () => {
    const k = new Kuroshiro.default();
    const analyzer = new KuromojiAnalyzer({
      dictPath: 'https://unpkg.com/kuromoji@0.1.2/dict/'
    });
    await k.init(analyzer);
    kuroshiro = k;
    setStatus('分词器已就绪 ✓');
    return k;
  })();
  return kuroshiroReady;
}

async function toFurigana(text) {
  if (!text || !text.trim()) return { html: '', romaji: '' };
  const k = await ensureKuroshiro();
  // Split text by reading-overrides; render override segments by hand, kuroshiro for the rest.
  const segments = splitByOverrides(text);
  let html = '', romajiParts = [];
  for (const seg of segments) {
    if (seg.type === 'override') {
      html += `<ruby>${escapeHTML(seg.kanji)}<rt>${escapeHTML(seg.kana)}</rt></ruby>`;
      romajiParts.push(seg.romaji);
    } else {
      const t = seg.text;
      if (!t) continue;
      const h = await k.convert(t, { to: 'hiragana', mode: 'furigana' });
      const r = await k.convert(t, { to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn' });
      html += h;
      if (r) romajiParts.push(r.trim());
    }
  }
  return { html, romaji: romajiParts.join(' ').replace(/\s+/g, ' ').trim() };
}

/* ---------------- Reading overrides ---------------- */
// Common kuromoji-IPADIC misreads in lyrics. Each entry: kanji surface -> { kana (hiragana), romaji }
const DEFAULT_OVERRIDES = {
  '二人': { kana: 'ふたり', romaji: 'futari' },
  '一人': { kana: 'ひとり', romaji: 'hitori' },
  '大人': { kana: 'おとな', romaji: 'otona' },
  '今日': { kana: 'きょう', romaji: 'kyō' },
  '明日': { kana: 'あした', romaji: 'ashita' },
  '昨日': { kana: 'きのう', romaji: 'kinō' },
  '今朝': { kana: 'けさ', romaji: 'kesa' },
  '今宵': { kana: 'こよい', romaji: 'koyoi' },
  '今夜': { kana: 'こんや', romaji: "kon'ya" },
  '一日': { kana: 'いちにち', romaji: 'ichinichi' },
  '一晩': { kana: 'ひとばん', romaji: 'hitoban' },
  '一度': { kana: 'いちど', romaji: 'ichido' },
  '一瞬': { kana: 'いっしゅん', romaji: 'isshun' },
  '一生': { kana: 'いっしょう', romaji: 'isshō' },
  '一緒': { kana: 'いっしょ', romaji: 'issho' },
  '上手': { kana: 'じょうず', romaji: 'jōzu' },
  '下手': { kana: 'へた', romaji: 'heta' },
  '為': { kana: 'ため', romaji: 'tame' },
  '為に': { kana: 'ために', romaji: 'tame ni' },
  '何処': { kana: 'どこ', romaji: 'doko' },
  '何時': { kana: 'いつ', romaji: 'itsu' },
  '何故': { kana: 'なぜ', romaji: 'naze' },
  '此処': { kana: 'ここ', romaji: 'koko' },
  '其処': { kana: 'そこ', romaji: 'soko' },
  '彼方': { kana: 'かなた', romaji: 'kanata' },
  '何時か': { kana: 'いつか', romaji: 'itsuka' },
  '貴方': { kana: 'あなた', romaji: 'anata' },
  '貴女': { kana: 'あなた', romaji: 'anata' },
  '私達': { kana: 'わたしたち', romaji: 'watashitachi' },
  '僕達': { kana: 'ぼくたち', romaji: 'bokutachi' },
  '君達': { kana: 'きみたち', romaji: 'kimitachi' },
  '彼等': { kana: 'かれら', romaji: 'karera' },
  '世界中': { kana: 'せかいじゅう', romaji: 'sekaijū' },
  '夜空': { kana: 'よぞら', romaji: 'yozora' },
  '夕焼け': { kana: 'ゆうやけ', romaji: 'yūyake' },
  '朝焼け': { kana: 'あさやけ', romaji: 'asayake' },
  '雪月花': { kana: 'せつげっか', romaji: 'setsugekka' },
  '暁': { kana: 'あかつき', romaji: 'akatsuki' },
};
const OVERRIDES_KEY = 'jplrc-overrides';
let userOverrides = {};
function loadOverrides() {
  try { userOverrides = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); }
  catch { userOverrides = {}; }
}
function saveOverrides() {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(userOverrides));
}
function getMergedOverrides() { return { ...DEFAULT_OVERRIDES, ...userOverrides }; }

// Greedy longest-match split. Returns array of {type:'plain',text} | {type:'override',kanji,kana,romaji}
function splitByOverrides(text) {
  const ov = getMergedOverrides();
  const keys = Object.keys(ov).sort((a, b) => b.length - a.length);
  if (!keys.length) return [{ type: 'plain', text }];
  const out = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    let matched = null;
    for (const k of keys) {
      if (text.startsWith(k, i)) { matched = k; break; }
    }
    if (matched) {
      if (buf) { out.push({ type: 'plain', text: buf }); buf = ''; }
      out.push({ type: 'override', kanji: matched, kana: ov[matched].kana, romaji: ov[matched].romaji });
      i += matched.length;
    } else {
      buf += text[i++];
    }
  }
  if (buf) out.push({ type: 'plain', text: buf });
  return out;
}

/* ---------- Overrides UI ---------- */
function renderOverridesTextarea() {
  const ta = $('#overrides-text');
  if (!ta) return;
  ta.value = Object.entries(userOverrides)
    .map(([k, v]) => `${k}=${v.kana}${v.romaji ? '|' + v.romaji : ''}`)
    .join('\n');
}
// Naive hiragana -> hepburn romaji fallback (covers common syllables, not exhaustive)
const HIRA_ROMAJI = {
  'あ':'a','い':'i','う':'u','え':'e','お':'o',
  'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
  'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
  'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
  'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
  'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
  'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
  'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
  'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
  'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
  'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
  'や':'ya','ゆ':'yu','よ':'yo',
  'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
  'わ':'wa','を':'wo','ん':'n','っ':'',
  'ー':'-',
};
function kanaToRomajiSimple(s) {
  // Handle small-y combos (きゃ etc) and small tsu doubling roughly.
  let out = ''; const small = { 'ゃ':'ya','ゅ':'yu','ょ':'yo' };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1];
    if (next && small[next]) {
      const base = HIRA_ROMAJI[ch] || ch;
      out += base.replace(/i$/, '') + small[next];
      i++;
    } else if (ch === 'っ' && next) {
      const r = HIRA_ROMAJI[next] || '';
      out += r[0] || '';
    } else {
      out += HIRA_ROMAJI[ch] ?? ch;
    }
  }
  return out;
}
function applyOverridesFromTextarea() {
  const lines = $('#overrides-text').value.split(/\r?\n/);
  const next = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([^=]+)=(.+)$/);
    if (!m) continue;
    const kanji = m[1].trim();
    const rest = m[2].trim();
    const [kanaPart, romajiPart] = rest.split('|').map(s => s && s.trim());
    if (!kanji || !kanaPart) continue;
    next[kanji] = {
      kana: kanaPart,
      romaji: romajiPart || kanaToRomajiSimple(kanaPart)
    };
  }
  userOverrides = next;
  saveOverrides();
  setStatus(`已保存 ${Object.keys(userOverrides).length} 条自定义读音。重新加载歌词后生效。`);
}
loadOverrides();

/* Overrides UI wiring (after DOM is parsed by script-at-end) */
renderOverridesTextarea();
$('#btn-save-overrides')?.addEventListener('click', () => {
  applyOverridesFromTextarea();
});
$('#btn-reload-lyrics')?.addEventListener('click', () => {
  const text = $('#lrc-text').value;
  if (text.trim()) loadLrcFromText(text);
  else setStatus('当前没有歌词文本可重新生成', true);
});

/* ---------------- LRC parsing ---------------- */
function parseLRC(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lines) {
    const stamps = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      stamps.push(min * 60 + sec + ms / 1000);
    }
    const content = raw.replace(re, '').trim();
    if (!stamps.length || !content) continue;
    for (const t of stamps) out.push({ time: t, text: content });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/* ---------------- Translation ---------------- */
async function translateToZh(text) {
  if (!text) return '';
  if (translationCache.has(text)) return translationCache.get(text);
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ja|zh-CN`;
    const r = await fetch(url);
    const j = await r.json();
    const zh = j?.responseData?.translatedText || '';
    translationCache.set(text, zh);
    return zh;
  } catch (e) {
    return '';
  }
}

/* ---------------- Render ---------------- */
async function renderLyrics(parsed) {
  lyricsView.innerHTML = '';
  lrcLines = [];
  activeIdx = -1;
  if (!parsed.length) {
    lyricsView.innerHTML = '<div class="hint-card"><p>未解析到歌词。</p></div>';
    return;
  }
  setStatus(`解析到 ${parsed.length} 行，正在生成假名/罗马音...`);

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const el = document.createElement('div');
    el.className = 'lrc-line';
    el.dataset.idx = i;
    el.innerHTML = `
      <div class="jp">${escapeHTML(p.text)}</div>
      <div class="romaji"></div>
      <div class="zh"></div>
    `;
    el.addEventListener('click', () => seekTo(p.time + 0.01));
    lyricsView.appendChild(el);
    lrcLines.push({ ...p, el });
  }
  applyToggleClasses();

  const autoTranslate = $('#auto-translate').checked;
  for (let i = 0; i < lrcLines.length; i++) {
    const ln = lrcLines[i];
    try {
      const { html, romaji } = await toFurigana(ln.text);
      ln.jpHTML = html;
      ln.romaji = romaji;
      ln.el.querySelector('.jp').innerHTML = html || escapeHTML(ln.text);
      ln.el.querySelector('.romaji').textContent = romaji || '';
    } catch (e) { /* ignore */ }
    if (i % 10 === 0) setStatus(`处理歌词中 ${i + 1}/${lrcLines.length}...`);
  }
  setStatus(`已就绪 ✓ 共 ${lrcLines.length} 行`);

  if (autoTranslate) {
    setStatus('正在翻译中文（受 API 速率限制，可能较慢）...');
    for (let i = 0; i < lrcLines.length; i++) {
      const ln = lrcLines[i];
      const zh = await translateToZh(ln.text);
      ln.zh = zh;
      ln.el.querySelector('.zh').textContent = zh;
      if (i % 5 === 0) setStatus(`翻译中 ${i + 1}/${lrcLines.length}...`);
    }
    setStatus('翻译完成 ✓');
  }
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ---------------- Playback abstraction (audio + YouTube + Bilibili/timer) ---------------- */
const player = {
  mode: 'audio', // 'audio' | 'yt' | 'timer'
  yt: null,
  ytReady: false,
  // timer state
  timerRunning: false,
  timerBase: 0,      // performance.now() when started
  timerOffset: 0,    // accumulated seconds when paused
  getTime() {
    if (this.mode === 'yt' && this.yt && this.ytReady) {
      try { return this.yt.getCurrentTime() || 0; } catch { return 0; }
    }
    if (this.mode === 'timer') {
      return this.timerRunning
        ? this.timerOffset + (performance.now() - this.timerBase) / 1000
        : this.timerOffset;
    }
    return audio.currentTime || 0;
  },
  seek(t) {
    if (this.mode === 'yt' && this.yt && this.ytReady) {
      try { this.yt.seekTo(t, true); this.yt.playVideo(); } catch {}
    } else if (this.mode === 'timer') {
      this.timerOffset = Math.max(0, t);
      this.timerBase = performance.now();
      // keep running state
    } else {
      audio.currentTime = t;
      audio.play().catch(() => {});
    }
  },
  // timer controls
  timerToggle() {
    if (this.mode !== 'timer') return;
    if (this.timerRunning) {
      this.timerOffset += (performance.now() - this.timerBase) / 1000;
      this.timerRunning = false;
    } else {
      this.timerBase = performance.now();
      this.timerRunning = true;
    }
    updateTimerHud();
  },
  timerReset() {
    this.timerOffset = 0;
    this.timerBase = performance.now();
    updateTimerHud();
  },
  timerNudge(delta) {
    this.timerOffset += delta;
    if (this.timerOffset < 0) this.timerOffset = 0;
    if (!this.timerRunning) updateTimerHud();
  }
};
function seekTo(t) { player.seek(t); }

/* Audio element timeupdate -> sync */
audio.addEventListener('timeupdate', () => syncHighlight(audio.currentTime));

/* YouTube / timer polling ticker */
let pollTicker = null;
function startPolling() {
  stopPolling();
  pollTicker = setInterval(() => {
    if (player.mode === 'audio') return;
    syncHighlight(player.getTime());
    if (player.mode === 'timer') updateTimerHud();
  }, 100);
}
function stopPolling() { if (pollTicker) { clearInterval(pollTicker); pollTicker = null; } }

function syncHighlight(t) {
  if (!lrcLines.length) return;
  let idx = -1;
  let lo = 0, hi = lrcLines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lrcLines[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx !== activeIdx) {
    if (activeIdx >= 0) lrcLines[activeIdx].el.classList.remove('active');
    activeIdx = idx;
    if (idx >= 0) {
      const el = lrcLines[idx].el;
      el.classList.add('active');
      const rect = el.getBoundingClientRect();
      const viewRect = lyricsView.getBoundingClientRect();
      const offset = rect.top - viewRect.top - viewRect.height / 2 + rect.height / 2;
      lyricsView.scrollBy({ top: offset, behavior: 'smooth' });
    }
  }
}

/* ---------------- File inputs ---------------- */
$('#audio-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  switchToAudioMode();
  audio.src = URL.createObjectURL(f);
  $('#audio-file-name').textContent = f.name;
  setStatus(`已加载音频: ${f.name}`);
});

$('#lrc-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('#lrc-file-name').textContent = f.name;
  const text = await f.text();
  $('#lrc-text').value = text;
  loadLrcFromText(text);
});

$('#btn-load-lrc').addEventListener('click', () => {
  const text = $('#lrc-text').value;
  if (!text.trim()) { setStatus('请先粘贴或上传 LRC 内容', true); return; }
  loadLrcFromText(text);
});

$('#btn-clear').addEventListener('click', () => {
  $('#lrc-text').value = '';
  $('#lrc-file-name').textContent = '未选择 .lrc 文件';
  lyricsView.innerHTML = '<div class="hint-card"><div class="hint-emoji">🧹</div><p>已清空。</p></div>';
  lrcLines = []; activeIdx = -1;
  setStatus('');
});

async function loadLrcFromText(text) {
  const parsed = parseLRC(text);
  if (!parsed.length) {
    setStatus('未识别到带时间戳的 LRC 行。', true);
    return;
  }
  await renderLyrics(parsed);
}

/* ---------------- Online search via lrclib.net ---------------- */
$('#btn-search').addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  setStatus('搜索中...');
  searchResults.hidden = false;
  searchResults.innerHTML = '<div style="padding:12px;color:var(--muted)">搜索中...</div>';
  try {
    const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) {
      searchResults.innerHTML = '<div style="padding:12px;color:var(--muted)">未找到结果。换个关键词试试？</div>';
      setStatus('');
      return;
    }
    searchResults.innerHTML = '';
    data.slice(0, 30).forEach(item => {
      const div = document.createElement('div');
      div.className = 'result-item';
      const synced = !!item.syncedLyrics;
      div.innerHTML = `
        <div class="title">${escapeHTML(item.trackName || '(无标题)')} ${synced ? '<span class="badge">同步</span>' : ''}</div>
        <div class="meta">${escapeHTML(item.artistName || '')} · ${escapeHTML(item.albumName || '')} · ${formatDur(item.duration)}</div>
      `;
      div.addEventListener('click', () => loadFromLrclib(item));
      searchResults.appendChild(div);
    });
    setStatus(`找到 ${data.length} 条结果，点击载入`);
  } catch (e) {
    searchResults.innerHTML = `<div style="padding:12px;color:var(--danger)">搜索失败：${escapeHTML(e.message)}</div>`;
    setStatus('搜索失败', true);
  }
}

function formatDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function loadFromLrclib(item) {
  searchResults.hidden = true;
  const lrc = item.syncedLyrics || item.plainLyrics;
  if (!lrc) { setStatus('该结果无歌词内容', true); return; }
  $('#lrc-text').value = lrc;
  setStatus(`载入：${item.trackName} - ${item.artistName}`);
  await loadLrcFromText(lrc);
}

/* ---------------- YouTube ---------------- */
function parseYouTubeId(input) {
  if (!input) return null;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).slice(0, 11);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v.slice(0, 11);
      const m = u.pathname.match(/\/(embed|shorts)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
}

function switchToAudioMode() {
  player.mode = 'audio';
  stopPolling();
  hideTimerHud();
  audio.style.display = '';
  $('#yt-wrap').hidden = true;
  $('#bili-wrap').hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  $('#bili-iframe').src = '';
}

async function switchToYouTubeMode(videoId) {
  player.mode = 'yt';
  audio.pause();
  audio.style.display = 'none';
  $('#yt-wrap').hidden = false;
  $('#bili-wrap').hidden = true;
  $('#bili-iframe').src = '';
  hideTimerHud();
  await loadYouTubeAPI();
  if (player.yt) {
    player.yt.loadVideoById(videoId);
    player.ytReady = true;
  } else {
    player.yt = new YT.Player('yt-player', {
      videoId,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => { player.ytReady = true; startPolling(); },
        onError: (e) => {
          const codes = { 2: '无效的视频 ID', 5: 'HTML5 播放器错误', 100: '视频不存在或私有',
                          101: '上传者禁止外站嵌入', 150: '上传者禁止外站嵌入', 153: '上传者禁止外站嵌入' };
          setStatus(`YouTube 错误 ${e.data}：${codes[e.data] || '未知'}。请换一首或改用 Bilibili / 计时模式。`, true);
        }
      }
    });
  }
  startPolling();
}

function switchToBilibiliMode(bvid) {
  player.mode = 'timer';
  audio.pause();
  audio.style.display = 'none';
  $('#yt-wrap').hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  $('#bili-wrap').hidden = false;
  // Use the official embed; high_quality=1, autoplay off (user starts manually to align with timer)
  $('#bili-iframe').src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&danmaku=0&autoplay=0`;
  player.timerOffset = 0;
  player.timerRunning = false;
  showTimerHud();
  startPolling();
  setStatus('Bilibili 已载入。在 B 站播放器点播放的同时，点 ▶ 启动计时即可同步歌词。');
}

function switchToTimerMode() {
  player.mode = 'timer';
  audio.pause();
  audio.style.display = 'none';
  $('#yt-wrap').hidden = true;
  $('#bili-wrap').hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  $('#bili-iframe').src = '';
  player.timerOffset = 0;
  player.timerRunning = false;
  showTimerHud();
  startPolling();
  setStatus('计时模式：在外部播放器开始的同时点 ▶ 启动。');
}

/* ---------------- Timer HUD ---------------- */
const hud = $('#timer-hud');
const hudDisplay = $('#timer-display');
const hudToggle = $('#hud-toggle');
function showTimerHud() { hud.hidden = false; updateTimerHud(); }
function hideTimerHud() { hud.hidden = true; hud.classList.remove('running'); }
function updateTimerHud() {
  const t = player.getTime();
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  hudDisplay.textContent = `${String(m).padStart(2, '0')}:${s}`;
  hud.classList.toggle('running', player.timerRunning);
  hudToggle.textContent = player.timerRunning ? '⏸' : '▶';
}
hudToggle.addEventListener('click', () => player.timerToggle());
$('#hud-back').addEventListener('click', () => player.timerNudge(-0.5));
$('#hud-fwd').addEventListener('click', () => player.timerNudge(+0.5));
$('#btn-timer-start').addEventListener('click', () => {
  if (player.mode !== 'timer') switchToTimerMode();
  player.timerToggle();
});
$('#btn-timer-reset').addEventListener('click', () => {
  if (player.mode !== 'timer') switchToTimerMode();
  player.timerReset();
});
$('#btn-timer-back').addEventListener('click', () => player.timerNudge(-0.5));
$('#btn-timer-fwd').addEventListener('click', () => player.timerNudge(+0.5));
// Spacebar to toggle in timer mode
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && player.mode === 'timer' &&
      !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    player.timerToggle();
  }
});

$('#btn-load-yt').addEventListener('click', async () => {
  const id = parseYouTubeId($('#yt-url').value);
  if (!id) { setStatus('无法识别 YouTube 链接或 ID', true); return; }
  setStatus(`载入 YouTube：${id}`);
  await switchToYouTubeMode(id);
});

/* ---------------- Bilibili ---------------- */
function parseBilibiliId(input) {
  if (!input) return null;
  const s = input.trim();
  // direct BV
  const bv = s.match(/BV[\w]{10}/);
  if (bv) return bv[0];
  // av number -> we still embed via aid by converting to BV is complex; bilibili player accepts aid via &aid=
  return null;
}

$('#btn-load-bili').addEventListener('click', () => {
  const bvid = parseBilibiliId($('#bili-url').value);
  if (!bvid) { setStatus('无法识别 B 站链接（需包含 BVxxxxxxxxxx）', true); return; }
  switchToBilibiliMode(bvid);
});

/* ---------------- Init: warm up kuroshiro on first interaction ---------------- */
let warmed = false;
const warm = () => {
  if (warmed) return;
  warmed = true;
  ensureKuroshiro().catch(err => setStatus('分词器加载失败: ' + err.message, true));
};
document.addEventListener('click', warm, { once: true });
document.addEventListener('touchstart', warm, { once: true, passive: true });
