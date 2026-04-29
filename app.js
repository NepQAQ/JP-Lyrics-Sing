/* 日语跟唱 App - main logic */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const audio = $('#audio');
const lyricsView = $('#lyrics-view');
const statusEl = $('#status');
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const biliWrap = $('#bili-wrap');
let searchRequestId = 0;
let biliSearchRequestId = 0;

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

/* ---------------- Display Mode (sing-along vs read) ---------------- */
const MODE_KEY = 'jplrc-mode';
function applyMode(mode) {
  document.body.classList.toggle('mode-read', mode === 'read');
  const btn = $('#btn-mode');
  if (btn) {
    btn.querySelector('.mode-icon').textContent = mode === 'read' ? '📖' : '🎤';
    btn.querySelector('.mode-text').textContent = mode === 'read' ? '阅读' : '跟唱';
    btn.title = mode === 'read' ? '当前：阅读模式 · 点击切回跟唱' : '当前：跟唱模式 · 点击切到阅读';
  }
  localStorage.setItem(MODE_KEY, mode);
}
applyMode(localStorage.getItem(MODE_KEY) || 'sing');
$('#btn-mode')?.addEventListener('click', () => {
  const next = document.body.classList.contains('mode-read') ? 'sing' : 'read';
  applyMode(next);
});

/* Show/hide player bar based on whether any audio source is active. */
function setPlayerVisible(visible) {
  document.body.classList.toggle('no-player', !visible);
}
setPlayerVisible(false); // default: no source

/* ---------------- UI helpers ---------------- */
function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

function setPanelCollapsed(collapsed) {
  $('#panel').classList.toggle('hidden', collapsed);
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
  setPanelCollapsed(!$('#panel').classList.contains('hidden'));
});

/* ---------------- Tabs ---------------- */
function activateSourceTab(target) {
  $$('.source-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === target));
}

$$('.source-tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activateSourceTab(btn.dataset.tab);
  });
});

/* Sub-tabs (inside a main tab pane, e.g. 本地 -> 音频/LRC) */
$$('.sub-tabs').forEach(group => {
  const tabs = group.querySelectorAll('.sub-tab');
  // Sub-panes are siblings of the .sub-tabs container, sharing its parent.
  const scope = group.parentElement;
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.subtab;
      tabs.forEach(b => b.classList.toggle('active', b === btn));
      scope.querySelectorAll(':scope > .sub-pane').forEach(p =>
        p.classList.toggle('active', p.dataset.subpane === target)
      );
    });
  });
});

