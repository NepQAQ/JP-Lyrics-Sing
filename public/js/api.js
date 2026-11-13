// 客户端数据层（无后端）：
//   设置 → localStorage；歌曲 / 编辑历史 / 快照 / 音频 / 词典 → IndexedDB（音频以 Blob 存储）
//   在线歌词源 → 浏览器直连（LRCLIB / PetitLyrics / MyMemory 翻译）
//               + Cloudflare Worker 代理（网易云 / Marumaru，路由见 worker/src/index.js）
// 接口签名与衍生版 jp-lyrics-studio 的 server/app.py 保持一致，前端模块无需感知存储差异。
import { cleanLine } from './state.js';
import { sleep, downloadText, bus } from './util.js';
import { buildVocab } from './vocab-core.js';

// =============================================================== 常量
const SETTINGS_KEY = 'jls-settings';
const DB_NAME = 'jp-lyrics-studio';
const DB_VERSION = 1;

const DEFAULT_SETTINGS = {
  theme: 'auto',            // auto | light | dark | mint | sand | sakura | sky | lavender
  viewMode: 'sing',         // sing（跟唱，高亮当前句并居中） | read（阅读平铺）
  layout: 'stack',          // stack（原文/罗马音/中文分行） | inline（逐词对照）
  wordStyle: 'box',         // none | box（边框） | tint（交替底色） | underline
  wordStyleLongOnly: false, // 仅对长句启用单词样式
  longLineChars: 14,
  showFurigana: true,
  showRomaji: true,
  showZh: true,
  kanaScript: 'hiragana',   // 注音显示：hiragana | katakana
  playbackRate: 1.0,
  preservePitch: true,
  applySameLines: true,     // 编辑一行时同步到本曲相同歌词行
  voice: 'cn-default',
  fontScale: 1.0,
  // 同步 / 单句播放
  estimateSungEnd: true,    // 无逐字时间轴时按假名音拍估算句尾
  segLead: 0.15,            // 单句播放提前开始（秒）
  segTrim: 0.2,             // 单句播放在下一句开始前提前结束（秒）
  autoWordTiming: true,     // 打开没有逐字时间轴的歌曲时自动获取
  cloudSync: true,          // 登录后启用云同步（本地变更防抖推送）
  songOrder: [],            // 曲库手动排序（歌曲 id 列表；随设置云同步）
  vocabNotes: {},           // 单词本笔记（按词面：{meaning, source, note, starred}；随设置云同步）
};

const SONG_FIELDS = new Set(['title', 'artist', 'album', 'offset', 'timeline', 'duration', 'syncInfo']);
const LINE_FIELDS = new Set(['time', 'end', 'text', 'zh', 'words', 'wordsEdited', 'romaji', 'ruby', 'wordTiming']);

const EXT_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', webm: 'audio/webm',
};
const AUDIO_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm', 'audio/opus': 'opus',
};

// =============================================================== 小工具
const now = () => Date.now();

function hex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function deepClone(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch { /* 含不可克隆值时回退 JSON */ }
  }
  return JSON.parse(JSON.stringify(v));
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function dateStamp() { // %y%m%d
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear() % 100).padStart(2, '0')}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function fullStamp() { // %Y%m%d%H%M%S
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 与衍生版 server/app.py 的 _norm 一致（用于替换歌词时的原文匹配）
function normKey(s) {
  return String(s || '').replace(/[\s　「」『』“”"'’‘.,，。！？!?…・･♪\-－—–~〜]+/g, '').toLowerCase();
}

function looksJapanese(s) {
  return /[぀-ヿ]/.test(s || '');
}

function guessMetaFromFilename(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '').trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(stem);
  if (m) return { title: m[2].trim(), artist: m[1].trim() }; // 「歌手 - 歌名」
  return { title: stem, artist: '' };
}

// 多编码文本解码（与衍生版 _decode_text 对齐：BOM → utf-8 → gb18030 → shift_jis）
async function decodeTextFile(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  if (raw[0] === 0xff && raw[1] === 0xfe) return new TextDecoder('utf-16le').decode(raw);
  if (raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder('utf-16be').decode(raw);
  for (const enc of ['utf-8', 'gb18030', 'shift_jis']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(raw).replace(/^\uFEFF/, '');
    } catch { /* 尝试下一种编码 */ }
  }
  return new TextDecoder('utf-8').decode(raw);
}

// =============================================================== LRC（移植自衍生版 server/lrc.py）
const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[(ti|ar|al|by|offset|length|re|ve|au):(.*)\]\s*$/i;

function newLineId() {
  return 'l_' + hex(4);
}

function makeLine(time, text, extra) {
  const line = {
    id: newLineId(),
    time: Math.round(Number(time) * 1000) / 1000,
    end: null,
    text: String(text),
    zh: '',
    words: null,
    wordsEdited: false,
    romaji: null,
    ruby: null,
    wordTiming: null,
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) line[k] = v;
    }
  }
  return line;
}

export function parseLrc(text) {
  const meta = {};
  const rawLines = String(text || '').replace(/\uFEFF/g, '').split(/\r\n|\n|\r/);
  const out = [];
  const boundaries = [];
  let offsetMs = 0;
  let hasTags = false;

  for (const raw of rawLines) {
    const m = META_RE.exec(raw.trim());
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'offset') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) offsetMs = n;
      } else {
        meta[key] = val;
      }
      continue;
    }
    const stamps = [];
    TAG_RE.lastIndex = 0;
    let tm;
    while ((tm = TAG_RE.exec(raw)) !== null) {
      const mi = parseInt(tm[1], 10);
      const se = parseInt(tm[2], 10);
      const frac = tm[3];
      const ms = frac ? parseInt(frac.padEnd(3, '0').slice(0, 3), 10) : 0;
      if (se < 60) stamps.push(mi * 60 + se + ms / 1000);
    }
    if (stamps.length) hasTags = true;
    const content = raw.replace(TAG_RE, '').trim();
    boundaries.push(...stamps);
    if (!stamps.length || !content) continue;
    for (const t of stamps) {
      out.push({ time: Math.max(0, t - offsetMs / 1000), text: content });
    }
  }

  if (!hasTags) {
    // 纯文本歌词：每行 4 秒的估算时间轴
    const plain = rawLines.filter((ln) => ln.trim() && !META_RE.test(ln.trim())).map((ln) => ln.trim());
    const lines = plain.map((t, i) => makeLine(i * 4, t));
    for (let i = 0; i < lines.length; i++) {
      lines[i].end = i + 1 < lines.length ? lines[i + 1].time : lines[i].time + 4;
    }
    return { lines, meta, timeline: 'synthetic' };
  }

  out.sort((a, b) => a.time - b.time);
  // 双语 LRC：同一时间戳的第二行视为翻译
  const merged = [];
  for (const item of out) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.time - item.time) < 1e-6 && !last.zh) {
      if (looksJapanese(last.text) && !looksJapanese(item.text)) {
        last.zh = item.text;
        continue;
      }
    }
    merged.push(item);
  }

  const uniq = [...new Set(boundaries.map((b) => Math.round((b - offsetMs / 1000) * 1000) / 1000))].sort((a, b) => a - b);
  const lines = [];
  for (const item of merged) {
    const ln = makeLine(item.time, item.text, { zh: item.zh || '' });
    ln.end = uniq.find((b) => b > ln.time + 1e-6) ?? null;
    lines.push(ln);
  }
  return { lines, meta, timeline: 'synced' };
}

export function recomputeEnds(lines) {
  lines.sort((a, b) => (a.time || 0) - (b.time || 0));
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const nxt = i + 1 < lines.length ? lines[i + 1].time : null;
    const curEnd = ln.end;
    if (nxt == null) {
      if (curEnd == null || curEnd <= ln.time) ln.end = null;
    } else if (curEnd == null || curEnd <= ln.time || curEnd > nxt) {
      ln.end = nxt;
    }
  }
}

function fmtTimeTag(t) {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function buildLrc(lines, meta, withZh) {
  const head = [];
  if (meta) {
    if (meta.title) head.push(`[ti:${meta.title}]`);
    if (meta.artist) head.push(`[ar:${meta.artist}]`);
  }
  const body = [];
  for (const ln of lines || []) {
    if (!ln.text) continue;
    body.push(`[${fmtTimeTag(ln.time || 0)}]${ln.text}`);
    if (withZh && ln.zh) body.push(`[${fmtTimeTag(ln.time || 0)}]${ln.zh}`);
  }
  return [...head, ...body].join('\n');
}

// 与衍生版 app.py 的 _normalize_lines 一致
function normalizeLines(items) {
  const lines = [];
  for (const it of items || []) {
    const text = String(it.text || '').trim();
    if (!text) continue;
    const t = Number(it.time);
    if (!Number.isFinite(t)) continue;
    const ln = makeLine(t, text);
    for (const k of LINE_FIELDS) {
      if (k === 'time' || k === 'text') continue;
      if (k in it && it[k] != null && it[k] !== '') ln[k] = it[k];
    }
    if (it.id) ln.id = String(it.id);
    lines.push(cleanLine(ln));
  }
  recomputeEnds(lines);
  return lines;
}

// =============================================================== IndexedDB
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('songs', { keyPath: 'id' });
        db.createObjectStore('history', { keyPath: 'id' }).createIndex('bySong', 'songId');
        db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('bySong', 'songId');
        db.createObjectStore('audio', { keyPath: 'songId' });
        db.createObjectStore('dictionary', { keyPath: 'surface' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('无法打开本地数据库（IndexedDB）：' + (req.error && req.error.message || '')));
    });
  }
  return dbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return idbReq(db.transaction(store).objectStore(store).get(key));
}

async function idbGetAll(store) {
  const db = await openDB();
  return idbReq(db.transaction(store).objectStore(store).getAll());
}

async function idbIndexAll(store, index, key) {
  const db = await openDB();
  return idbReq(db.transaction(store).objectStore(store).index(index).getAll(key));
}

async function idbPut(store, value) {
  const db = await openDB();
  return idbReq(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

// 事务内按索引批量删除（游标逐条删，错误由事务统一上报）
function purgeByIndex(store, indexName, key) {
  const cursorReq = store.index(indexName).openCursor(IDBKeyRange.only(key));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
}

// 原子地读改写一首歌（songs + history + snapshots + audio 同一事务）。
// fn(song, tx) 同步执行；返回值作为 resolve 值（undefined → 返回 song 本身）。
async function songTx(id, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['songs', 'history', 'snapshots', 'audio'], 'readwrite');
    let result;
    let songRef = null;
    let settled = false;
    const fail = (err) => {
      if (!settled) { settled = true; reject(err); }
      try { t.abort(); } catch { /* 事务已完成 */ }
    };
    t.oncomplete = () => {
      if (!settled) {
        settled = true;
        bus.emit('local:dirty', { type: 'song', id });
        resolve(result !== undefined ? result : songRef);
      }
    };
    t.onerror = () => fail(t.error || new Error('IndexedDB 写入失败'));
    t.onabort = () => fail(t.error || new Error('IndexedDB 事务中止'));
    const getReq = t.objectStore('songs').get(id);
    getReq.onsuccess = () => {
      const song = getReq.result;
      if (!song) { fail(new Error(`未找到：${id}`)); return; }
      song.lines = (song.lines || []).map(cleanLine); // 防御：剔除 _el 等运行时字段
      songRef = song;
      try {
        result = fn(song, t);
        t.objectStore('songs').put(song);
      } catch (e) {
        fail(e);
      }
    };
  });
}

// =============================================================== 设置（localStorage）
function readSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { saved = {}; }
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k in saved) out[k] = saved[k];
  }
  return out;
}