/* ---------------- Kuroshiro ---------------- */
// Multiple CDN candidates; we try them in order. unpkg sometimes fails on HTTPS
// because dict .gz files get served with the wrong MIME and the request hangs
// without rejecting, which would freeze the whole UI. jsDelivr is more reliable.
const DICT_CDNS = [
  'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/',
  'https://fastly.jsdelivr.net/npm/kuromoji@0.1.2/dict/',
  'https://unpkg.com/kuromoji@0.1.2/dict/',
];
const DICT_TIMEOUT_MS = 25000;
let kuroshiroFailed = false;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时 (${ms / 1000}s)`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

async function tryInitKuroshiro(dictPath) {
  const k = new Kuroshiro.default();
  const analyzer = new KuromojiAnalyzer({ dictPath });
  await withTimeout(k.init(analyzer), DICT_TIMEOUT_MS, '词典加载');
  return k;
}

async function ensureKuroshiro() {
  if (kuroshiro) return kuroshiro;
  if (kuroshiroFailed) throw new Error('分词器之前加载失败，请重试');
  if (kuroshiroReady) return kuroshiroReady;

  kuroshiroReady = (async () => {
    let lastErr;
    for (let i = 0; i < DICT_CDNS.length; i++) {
      const cdn = DICT_CDNS[i];
      setStatus(`正在加载日语分词器 (${i + 1}/${DICT_CDNS.length}) ...`);
      try {
        const k = await tryInitKuroshiro(cdn);
        kuroshiro = k;
        setStatus('分词器已就绪 ✓');
        return k;
      } catch (e) {
        lastErr = e;
        console.warn('[kuroshiro] CDN failed:', cdn, e);
      }
    }
    kuroshiroFailed = true;
    kuroshiroReady = null; // allow retry on next call
    throw lastErr || new Error('所有 CDN 均失败');
  })();

  return kuroshiroReady;
}

async function toFurigana(text) {
  if (!text || !text.trim()) return { html: '', romaji: '' };
  // Always honor the manual overrides first (works even without kuroshiro).
  const segments = splitByOverrides(text);
  let k;
  try {
    k = await ensureKuroshiro();
  } catch (e) {
    // Fall back: render plain text + override pieces only, never block the UI.
    let html = '', romajiParts = [];
    for (const seg of segments) {
      if (seg.type === 'override') {
        html += `<ruby>${escapeHTML(seg.kanji)}<rt>${escapeHTML(seg.kana)}</rt></ruby>`;
        romajiParts.push(seg.romaji);
      } else {
        html += escapeHTML(seg.text);
      }
    }
    return { html, romaji: romajiParts.join(' ').trim() };
  }
  let html = '', romajiParts = [];
  for (const seg of segments) {
    if (seg.type === 'override') {
      html += `<ruby>${escapeHTML(seg.kanji)}<rt>${escapeHTML(seg.kana)}</rt></ruby>`;
      if (seg.romaji) romajiParts.push(seg.romaji);
    } else {
      const t = seg.text;
      if (!t) continue;
      // furigana html
      let h = '';
      try {
        h = await k.convert(t, { to: 'hiragana', mode: 'furigana' });
      } catch (e) {
        console.warn('[furigana] convert failed:', e);
      }
      html += h || escapeHTML(t);
      // romaji — try spaced first, fall back to normal mode, then to a kana-based map.
      let r = '';
      try {
        r = await k.convert(t, { to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn' });
      } catch (e) {
        console.warn('[romaji spaced] failed:', e);
      }
      if (!r || !r.trim()) {
        try {
          r = await k.convert(t, { to: 'romaji', mode: 'normal', romajiSystem: 'hepburn' });
        } catch (e) {
          console.warn('[romaji normal] failed:', e);
        }
      }
      if (!r || !r.trim()) {
        // Final fallback: convert to hiragana then map to romaji manually.
        try {
          const hira = await k.convert(t, { to: 'hiragana', mode: 'normal' });
          r = kanaToRomajiSimple(hira);
        } catch {}
      }
      if (r && r.trim()) romajiParts.push(r.trim());
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
function setOverridesPopoverOpen(open) {
  const popover = $('#overrides-popover');
  const btn = $('#btn-overrides-panel');
  if (!popover || !btn) return;
  popover.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) $('#overrides-text')?.focus();
}

$('#btn-overrides-panel')?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const popover = $('#overrides-popover');
  setOverridesPopoverOpen(popover?.hidden !== false);
});
$('#btn-close-overrides')?.addEventListener('click', () => setOverridesPopoverOpen(false));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') setOverridesPopoverOpen(false);
});
document.addEventListener('click', (ev) => {
  const popover = $('#overrides-popover');
  if (!popover || popover.hidden) return;
  if (popover.contains(ev.target) || $('#btn-overrides-panel')?.contains(ev.target)) return;
  setOverridesPopoverOpen(false);
});
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

  const topSpacer = document.createElement('div');
  topSpacer.className = 'lrc-spacer lrc-spacer-top';
  lyricsView.appendChild(topSpacer);

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

  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'lrc-spacer lrc-spacer-bottom';
  lyricsView.appendChild(bottomSpacer);

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
      setPanelCollapsed(true);
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
let lastAutoCenterAt = 0;
function startPolling() {
  stopPolling();
  pollTicker = setInterval(() => {
    if (player.mode === 'audio') return;
    syncHighlight(player.getTime());
    if (player.mode === 'timer') updateTimerHud();
  }, 100);
}
function stopPolling() { if (pollTicker) { clearInterval(pollTicker); pollTicker = null; } }

function isPlaybackActive() {
  if (player.mode === 'timer') return player.timerRunning;
  if (player.mode === 'audio') return !audio.paused && !audio.ended;
  return false;
}

function shouldCenterLyrics() {
  return !document.body.classList.contains('mode-read') && isPlaybackActive();
}

function getLyricFocusRatio() {
  return 0.38;
}

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
      if (shouldCenterLyrics()) centerActiveLyric(el);
    }
  } else if (idx >= 0 && shouldCenterLyrics()) {
    const now = performance.now();
    if (now - lastAutoCenterAt > 650) centerActiveLyric(lrcLines[idx].el);
  }
}

function centerActiveLyric(el, behavior = 'auto') {
  lastAutoCenterAt = performance.now();
  const rect = el.getBoundingClientRect();
  const viewRect = lyricsView.getBoundingClientRect();
  const targetY = viewRect.height * getLyricFocusRatio();
  const offset = rect.top - viewRect.top - targetY + rect.height / 2;
  const nextTop = Math.max(0, Math.min(
    lyricsView.scrollHeight - lyricsView.clientHeight,
    lyricsView.scrollTop + offset
  ));
  if (behavior === 'smooth') {
    lyricsView.scrollTo({ top: nextTop, behavior });
  } else {
    lyricsView.scrollTop = nextTop;
  }
}

audio.addEventListener('play', () => {
  setPanelCollapsed(true);
  syncHighlight(audio.currentTime);
});

/* ---------------- File inputs ---------------- */
$('#audio-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  switchToAudioMode();
  audio.src = URL.createObjectURL(f);
  $('#audio-file-name').textContent = f.name;
  setPlayerVisible(true);
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
  const requestId = ++searchRequestId;
  setStatus('搜索中...');
  searchResults.hidden = false;
  searchResults.innerHTML = '<div style="padding:12px;color:var(--muted)">搜索中...</div>';

  // Run lrclib only; UtaTen is opened directly on the official site because
  // cross-origin proxy solutions have become unreliable in the browser.
  const lrclibPromise = fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .catch(e => { console.warn('[lrclib]', e); return { __error: e.message }; });
  let data;
  try {
    data = await lrclibPromise;
  } catch (e) {
    if (requestId !== searchRequestId) return;
    searchResults.innerHTML = `<div style="padding:12px;color:var(--danger)">搜索失败：${escapeHTML(e.message)}</div>`;
    setStatus('搜索失败', true);
    return;
  }

  const lrcList = Array.isArray(data) ? data : [];
  if (requestId !== searchRequestId) return;

  searchResults.innerHTML = '';

  if (!lrcList.length) {
    const empty = document.createElement('div');
    empty.style.padding = '12px';
    empty.style.color = 'var(--muted)';
    empty.textContent = '未找到歌词。换个关键词试试？';
    searchResults.appendChild(empty);
  } else {
    const head = document.createElement('div');
    head.className = 'search-section-head';
    head.textContent = '歌词结果';
    searchResults.appendChild(head);

    lrcList.slice(0, 16).forEach(item => {
      const div = document.createElement('div');
      div.className = 'result-item';
      const synced = !!item.syncedLyrics;
      div.innerHTML = `
        <div class="title">${escapeHTML(item.trackName || '(无标题)')} ${synced ? '<span class="badge">同步</span>' : ''}</div>
        <div class="meta">${escapeHTML(item.artistName || '')} · ${escapeHTML(item.albumName || '')} · ${formatDur(item.duration)}</div>
        <div class="row-actions">
          <button class="btn-mini" data-act="utaten">🎼 UtaTen</button>
        </div>
      `;
      // Click on body (excluding action buttons) loads lyrics
      div.addEventListener('click', (ev) => {
        if (ev.target.closest('.row-actions')) return;
        loadFromLrclib(item);
      });
      const utaBtn = div.querySelector('[data-act="utaten"]');
      utaBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openUtatenSearchForItem(item);
      });
      searchResults.appendChild(div);
    });
  }

  setStatus(lrcList.length ? `找到 ${lrcList.length} 条歌词` : '未找到歌词');
}

function setBiliSearchPopoverOpen(open) {
  const popover = $('#bili-search-popover');
  if (!popover) return;
  popover.hidden = !open;
}

function renderBiliSearchResults(items, query) {
  const list = $('#bili-search-results');
  if (!list) return;
  list.innerHTML = '';
  if (Array.isArray(items) && items.length) {
    const sec = document.createElement('div');
    sec.className = 'bili-section';
    sec.innerHTML = `<div class="utaten-head">📺 ${escapeHTML(query)} 的 Bilibili 候选视频</div>`;
    items.slice(0, 12).forEach(it => {
      const div = document.createElement('div');
      div.className = 'result-item bili-result';
      div.innerHTML = `
        ${it.cover ? `<img class="bili-cover" src="${escapeHTML(it.cover)}" alt="" loading="lazy" />` : '<div class="bili-cover bili-cover-empty">BV</div>'}
        <div class="bili-info">
          <div class="title">${escapeHTML(it.title)} <span class="badge">BV</span></div>
          <div class="meta">${escapeHTML([it.author, it.duration, it.bvid].filter(Boolean).join(' · '))}</div>
        </div>
      `;
      div.addEventListener('click', () => {
        selectBilibiliSearchResult(it);
        setBiliSearchPopoverOpen(false);
      });
      sec.appendChild(div);
    });
    list.appendChild(sec);
    return;
  }
  const empty = document.createElement('div');
  empty.style.padding = '12px';
  empty.style.color = 'var(--muted)';
  empty.textContent = '没有找到可用的 B 站视频结果。';
  list.appendChild(empty);
}

async function openBilibiliSearchPopoverForLyric(item) {
  const list = $('#bili-search-results');
  const subtitle = $('#bili-search-subtitle');
  if (!list || !subtitle) return;
  const query = `${item.trackName || ''} ${item.artistName || ''}`.trim() || item.trackName || item.artistName || '';
  const requestId = ++biliSearchRequestId;
  subtitle.textContent = query || '为当前歌词选择 B 站音源';
  setBiliSearchPopoverOpen(true);
  list.innerHTML = '<div style="padding:12px;color:var(--muted)">正在搜索 Bilibili 视频...</div>';
  const items = await searchBilibiliVideos(query);
  if (requestId !== biliSearchRequestId) return;
  if (Array.isArray(items) && items.length) {
    renderBiliSearchResults(items, query);
    setStatus(`歌词已载入 · 找到 ${items.length} 条 B 站候选视频`);
  } else {
    list.innerHTML = `<div style="padding:12px;color:var(--muted)">Bilibili 搜索暂不可用${items?.__error ? `：${escapeHTML(items.__error)}` : ''}</div>`;
    setStatus('歌词已载入；Bilibili 搜索暂不可用', true);
  }
}

function selectBilibiliSearchResult(item) {
  const bvid = parseBilibiliId(item?.bvid || '');
  if (!bvid) {
    setStatus('选中的 B 站结果没有可用 BV 号', true);
    return;
  }
  $('#bili-url').value = bvid;
  activateSourceTab('bilibili');
  switchToBilibiliMode(bvid);
  searchResults.hidden = true;
  setStatus(`已选择 B 站视频：${item?.title || bvid} · ${bvid}`);
}

async function searchBilibiliVideos(query) {
  let lastError = null;
  try {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}`;
    const apiItems = await fetchBilibiliApiItems(url);
    if (apiItems.length) return apiItems;
  } catch (e) {
    console.warn('[bilibili]', e);
    lastError = e;
  }
  try {
    const htmlItems = await searchBilibiliViaAllOrigins(query);
    if (htmlItems.length) return htmlItems;
  } catch (e) {
    console.warn('[bilibili html]', e);
    lastError = e;
  }
  try {
    const fallback = await searchBilibiliViaReader(query);
    if (fallback.length) return fallback;
  } catch (e) {
    console.warn('[bilibili reader]', e);
    lastError = e;
  }
  return { __error: lastError?.message || '没有返回视频结果' };
}