async function settings() {
  return readSettings();
}

async function saveSettings(patch) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { saved = {}; }
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULT_SETTINGS) saved[k] = v;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
  bus.emit('local:dirty', { type: 'settings' });
  return readSettings();
}

// =============================================================== 词典（IndexedDB）
async function dictionary() {
  const rows = await idbGetAll('dictionary');
  const out = {};
  for (const r of rows) {
    out[r.surface] = { k: r.k, r: r.r, fixed: !!r.fixed, updatedAt: r.updatedAt };
  }
  return out;
}

async function saveDictionary(entries, remove = []) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction('dictionary', 'readwrite');
    const store = t.objectStore('dictionary');
    for (const [surface, val] of Object.entries(entries || {})) {
      const key = String(surface).trim();
      if (!key || !val || typeof val !== 'object') continue;
      store.put({
        surface: key,
        k: String(val.k || ''),
        r: String(val.r || ''),
        fixed: val.fixed === undefined ? true : !!val.fixed,
        updatedAt: now(),
      });
    }
    for (const surface of remove || []) {
      store.delete(String(surface));
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error || new Error('IndexedDB 写入失败'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
  });
  bus.emit('local:dirty', { type: 'dictionary' });
  return dictionary();
}

// =============================================================== 歌曲（IndexedDB）
function makeSongRecord({ title, artist, album, source = 'local', sourceId, lines, timeline = 'none', duration = 0 }) {
  return {
    id: `${dateStamp()}-${hex(3)}`,
    title: title || '未命名歌曲',
    artist: String(artist || ''),
    album: String(album || ''),
    source: source || 'local',
    sourceId: String(sourceId || ''),
    duration: Number(duration) || 0,
    audio: null,
    timeline: lines ? timeline : 'none',
    offset: 0,
    syncInfo: null,
    lyricSource: null,
    lines: lines || [],
    createdAt: now(),
    updatedAt: now(),
    lastOpenedAt: now(),
  };
}

async function saveSong(song, opts = {}) {
  const { touch = true } = opts;
  if (touch) song.updatedAt = now();
  if (song.lines) song.lines = song.lines.map(cleanLine);
  await idbPut('songs', song);
  bus.emit('local:dirty', { type: 'song', id: song.id });
  return song;
}

/**
 * 按手动排序整理曲库列表：order 里的按序在前，不在 order 里的新歌按最近打开置顶，
 * order 为空时退回「最近打开优先」。
 */
export function sortSongsByOrder(songs, order) {
  const pos = new Map((order || []).map((id, i) => [id, i]));
  const recency = (s) => s.lastOpenedAt || s.updatedAt || 0;
  const known = songs.filter((s) => pos.has(s.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  const fresh = songs.filter((s) => !pos.has(s.id)).sort((a, b) => recency(b) - recency(a));
  if (!order || !order.length) return songs.slice().sort((a, b) => recency(b) - recency(a));
  return [...fresh, ...known];
}

async function songs() {
  const rows = await idbGetAll('songs');
  const out = rows.map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    source: s.source,
    sourceId: s.sourceId,
    hasAudio: !!s.audio,
    audioSize: s.audio?.size || 0,
    timeline: s.timeline,
    lineCount: (s.lines || []).length,
    editedCount: (s.lines || []).filter((l) => l.wordsEdited || l.romaji != null).length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastOpenedAt: s.lastOpenedAt,
  }));
  return sortSongsByOrder(out, readSettings().songOrder);
}

/** 保存曲库手动排序（存进设置，随云同步传播），返回排序后的列表。 */
async function setOrder(ids) {
  const known = new Set((await idbGetAll('songs')).map((s) => s.id));
  const order = (ids || []).filter((id) => known.has(id));
  await saveSettings({ songOrder: order });
  return songs();
}

// =============================================================== 单词本（纯客户端整理，笔记随设置云同步）

/** 整理单词：songId 省略或 'all' 时覆盖全部歌曲。释义 / 收藏笔记按词面合并（跨歌曲共享）。 */
async function vocab(songId) {
  const rows = await idbGetAll('songs');
  const order = readSettings().songOrder;
  const pos = new Map((order || []).map((id, i) => [id, i]));
  const target = String(songId || '');
  const list = rows
    .filter((s) => !target || target === 'all' || s.id === target)
    .sort((a, b) => (pos.get(a.id) ?? 1e12) - (pos.get(b.id) ?? 1e12) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const songsIn = list.map((s) => ({
    id: s.id,
    title: s.title,
    lines: (s.lines || []).map(cleanLine),
  }));
  const entries = buildVocab(songsIn, readSettings().vocabNotes || {});
  return { entries };
}

/** 保存单词笔记（释义 / 收藏等）。items: [{surface, kana?, meaning?, source?, note?, starred?}]，按词面合并进设置。 */
async function saveVocabNotes(items) {
  const notes = { ...(readSettings().vocabNotes || {}) };
  for (const it of items || []) {
    const key = String(it?.surface || '').trim();
    if (!key) continue;
    const old = notes[key] || {};
    const next = {
      kana: it.kana !== undefined ? String(it.kana || '') : (old.kana || ''),
      meaning: it.meaning !== undefined ? String(it.meaning || '') : (old.meaning || ''),
      source: it.source !== undefined ? String(it.source || '') : (old.source || ''),
      note: it.note !== undefined ? String(it.note || '') : (old.note || ''),
      starred: it.starred !== undefined ? !!it.starred : !!old.starred,
    };
    notes[key] = next;
  }
  await saveSettings({ vocabNotes: notes });
  return { ok: true };
}

async function song(id) {
  const s = await idbGet('songs', id);
  if (!s) throw new Error(`未找到：${id}`);
  s.lastOpenedAt = now();
  await idbPut('songs', s);
  return s;
}

async function createSong(input, onProgress) {
  const fd = input instanceof FormData ? input : null;
  const get = (k) => (fd ? fd.get(k) : input[k]);
  let title = String(get('title') || '').trim();
  let artist = String(get('artist') || '').trim();
  const album = String(get('album') || '').trim();

  let lrc = String(get('lrc') || '');
  const lrcFile = get('lrcFile');
  if (lrcFile && lrcFile.name) lrc = await decodeTextFile(lrcFile);

  let parsed = null;
  if (String(lrc || '').trim()) parsed = parseLrc(lrc);

  const audioFile = get('audio');
  const hasAudio = !!(audioFile && audioFile.name);

  // 标题优先级：手填 > LRC 元信息 > 音频文件名 > LRC 文件名
  if (!title && parsed?.meta?.ti) title = parsed.meta.ti;
  if (!artist && parsed?.meta?.ar) artist = parsed.meta.ar;
  if (!title && hasAudio) {
    const g = guessMetaFromFilename(audioFile.name);
    title = g.title;
    if (!artist) artist = g.artist;
  }
  if (!title && lrcFile && lrcFile.name) {
    const g = guessMetaFromFilename(lrcFile.name);
    title = g.title;
    if (!artist) artist = g.artist;
  }

  const rec = makeSongRecord({
    title, artist, album,
    source: 'local',
    lines: parsed ? parsed.lines : [],
    timeline: parsed ? parsed.timeline : 'none',
  });
  await idbPut('songs', rec);

  if (hasAudio) {
    try {
      await storeAudio(rec, audioFile, audioFile.name, audioFile.type || '');
    } catch (e) {
      await deleteSong(rec.id);
      throw e;
    }
  }
  if (onProgress) onProgress(1);
  bus.emit('local:dirty', { type: 'song', id: rec.id });
  return rec;
}

/** 从联网来源导入（网易云 / LRCLIB / Marumaru）。同来源同 ID 已存在时直接返回旧条目（保留用户修改）。 */
async function importSong(payload) {
  const source = payload.source || 'online';
  const sourceId = String(payload.sourceId || '');
  if (sourceId) {
    const all = await idbGetAll('songs');
    const existing = all.find((s) => s.source === source && s.sourceId === sourceId);
    if (existing && !payload.force) return { song: existing, existed: true };
  }
  const lines = normalizeLines(payload.lines);
  const rec = makeSongRecord({
    title: payload.title, artist: payload.artist, album: payload.album,
    source, sourceId, lines,
    timeline: payload.timeline || 'synced',
    duration: payload.duration,
  });
  await idbPut('songs', rec);
  bus.emit('local:dirty', { type: 'song', id: rec.id });
  return { song: rec, existed: false };
}

async function patchSong(id, patch) {
  return songTx(id, (songRec) => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (SONG_FIELDS.has(k)) songRec[k] = v;
    }
  });
}

async function deleteSongData(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['songs', 'history', 'snapshots', 'audio'], 'readwrite');
    t.objectStore('songs').delete(id);
    purgeByIndex(t.objectStore('history'), 'bySong', id);
    purgeByIndex(t.objectStore('snapshots'), 'bySong', id);
    t.objectStore('audio').delete(id);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error || new Error('IndexedDB 写入失败'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
  });
  revokeAudioUrl(id);
  return { ok: true };
}

async function deleteSong(id) {
  const s = await idbGet('songs', id);
  if (!s) throw new Error(`未找到：${id}`);
  const out = await deleteSongData(id);
  bus.emit('local:dirty', { type: 'song-delete', id });
  return out;
}

// =============================================================== 音频（IndexedDB Blob + object URL）
async function storeAudio(songRec, blob, filename, contentType) {
  let ext = String(filename || '').split('.').pop().toLowerCase();
  if (!EXT_MIME[ext]) {
    ext = AUDIO_EXT[String(contentType || '').split(';')[0].trim().toLowerCase()];
  }
  if (!EXT_MIME[ext]) {
    throw new Error('无法识别的音频格式，请上传 mp3 / m4a / flac / ogg / wav（NCM 会在浏览器里先还原）');
  }
  revokeAudioUrl(songRec.id);
  await idbPut('audio', {
    songId: songRec.id,
    blob,
    mime: EXT_MIME[ext],
    size: blob.size,
    name: filename,
    file: `${songRec.id}.${ext}`,
  });
  songRec.audio = { file: `${songRec.id}.${ext}`, mime: EXT_MIME[ext], size: blob.size, name: filename };
  return saveSong(songRec);
}

async function uploadAudio(id, blob, filename, onProgress) {
  const s = await idbGet('songs', id);
  if (!s) throw new Error(`未找到：${id}`);
  if (onProgress) onProgress(1); // 本地写入即时完成
  return storeAudio(s, blob, filename || 'audio', blob.type || '');
}

async function deleteAudio(id) {
  revokeAudioUrl(id);
  return songTx(id, (songRec, t) => {
    t.objectStore('audio').delete(id);
    songRec.audio = null;
  });
}

/** 本设备音频索引（不含 Blob）：[{songId, size, mime, name}]，曲库缓存徽章用。 */
async function audioIndex() {
  const rows = await idbGetAll('audio');
  return rows.map((r) => ({ songId: r.songId, size: r.size || (r.blob && r.blob.size) || 0, mime: r.mime || '', name: r.name || '' }));
}

/** 仅删除本设备的音频 Blob（不动歌曲记录——云用户的「清除本设备缓存」，下次同步可重新下载）。 */
async function removeAudioBlob(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction('audio', 'readwrite');
    t.objectStore('audio').delete(id);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error || new Error('IndexedDB 写入失败'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
  });
  revokeAudioUrl(id);
  return { ok: true };
}

const audioUrlCache = new Map(); // songId → { bust, url }