async function fetchBilibiliApiItems(url) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('网络错误 ' + r.status);
  const data = await r.json();
  const list = Array.isArray(data?.data?.result) ? data.data.result : [];
  return list
    .filter(item => item.bvid)
    .map(item => ({
      bvid: item.bvid,
      title: stripHTML(item.title || item.bvid),
      author: stripHTML(item.author || ''),
      duration: item.duration || '',
      cover: normalizeBiliCover(item.pic || ''),
    }));
}

async function searchBilibiliViaReader(query) {
  const searchUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`;
  const r = await fetch('https://r.jina.ai/' + searchUrl, {
    headers: { 'Accept': 'text/plain' }
  });
  if (!r.ok) throw new Error('网页读取失败 ' + r.status);
  const text = await r.text();
  return parseBilibiliReaderResults(text);
}

async function searchBilibiliViaAllOrigins(query) {
  const searchUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`;
  const r = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(searchUrl));
  if (!r.ok) throw new Error('网页代理失败 ' + r.status);
  const html = await r.text();
  return parseBilibiliHtmlResults(html);
}

function parseBilibiliHtmlResults(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  const seen = new Set();
  doc.querySelectorAll('a[href*="/video/BV"]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const bv = href.match(/BV[\w]{10}/)?.[0];
    if (!bv || seen.has(bv)) return;
    const card = a.closest('li, .video-list-item, .bili-video-card, .video-item') || a.parentElement;
    const img = card?.querySelector('img') || a.querySelector('img');
    const title = stripHTML(a.getAttribute('title') || a.textContent || bv).replace(/\s+/g, ' ').trim();
    let author = '';
    const authorEl = card?.querySelector('a[href*="space.bilibili.com"], .up-name, .bili-video-card__info--author');
    if (authorEl) author = stripHTML(authorEl.textContent || '').replace(/\s+/g, ' ').trim();
    let cover = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
    if (!cover) {
      const raw = card?.innerHTML || '';
      cover = raw.match(/https?:\\?\/\\?\/[^"'<>]+?\.(?:jpg|jpeg|png|webp)[^"'<>]*/i)?.[0] || '';
    }
    seen.add(bv);
    out.push({ bvid: bv, title: title || bv, author, duration: '', cover: normalizeBiliCover(cover.replace(/\\\//g, '/')) });
  });
  return out.slice(0, 12);
}

function parseBilibiliReaderResults(text) {
  const out = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  let recentCover = '';
  const imageRe = /!\[[^\]]*\]\(([^)]+(?:hdslb|bili)[^)]*)\)/i;
  const videoRe = /\[([^\]\n]{2,120})\]\((https?:\/\/www\.bilibili\.com\/video\/(BV[\w]{10})[^)]*)\)/i;
  for (const line of lines) {
    const img = line.match(imageRe);
    if (img) recentCover = normalizeBiliCover(img[1]);
    const video = line.match(videoRe);
    if (!video) continue;
    const [, rawTitle, , bvid] = video;
    if (seen.has(bvid)) continue;
    seen.add(bvid);
    out.push({
      bvid,
      title: stripHTML(rawTitle).replace(/\s+/g, ' ').trim() || bvid,
      author: '',
      duration: '',
      cover: recentCover,
    });
    if (out.length >= 12) break;
  }
  return out;
}

function stripHTML(s) {
  const div = document.createElement('div');
  div.innerHTML = s;
  return div.textContent || div.innerText || '';
}

function normalizeBiliCover(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return url.replace(/^http:\/\//, 'https://');
  return url;
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
  openBilibiliSearchPopoverForLyric(item);
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
  const yw = $('#yt-wrap'); if (yw) yw.hidden = true;
  biliWrap.hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  $('#bili-iframe').src = '';
  // Only show player bar if an audio file is actually loaded
  setPlayerVisible(!!audio.src);
}

async function switchToYouTubeMode(videoId) {
  player.mode = 'yt';
  audio.pause();
  audio.style.display = 'none';
  const yw = $('#yt-wrap'); if (yw) yw.hidden = false;
  biliWrap.hidden = true;
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
  const yw = $('#yt-wrap'); if (yw) yw.hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  biliWrap.hidden = false;
  setBiliPlayerCollapsed(localStorage.getItem('jplrc-bili-collapsed') !== '0');
  // Use the official embed; high_quality=1, autoplay off (user starts manually to align with timer)
  $('#bili-iframe').src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&danmaku=0&autoplay=0`;
  player.timerOffset = 0;
  player.timerRunning = false;
  showTimerHud();
  setPlayerVisible(true);
  startPolling();
  setStatus('Bilibili 已载入。在 B 站播放器点播放的同时，点 ▶ 启动计时即可同步歌词。');
}

function switchToTimerMode() {
  player.mode = 'timer';
  audio.pause();
  audio.style.display = 'none';
  const yw = $('#yt-wrap'); if (yw) yw.hidden = true;
  biliWrap.hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  $('#bili-iframe').src = '';
  player.timerOffset = 0;
  player.timerRunning = false;
  showTimerHud();
  setPlayerVisible(false);  // timer mode doesn't need the audio bar
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

function setBiliPlayerCollapsed(collapsed) {
  biliWrap.classList.toggle('bili-collapsed', collapsed);
  const btn = $('#btn-toggle-bili-player');
  if (btn) {
    btn.textContent = collapsed ? '展开' : '收起';
    btn.setAttribute('aria-expanded', String(!collapsed));
  }
  localStorage.setItem('jplrc-bili-collapsed', collapsed ? '1' : '0');
}

$('#btn-toggle-bili-player')?.addEventListener('click', () => {
  setBiliPlayerCollapsed(!biliWrap.classList.contains('bili-collapsed'));
});

// Spacebar to toggle in timer mode
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && player.mode === 'timer' &&
      !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    player.timerToggle();
  }
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

$('#btn-close-bili-search')?.addEventListener('click', () => setBiliSearchPopoverOpen(false));
$('#btn-skip-bili-search')?.addEventListener('click', () => setBiliSearchPopoverOpen(false));

/* ---------------- UtaTen (official-site fallback) ---------------- */
function utatenBuildSearchUrl(query, artist = '') {
  const u = new URL('https://utaten.com/search');
  if (query) u.searchParams.set('title', query);
  if (artist) u.searchParams.set('artist_name', artist);
  return u.toString();
}

function utatenBuildLyricUrl(id) {
  return `https://utaten.com/lyric/${encodeURIComponent(id)}/`;
}

function openExternalUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function openUtatenSearchForItem(item) {
  const title = item?.trackName || '';
  const artist = item?.artistName || '';
  const url = utatenBuildSearchUrl(title, artist);
  openExternalUrl(url);
  setStatus('已打开 UtaTen 原站搜索页。当前浏览器环境下跨域抓取不稳定，改为直达原站查看注音。');
}

const RE_KANJI = /[\u3400-\u9fff々ヶ]/;

function utatenParseSearch(text) {
  // Real HTML path (in case the proxy ever returns HTML again).
  if (/<a\s+href=/i.test(text)) {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const out = [];
      const seen = new Set();
      doc.querySelectorAll('a[href*="/lyric/"]').forEach(a => {
        const m = a.getAttribute('href').match(/\/lyric\/([\w-]+)\//);
        if (!m) return;
        const id = m[1];
        if (seen.has(id)) return;
        const title = (a.textContent || '').trim();
        if (!title || title.length > 80) return;
        const row = a.closest('tr');
        let artist = '';
        if (row) {
          const aArtist = row.querySelector('a[href*="/artist/"]');
          if (aArtist) artist = aArtist.textContent.trim();
        }
        seen.add(id);
        out.push({ id, title, artist });
      });
      if (out.length) return out.slice(0, 30);
    } catch {}
  }
  // Markdown fallback. Only count entries whose lyric link is followed by an
  // artist link nearby — this filters out sidebar "おすすめ" rows.
  const out = [];
  const seen = new Set();
  const re = /\[([^\]\n]{1,80})\]\(https:\/\/utaten\.com\/lyric\/([\w-]+)\/\)\s*(?:\||\s)*\s*\[([^\]\n]{1,80})\]\(https:\/\/utaten\.com\/artist\/[\w%-]+\/?\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, title, id, artist] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: title.trim(), artist: artist.trim() });
    if (out.length >= 30) break;
  }
  return out;
}