/** 取音频的 object URL（Blob 从 IndexedDB 读出后生成；同 bust 复用，换 bust 时重建）。 */
async function audioUrl(id, bust = '') {
  const key = String(bust);
  const hit = audioUrlCache.get(id);
  if (hit && hit.bust === key) return hit.url;
  const rec = await idbGet('audio', id);
  if (!rec) throw new Error('该歌曲还没有音频');
  const url = URL.createObjectURL(rec.blob);
  if (hit) URL.revokeObjectURL(hit.url);
  audioUrlCache.set(id, { bust: key, url });
  return url;
}

function revokeAudioUrl(id) {
  const hit = audioUrlCache.get(id);
  if (hit) {
    URL.revokeObjectURL(hit.url);
    audioUrlCache.delete(id);
  }
}

// =============================================================== 编辑历史（IndexedDB）
let histSeq = Date.now(); // 单调递增，模拟 SQLite rowid 的插入顺序

function addHistory(t, songId, entries) {
  const store = t.objectStore('history');
  for (const e of entries || []) {
    const rec = {
      id: 'h_' + hex(4),
      songId,
      ts: now(),
      seq: ++histSeq,
      lineId: e.lineId ?? null,
      kind: e.kind || 'edit',
      summary: e.summary || '',
      before: e.before ?? null,
      after: e.after ?? null,
    };
    if (e.group) rec.group = e.group;
    if (e.snapshot) rec.snapshot = e.snapshot;
    store.put(rec);
  }
}

/** 全文编辑前给整首歌词做快照，返回快照 ID（写进历史，撤销时整体恢复）。 */
function snapshotLines(t, songRec) {
  const sid = 's_' + fullStamp() + hex(2);
  t.objectStore('snapshots').put({
    id: sid,
    songId: songRec.id,
    createdAt: now(),
    timeline: songRec.timeline,
    lines: deepClone(songRec.lines || []),
  });
  return sid;
}

function wordsSig(line) {
  return (line.words || []).map((w) => [w.t ?? '', w.k ?? '', w.r ?? '', w.m ?? ''].join('\u0000')).join('\u0001');
}

function lineSummary(before, after) {
  if (before == null) return '新增行';
  const parts = [];
  if (before.text !== after.text) parts.push('原文');
  if (wordsSig(before) !== wordsSig(after)) {
    const bw = (before.words || []).map((w) => w.t ?? '').join('\u0001');
    const aw = (after.words || []).map((w) => w.t ?? '').join('\u0001');
    parts.push(bw === aw ? '读音/标记' : '分词');
  }
  if (before.romaji !== after.romaji) parts.push('罗马音');
  if (before.zh !== after.zh) parts.push('中文');
  if (before.time !== after.time) parts.push('时间');
  return parts.join('、') || '无变化';
}

/** 按行 ID 局部更新歌词行。lines: [{id, ...要修改的字段}]；record=true 写入编辑历史。 */
async function patchLines(id, patches, opts = {}) {
  const { record = false, kind = 'edit', note = '' } = opts;
  return songTx(id, (songRec, t) => {
    const byId = new Map((songRec.lines || []).map((ln) => [ln.id, ln]));
    const hist = [];
    const changed = [];
    let timeChanged = false;
    for (const patch of patches || []) {
      const ln = byId.get(patch.id);
      if (!ln) continue;
      const before = deepClone(ln);
      for (const [k, v] of Object.entries(patch)) {
        if (!LINE_FIELDS.has(k)) continue;
        ln[k] = v;
        if (k === 'time') timeChanged = true;
      }
      if (deepEqual(before, ln)) continue;
      changed.push(ln);
      if (record) {
        const summary = lineSummary(before, ln);
        hist.push({
          lineId: ln.id, kind,
          summary: summary + (note ? '：' + note : ''),
          before, after: deepClone(ln),
        });
      }
    }
    if (hist.length > 1) {
      // 同一次操作（如同步到副歌的多行）归为一组，撤销时一起恢复
      const group = 'g_' + hex(4);
      for (const e of hist) e.group = group;
    }
    if (timeChanged) recomputeEnds(songRec.lines);
    if (changed.length) {
      songRec.updatedAt = now();
      addHistory(t, id, hist);
    }
    return {
      updated: changed.map((ln) => ln.id),
      lines: timeChanged ? songRec.lines : changed,
      resorted: timeChanged,
    };
  });
}

/** 整体替换歌词（全文编辑 / 绑定联网歌词 / 补传 LRC）。
 *  keepEdits：新旧行按原文匹配，原文未变的行保留分词/读音/标记/中文与行 ID。 */
async function replaceLyrics(id, payload) {
  const keepEdits = payload.keepEdits === undefined ? true : !!payload.keepEdits;
  return songTx(id, (songRec, t) => {
    let newLines;
    let timeline;
    if (payload.lrc != null) {
      const parsed = parseLrc(payload.lrc);
      newLines = parsed.lines;
      timeline = parsed.timeline;
    } else {
      newLines = normalizeLines(payload.lines);
      timeline = payload.timeline || (newLines.length ? 'synced' : 'none');
    }
    if (payload.timeline) timeline = payload.timeline;

    if (keepEdits && songRec.lines && songRec.lines.length) {
      const pool = new Map();
      for (const old of songRec.lines) {
        const key = normKey(old.text);
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push(old);
      }
      const usedIds = new Set();
      for (const ln of newLines) {
        const cands = pool.get(normKey(ln.text)) || [];
        let old = cands.find((c) => !usedIds.has(c.id)) || null;
        if (old == null && cands.length) old = cands[0];
        if (!old) continue;
        if (!usedIds.has(old.id)) {
          ln.id = old.id;
          usedIds.add(old.id);
        }
        for (const k of ['words', 'wordsEdited', 'romaji', 'ruby']) {
          const empty = (v) => v == null || v === false || v === '';
          if (empty(ln[k]) && !empty(old[k])) ln[k] = deepClone(old[k]);
        }
        if (!ln.zh && old.zh) ln.zh = old.zh;
        if (!ln.wordTiming && old.wordTiming && Math.abs(old.time - ln.time) < 0.5) {
          ln.wordTiming = old.wordTiming;
        }
      }
    }

    const snap = songRec.lines && songRec.lines.length ? snapshotLines(t, songRec) : null;
    songRec.lines = newLines.map(cleanLine);
    songRec.timeline = newLines.length ? timeline : 'none';
    songRec.syncInfo = null; // 歌词变了：允许重新自动获取逐字时间轴
    if (payload.source) {
      songRec.lyricSource = { source: payload.source, sourceId: String(payload.sourceId || '') };
    }
    songRec.updatedAt = now();
    addHistory(t, id, [{
      lineId: null, kind: 'lyrics',
      summary: payload.note || `替换歌词（${newLines.length} 行）`,
      snapshot: snap,
    }]);
  });
}

async function history(id) {
  const rows = await idbIndexAll('history', 'bySong', id);
  rows.sort((a, b) => (b.ts - a.ts) || (b.seq - a.seq));
  return rows.slice(0, 300).map(({ songId, seq, ...rest }) => rest);
}

/** 把某条历史恢复到修改前：行级 → 还原该行；全文级 → 还原整首快照。 */
async function revert(id, hid) {
  const entry = await idbGet('history', hid);
  if (!entry || entry.songId !== id) throw new Error('历史记录不存在');

  if (entry.kind === 'lyrics' || entry.lineId == null) {
    const snap = entry.snapshot ? await idbGet('snapshots', entry.snapshot) : null;
    if (!snap || snap.songId !== id) throw new Error('这条记录没有可恢复的快照');
    return songTx(id, (songRec, t) => {
      const newSnap = snapshotLines(t, songRec); // 先给当前歌词做快照，便于再撤销
      songRec.lines = (snap.lines || []).map(cleanLine);
      songRec.timeline = snap.timeline || songRec.timeline;
      songRec.updatedAt = now();
      addHistory(t, id, [{
        lineId: null, kind: 'lyrics',
        summary: `撤销：${entry.summary || ''}`, snapshot: newSnap,
      }]);
    });
  }

  // 行级撤销（同组的多条一起恢复）
  let entries = [entry];
  if (entry.group) {
    const rows = await idbIndexAll('history', 'bySong', id);
    entries = rows.filter((r) => r.group === entry.group).sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  }
  return songTx(id, (songRec, t) => {
    const byId = new Map((songRec.lines || []).map((ln, i) => [ln.id, i]));
    const newHist = [];
    const newGroup = entries.length > 1 ? 'g_' + hex(4) : null;
    for (const e of entries) {
      const before = e.before;
      const idx = before ? byId.get(e.lineId) : undefined;
      if (idx == null || !before) continue;
      const cur = deepClone(songRec.lines[idx]);
      songRec.lines[idx] = deepClone(before);
      newHist.push({
        lineId: before.id, kind: 'revert', summary: `撤销：${e.summary || ''}`,
        before: cur, after: deepClone(before), group: newGroup,
      });
    }
    if (!newHist.length) throw new Error('该行已不存在（可能已被全文编辑替换）');
    recomputeEnds(songRec.lines);
    songRec.updatedAt = now();
    addHistory(t, id, newHist);
  });
}

/** 导出 LRC 文件（含可选中文翻译行），通过浏览器下载。 */
async function downloadLrc(id, zh = false) {
  const s = await idbGet('songs', id);
  if (!s) throw new Error(`未找到：${id}`);
  const text = buildLrc(s.lines || [], { title: s.title, artist: s.artist }, !!zh);
  const fname = `${s.artist || ''} - ${s.title || ''}`
    .replace(/^[\s-]+|[\s-]+$/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_') || 'lyrics';
  downloadText(`${fname}.lrc`, text);
  return { ok: true };
}

// =============================================================== 在线歌词源
// 网易云 / Marumaru 走本仓库的 Cloudflare Worker 代理（浏览器直连会被 CORS 拦截）；
// LRCLIB / PetitLyrics / MyMemory 均允许跨域，浏览器直连。
// 本地开发 / GitHub Pages 下自动回落到独立部署的 Worker；可用 localStorage 键
// jplrc-proxy-base 覆盖（如本地 wrangler dev 的 http://127.0.0.1:8787），
// jplrc-proxy-off=1 可临时关闭网易云源。
const PROXY_FALLBACK = 'https://jp-lyrics-proxy.nepqaq.workers.dev';

export function proxyBase() {
  try {
    const custom = String(localStorage.getItem('jplrc-proxy-base') || '').trim();
    if (custom) return custom.replace(/\/+$/, '');
  } catch { /* localStorage 不可用时走默认 */ }
  try {
    const host = location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    const isGithubPages = /\.github\.io$/i.test(host);
    return (isLocal || isGithubPages) ? PROXY_FALLBACK : ''; // 同源部署（Worker 托管静态资源）
  } catch {
    return PROXY_FALLBACK;
  }
}

function neteaseDisabled() {
  try { return localStorage.getItem('jplrc-proxy-off') === '1'; } catch { return false; }
}

// 带超时的 JSON 请求：限流或线路不稳时不至于把整个搜索拖死
async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      // 跳过浏览器 HTTP 缓存：代理侧已有自己的缓存策略，浏览器再缓存一次
      // 会把一次临时的空结果固化下来，导致「明明有歌却搜不到」。
      cache: 'no-store',
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const err = data && data.error;
      const msg = typeof err === 'string' ? err : (err && err.message);
      throw new Error(msg || `代理 HTTP ${response.status}`);
    }
    return data || {};
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function proxyJson(path, { timeout = 15000, retries = 0, retryDelay = 600 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(proxyBase() + path, timeout);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(retryDelay);
    }
  }
  throw lastErr || new Error('代理请求失败');
}