function utatenParseLyric(text) {
  // 1) HTML path (legacy).
  if (/<span\s+class=["']ruby["']/i.test(text)) {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const body = doc.querySelector('.hiragana') || doc.querySelector('.romaji') || doc.querySelector('.lyricBody .medium');
      if (body) {
        const pairs = {};
        body.querySelectorAll('span.ruby').forEach(sp => {
          const rb = sp.querySelector('.rb')?.textContent.trim();
          const rt = sp.querySelector('.rt')?.textContent.trim();
          if (rb && rt && RE_KANJI.test(rb) && !pairs[rb]) pairs[rb] = rt;
        });
        const clone = body.cloneNode(true);
        clone.querySelectorAll('span.ruby').forEach(sp => {
          const rb = sp.querySelector('.rb')?.textContent || '';
          sp.replaceWith(document.createTextNode(rb));
        });
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        const lines = clone.textContent.replace(/\u00a0/g, ' ')
          .split(/\n+/).map(s => s.trim()).filter(Boolean);
        if (Object.keys(pairs).length) return { lines, pairs };
      }
    } catch {}
  }

  // 2) Markdown fallback. UtaTen renders furigana inline as `汉字 假名`.
  // Slice out only the furigana section to avoid the romaji repeat (which uses
  // latin letters as the reading marker, e.g. `沈 shizu むように`) and unrelated
  // navigation/footer text.
  let body = text;
  const startMatches = [
    /文字サイズ\s+ふりがな\s+ダークモード/,
    /ふりがな\s+ダークモード/,
    /## .*?歌詞\s*\n/,
  ];
  for (const re of startMatches) {
    const m = body.match(re);
    if (m) { body = body.slice(m.index + m[0].length); break; }
  }
  const endMatches = [
    /\[この歌詞へのご意見\]/,
    /\[みんなのレビュー/,
    /## .*?の人気歌詞ランキング/,
    /の特集を全て見る/,
  ];
  for (const re of endMatches) {
    const m = body.match(re);
    if (m) { body = body.slice(0, m.index); break; }
  }

  // Extract `汉字+ 空白 假名+` pairs.
  const pairs = {};
  const pairRe = /([\u3400-\u9fff々ヶ]+)[ \t\u3000]+([\u3041-\u3096ー]+)/g;
  let m;
  while ((m = pairRe.exec(body)) !== null) {
    const kanji = m[1], kana = m[2];
    if (kana.length > 10) continue; // sanity
    if (!pairs[kanji]) pairs[kanji] = kana;
  }

  // Best-effort lyric line extraction: drop the kana annotations to recover
  // kanji-only text, then split on line breaks.
  const stripped = body
    .replace(pairRe, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[ \t]+/g, ' ');
  const lines = stripped.split(/\n+/)
    .map(s => s.trim())
    .filter(s => s && s.length < 80
      && /[\u3041-\u309f\u30a0-\u30ff\u3400-\u9fff]/.test(s));

  return { lines, pairs };
}

function mergeOverridesFromPairs(pairs) {
  let added = 0;
  for (const [k, v] of Object.entries(pairs)) {
    if (userOverrides[k]) continue; // respect user-set entries
    userOverrides[k] = { kana: v, romaji: kanaToRomajiSimple(v) };
    added++;
  }
  saveOverrides();
  renderOverridesTextarea();
  return added;
}

async function utatenSearch() {
  const q = $('#utaten-q').value.trim();
  if (!q) return;
  openExternalUrl(utatenBuildSearchUrl(q));
  setStatus('已打开 UtaTen 原站搜索页。');
}

async function loadFromUtaten(item) {
  openExternalUrl(utatenBuildLyricUrl(item.id));
  setStatus(`已打开 UtaTen 歌词页：${item.title}。原站页面自带注音，可直接查看。`);
}

/* ---------------- Init: warm up kuroshiro on first interaction ---------------- */
let warmed = false;
const warm = () => {
  if (warmed) return;
  warmed = true;
  ensureKuroshiro().catch(err => {
    setStatus('分词器加载失败：' + err.message + ' · 点击页面任意位置重试', true);
    // allow retry on next user interaction
    warmed = false;
    kuroshiroFailed = false;
  });
};
document.addEventListener('click', warm, { once: false });
document.addEventListener('touchstart', warm, { once: false, passive: true });