function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function neteaseSearch(q, limit = 8) {
  if (neteaseDisabled()) throw new Error('网易云源已禁用（localStorage jplrc-proxy-off=1）');
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const matches = (data) => data?.query != null && norm(data.query) === norm(q);
  // 关键词放进路径（并附随机时间戳）：移动网络与中间缓存常把 URL 查询串丢掉，
  // 于是同一个 /api/search 缓存被不同关键词共用，返回上一个关键词的结果。
  // 同时保留 ?q= 形式，代理还没升级到路径式时仍可用。
  const buildUrls = () => {
    const tail = `limit=${limit}&_t=${stamp()}`;
    return [
      `/api/search/${encodeURIComponent(q)}?${tail}`,
      `/api/search?q=${encodeURIComponent(q)}&${tail}`,
    ];
  };
  let lastError = null;
  // 两轮：任一次都拿不到「关键词一致」的结果时，再换时间戳重新取
  for (let round = 0; round < 2; round++) {
    for (const url of buildUrls()) {
      let data;
      try {
        data = await fetchJson(proxyBase() + url, 9000);
      } catch (e) {
        lastError = e;
        continue;
      }
      if (matches(data)) {
        const results = Array.isArray(data?.results) ? data.results : [];
        return { query: q, results: results.slice(0, limit) };
      }
      lastError = new Error('返回结果与关键词不一致，请再点一次搜索');
    }
  }
  throw lastError || new Error('网易云搜索失败');
}

async function neteaseLyric(id) {
  if (neteaseDisabled()) throw new Error('网易云源已禁用（localStorage jplrc-proxy-off=1）');
  const data = await proxyJson(`/api/lyric?id=${encodeURIComponent(id)}`, { timeout: 15000 });
  if (!Array.isArray(data.lines) || !data.lines.length) throw new Error('该歌曲没有歌词');
  return data;
}

// LRCLIB 单次请求：限时 9s（限流时服务器会拖慢响应），503/429 退避重试一次
async function lrclibQuery(params) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v) clean[k] = v;
  }
  if (!Object.keys(clean).length) return [];
  const url = new URL('https://lrclib.net/api/search');
  for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: { 'Lrclib-Client': 'jp-lyrics-studio' },
      });
      if (r.status === 429 || r.status === 503) {
        await sleep(500); // 服务器过载/限流，稍后重试
        continue;
      }
      if (r.status >= 400) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (attempt === 0) await sleep(500);
      else return [];
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

// 搜索策略分两波：
// 第一波（并行）：全文 q + 整句当 track_name —— 覆盖绝大多数场景，一轮往返即出结果
// 第二波（并行）：「歌名 歌手」「歌手 歌名」拆分 —— 第一波结果不足时补充
async function lrclibSearch(q) {
  const query = String(q || '').trim();
  if (!query) return { query: q, results: [] };
  const waves = [[{ q: query }, { track_name: query }]];
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const second = [{ track_name: tokens.slice(0, -1).join(' '), artist_name: tokens[tokens.length - 1] }];
    if (tokens.slice(1).join(' ') !== tokens.slice(0, -1).join(' ')) {
      second.push({ track_name: tokens.slice(1).join(' '), artist_name: tokens[0] });
    }
    waves.push(second);
  }
  const seen = new Set();
  const out = [];
  for (const wave of waves) {
    const lists = await Promise.all(wave.map((p) => lrclibQuery(p)));
    for (const item of lists.flat()) {
      if (!item || item.id == null || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    if (out.length >= 5) break;
  }
  // 有同步歌词的排前面
  out.sort((a, b) => (a.syncedLyrics ? 0 : 1) - (b.syncedLyrics ? 0 : 1));
  return { query: q, results: out.slice(0, 20) };
}

// marumaru 的 search-all 把整个关键词当一个词处理，「歌名 歌手」组合查询必然落空，
// 所以只按歌名搜，无结果时再用歌手名兜底
async function marumaruSearch(title, artist = '') {
  const queries = [...new Set([String(title || '').trim(), String(artist || '').trim()])].filter(Boolean);
  for (const q of queries) {
    // 关键词走路径式并附时间戳（与网易云搜索同一套防移动缓存串结果的策略）；
    // marumaru 在国内移动网络上偶发较慢，超时放宽并重试一次，避免误报「暂不可用」
    const url = `/api/marumaru/search/${encodeURIComponent(q)}?_t=${stamp()}`;
    let data;
    try {
      data = await proxyJson(url, { timeout: 25000, retries: 1, retryDelay: 600 });
    } catch (e) {
      throw e;
    }
    if (data?.query != null && String(data.query).trim().toLowerCase() !== q.toLowerCase()) {
      throw new Error('返回结果与关键词不一致，请重试');
    }
    let items = Array.isArray(data?.results) ? data.results : [];
    if (!items.length) continue;
    if (artist) {
      const al = String(artist).toLowerCase();
      items = items.slice().sort((a, b) => {
        const aHit = `${a.title || ''} ${a.artist || ''}`.toLowerCase().includes(al) ? 1 : 0;
        const bHit = `${b.title || ''} ${b.artist || ''}`.toLowerCase().includes(al) ? 1 : 0;
        return bHit - aHit;
      });
    }
    return { results: items.slice(0, 10) };
  }
  return { results: [] };
}

async function marumaruLyric(url) {
  const data = await proxyJson(`/api/marumaru/lyric?url=${encodeURIComponent(url)}`, { timeout: 25000, retries: 1 });
  if (!Array.isArray(data?.lines) || !data.lines.length) {
    throw new Error('Marumaru 页面未能解析出歌词');
  }
  return data;
}

// =============================================================== PetitLyrics 逐字时间轴
function base64ToUtf8(b64) {
  const bin = atob(String(b64 || '').trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function parsePetitXml(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const ltype = doc.querySelector('lyricsType')?.textContent || '';
    const ldata = doc.querySelector('lyricsData')?.textContent || '';
    if (ltype !== '3' || !ldata) return [];
    const inner = new DOMParser().parseFromString(base64ToUtf8(ldata), 'text/xml');
    const lines = [];
    for (const lineEl of inner.querySelectorAll('line')) {
      const words = [];
      for (const wEl of lineEl.querySelectorAll('word')) {
        const text = (wEl.querySelector('wordstring')?.textContent || '').trim();
        if (!text) continue;
        words.push({
          starttime: parseInt(wEl.querySelector('starttime')?.textContent || '0', 10) || 0,
          endtime: parseInt(wEl.querySelector('endtime')?.textContent || '0', 10) || 0,
          text,
        });
      }
      const text = lineEl.querySelector('linestring')?.textContent || '';
      if (text || words.length) lines.push({ text, words });
    }
    return lines;
  } catch {
    return [];
  }
}

async function petit(title, artist = '') {
  const cleanArtist = String(artist || '').split(/[,/&]| feat\.? /i)[0].trim();
  const keys = [...new Set([cleanArtist, ''])]; // 先带歌手名查，查不到再去掉
  for (const key of keys) {
    const form = new URLSearchParams();
    form.set('clientAppId', 'p1110417');
    form.set('lyricsType', '3');
    form.set('terminalType', '10');
    form.set('key_title', String(title || ''));
    if (key) form.set('key_artist', key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch('https://p0.petitlyrics.com/api/GetPetitLyricsData.php', {
        method: 'POST',
        body: form,
        signal: ctrl.signal,
      });
      if (r.status >= 400) continue;
      const lines = parsePetitXml(await r.text());
      if (lines.length) return { lines };
    } catch { /* 尝试去掉歌手名再查 */ }
    finally { clearTimeout(timer); }
  }
  return { lines: [] };
}

// =============================================================== MyMemory 日→中机器翻译
async function translate(texts) {
  const list = (texts || []).map((t) => String(t)).slice(0, 200);
  const out = [];
  for (const t of list) {
    if (!t.trim()) {
      out.push('');
      await sleep(150);
      continue;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=ja|zh-CN`,
        { signal: ctrl.signal },
      );
      const data = r.ok ? await r.json() : null;
      out.push(data?.responseData?.translatedText || '');
    } catch {
      out.push('');
    } finally {
      clearTimeout(timer);
    }
    await sleep(150); // 免费接口限速
  }
  return { results: out };
}

// =============================================================== 云同步底层（cloud.js 专用）
// 这些方法直接读写 IndexedDB 且不触发 local:dirty 事件，
// 供云同步引擎在「拉取合并」时应用远端数据，避免推送回环。

async function rawSongs() {
  const rows = await idbGetAll('songs');
  return rows.map((s) => ({ ...s, lines: (s.lines || []).map(cleanLine) }));
}

async function rawSong(id) {
  const s = await idbGet('songs', id);
  if (!s) return null;
  s.lines = (s.lines || []).map(cleanLine);
  return s;
}

/** 按原样写入歌曲记录（不更新 updatedAt，不触发同步事件）。 */
async function putSongRaw(song) {
  const rec = { ...song, lines: (song.lines || []).map(cleanLine) };
  await idbPut('songs', rec);
  return rec;
}

/** 写入音频 Blob（不动歌曲记录的 updatedAt）。返回与 song.audio 一致的元数据。 */
async function putAudioRaw(songId, blob, mime, size, name) {
  let ext = String(name || '').split('.').pop().toLowerCase();
  if (!EXT_MIME[ext]) ext = AUDIO_EXT[String(mime || '').split(';')[0].trim().toLowerCase()];
  if (!EXT_MIME[ext]) throw new Error(`无法识别的音频格式：${mime || name}`);
  const meta = {
    file: `${songId}.${ext}`,
    mime: EXT_MIME[ext],
    size: size || blob.size,
    name: name || `${songId}.${ext}`,
  };
  await idbPut('audio', { songId, blob, ...meta });
  return meta;
}

async function getAudioBlob(id) {
  return (await idbGet('audio', id)) || null;
}

/** 按原样写入词典条目（保留各自的 updatedAt，不触发同步事件）。 */
async function putDictionaryRaw(entries) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction('dictionary', 'readwrite');
    const store = t.objectStore('dictionary');
    for (const [surface, val] of Object.entries(entries || {})) {
      const key = String(surface).trim();
      if (!key || !val || typeof val !== 'object') continue;
      store.put({
        surface: key,
        k: String(val.k || ''),
        r: String(val.r || ''),
        fixed: val.fixed === undefined ? true : !!val.fixed,
        updatedAt: Number(val.updatedAt) || now(),
      });
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error || new Error('IndexedDB 写入失败'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
  });
  return dictionary();
}

// =============================================================== 对外接口（与衍生版 server/app.py 的 API 形状一致）
export const api = {
  settings,
  saveSettings,
  dictionary,
  saveDictionary,

  songs,
  setOrder,
  vocab,
  saveVocabNotes,
  song,
  createSong,
  importSong,
  patchSong,
  deleteSong,
  uploadAudio,
  deleteAudio,
  audioUrl,
  audioIndex,
  removeAudioBlob,

  // 云同步底层（cloud.js 使用；不触发 local:dirty）
  rawSongs,
  rawSong,
  putSongRaw,
  putAudioRaw,
  getAudioBlob,
  putDictionaryRaw,
  deleteSongRaw: deleteSongData,

  /** lines: [{id, ...fields}]；record=true 写入编辑历史 */
  patchLines,
  replaceLyrics,
  history,
  revert,
  downloadLrc,
  parseLrc: async (lrc) => parseLrc(lrc),

  online: {
    neteaseSearch,
    neteaseLyric,
    lrclibSearch,
    marumaruSearch,
    marumaruLyric,
    petit,
    translate,
  },
};
