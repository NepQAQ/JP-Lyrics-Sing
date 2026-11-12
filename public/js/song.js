// 歌曲生命周期：打开 / 重新加载 / 后台分词分析并回写 / 联网补充（Marumaru 注音、网易云 yrc / PetitLyrics 逐字时间轴、机器翻译）
import { $, toast, bus, setStatus, sleep, normText } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { renderSong, renderLineContent } from './render.js';
import { analyzeText, ensureTokenizer, wordsMatchText, fallbackWords, rubyPlainText } from './analyzer.js';
import { loadSongAudio, lyricTime, seekLyric, syncHighlight } from './player.js';
import { isCoarseTiming } from './timing.js';

let analysisGen = 0;

export async function openSong(id, { keepPosition = false } = {}) {
  const pos = keepPosition ? lyricTime() : 0;
  let song;
  try {
    song = await api.song(id);
  } catch (e) {
    toast('打开失败：' + e.message, { error: true });
    return null;
  }
  const sameSong = state.song?.id === song.id;
  state.song = song;
  try { localStorage.setItem('jls-last-song', song.id); } catch {}
  renderSong();
  updateSongHeader();
  if (!(keepPosition && sameSong)) loadSongAudio(song);
  else { seekLyric(pos); syncHighlight(); }
  bus.emit('song:opened', song);
  analyzeSong();
  maybeAutoWordTiming(song);
  return song;
}

/** 同步时间轴的歌曲第一次打开且没有逐字数据时，后台尝试获取一次（结果记在 song.syncInfo，不重复尝试） */
function maybeAutoWordTiming(song) {
  if (state.settings.autoWordTiming === false) return;
  if (song.timeline !== 'synced' || !song.title || song.syncInfo) return;
  if (song.lines.some(l => l.wordTiming?.length)) return;
  fetchWordTiming(song, { quiet: true }).catch(e => console.warn('[wordTiming]', e));
}

export function updateSongHeader() {
  const s = state.song;
  $('#song-title').textContent = s ? s.title || '未命名歌曲' : 'JP Lyrics Studio';
  $('#song-artist').textContent = s ? (s.artist || '') : '日语歌曲练习';
  $('#offset-input').value = String(s?.offset || 0);
  document.body.classList.toggle('has-song', !!s);
  document.body.classList.toggle('has-lyrics', !!s?.lines?.length);
  const tl = s?.timeline;
  const wt = s?.lines?.filter(l => l.wordTiming?.length).length || 0;
  const coarse = s?.lines?.filter(l => isCoarseTiming(l.wordTiming)).length || 0;
  $('#song-timeline').textContent = !s ? '' : tl === 'synced' ? (wt ? (coarse > wt / 2 ? '分段同步' : '逐字同步') : '同步时间轴') : tl === 'synthetic' ? '估算时间轴' : '无歌词';
  $('#song-timeline').title = wt ? `${wt}/${s.lines.length} 句有逐字时间轴（${s.syncInfo?.source || ''}）` : '';
  $('#song-timeline').dataset.tl = tl || '';
}

/** 对缺少分词结果（或原文已变）的行做分析，渲染并分批回写服务端（不记入历史） */
export async function analyzeSong({ onlyUnedited = false, force = false } = {}) {
  const song = state.song;
  if (!song?.lines?.length) return;
  const gen = ++analysisGen;
  const todo = song.lines.filter(ln => {
    if (force || onlyUnedited) return !ln.wordsEdited;
    return !wordsMatchText(ln.words, ln.text);
  });
  if (!todo.length) return;
  setStatus(`正在加载日语词典…（首次约 17MB）`);
  try {
    await ensureTokenizer();
  } catch (e) {
    setStatus('分词器加载失败：' + e.message + '（歌词仍可显示，刷新页面重试）', { error: true });
    todo.forEach(ln => { if (!Array.isArray(ln.words)) { ln.words = fallbackWords(ln.text); renderLineContent(ln); } });
    return;
  }
  if (gen !== analysisGen || state.song !== song) return;
  const cache = new Map();
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      await api.patchLines(song.id, batch, { record: false });
    } catch (e) {
      console.warn('[analyze] 回写失败', e);
    }
  };
  for (let i = 0; i < todo.length; i++) {
    if (gen !== analysisGen || state.song !== song) return;
    const ln = todo[i];
    const key = ln.text + '\u0000' + (ln.ruby || '');
    let words = cache.get(key);
    if (!words) {
      try {
        words = await analyzeText(ln.text, { ruby: ln.ruby });
      } catch {
        words = fallbackWords(ln.text);
      }
      cache.set(key, words);
    }
    ln.words = JSON.parse(JSON.stringify(words));
    if (onlyUnedited || force) ln.romaji = ln.wordsEdited ? ln.romaji : null;
    renderLineContent(ln);
    pending.push({ id: ln.id, words: ln.words, ...(onlyUnedited || force ? { romaji: ln.romaji || null } : {}) });
    if (pending.length >= 40) await flush();
    if (i % 8 === 7) {
      setStatus(`分词分析 ${i + 1}/${todo.length}`);
      await sleep(0);
    }
  }
  await flush();
  if (gen === analysisGen) setStatus(`已就绪 · ${song.lines.length} 行`);
  syncHighlight();
}

// ---------------------------------------------------------------- Marumaru 注音 + 中文
export async function marumaruCandidates(song = state.song) {
  if (!song) return [];
  const res = await api.online.marumaruSearch(song.title || '', song.artist || '');
  return res.results || [];
}

/** 把 Marumaru 歌词页的注音与中文套到当前歌曲（按原文匹配；用户手动编辑过的行不动） */
export async function applyMarumaru(item, { quiet = false } = {}) {
  const song = state.song;
  if (!song) return 0;
  const data = await api.online.marumaruLyric(item.url);
  if (state.song !== song) return 0;
  const byText = new Map();
  for (const raw of data.lines || []) {
    const text = rubyPlainText(raw.ja || '');
    const key = normText(text);
    if (key && !byText.has(key)) byText.set(key, { ruby: raw.ja || '', text, zh: String(raw.zh || '').trim() });
  }
  if (!song.lines.length) {
    // 当前没有歌词：直接用 Marumaru 歌词（无时间轴）
    const lines = [...byText.values()].map((v, i) => ({ time: i * 4, text: v.text, zh: v.zh, ruby: v.ruby }));
    await api.replaceLyrics(song.id, { lines, timeline: 'synthetic', keepEdits: false, note: 'Marumaru 歌词', source: 'marumaru', sourceId: item.url });
    bus.emit('song:reload', {});
    return lines.length;
  }
  const patches = [];
  for (const ln of song.lines) {
    const hit = byText.get(normText(ln.text));
    if (!hit) continue;
    const p = { id: ln.id };
    if (!ln.wordsEdited && hit.ruby && hit.ruby !== ln.ruby) { p.ruby = hit.ruby; p.words = null; ln.ruby = hit.ruby; ln.words = null; }
    if (!ln.zh && hit.zh) { p.zh = hit.zh; ln.zh = hit.zh; }
    if (Object.keys(p).length > 1) { patches.push(p); renderLineContent(ln); }
  }
  if (patches.length) {
    await api.patchLines(song.id, patches, { record: false });
    analyzeSong();
  }
  if (!quiet) toast(patches.length ? `Marumaru：已补充 ${patches.length} 行注音/中文` : 'Marumaru：没有可匹配的行');
  return patches.length;
}

/** 自动补充：Marumaru 注音 / 中文 + 逐字时间轴 */
export async function autoEnrich(song = state.song, { marumaru = true, timing = true } = {}) {
  if (!song?.lines?.length) return;
  const tasks = [];
  if (marumaru) {
    tasks.push((async () => {
      const cands = await marumaruCandidates(song);
      if (cands.length && state.song === song) await applyMarumaru(cands[0], { quiet: true });
    })().catch(e => console.warn('[marumaru]', e.message)));
  }
  if (timing && song.timeline === 'synced' && !song.lines.some(l => l.wordTiming?.length)) {
    tasks.push(fetchWordTiming(song, { quiet: true }).catch(e => console.warn('[wordTiming]', e.message)));
  }
  await Promise.allSettled(tasks);
}

// ---------------------------------------------------------------- 逐字时间轴（网易云 yrc / PetitLyrics）
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

/**
 * 把外部逐字数据 ext=[{text, words:[{starttime,endtime,text}], zh?}] 按原文 + 时间就近匹配到本曲各行。
 * 用「时间差中位数」判断版本是否一致：差太多（不同版本/剪辑）则放弃；与中位数偏离过大的个别匹配也丢弃。
 */
export function matchTiming(song, ext) {
  const items = ext
    .filter(e => e.words?.length)
    .map(e => ({ key: normText(e.text || e.words.map(w => w.text).join('')), t: e.words[0].starttime / 1000, words: e.words, zh: e.zh || '' }))
    .filter(e => e.key)
    .sort((a, b) => a.t - b.t);
  if (!items.length) return null;
  const pairs = [];
  for (const ln of song.lines) {
    const key = normText(ln.text);
    if (!key) continue;
    let best = null, bestD = Infinity;
    for (const e of items) {
      if (e.key !== key) continue;
      const d = e.t - ln.time;
      if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = { words: e.words, zh: e.zh }; }
    }
    if (!best) {
      // 一行 LRC 可能对应外部数据里相邻的几行（或反之被拆开）：在时间附近找能拼出整行的连续片段
      const near = items.filter(e => e.key.length >= 2 && key.includes(e.key) && Math.abs(e.t - ln.time) < 10);
      for (let i = 0; i < near.length && !best; i++) {
        let joined = '';
        const words = [];
        for (let j = i; j < near.length && joined.length < key.length; j++) {
          joined += near[j].key;
          words.push(...near[j].words);
          if (joined === key) { best = { words, zh: '' }; bestD = near[i].t - ln.time; }
        }
      }
    }
    if (best && Math.abs(bestD) < 12) pairs.push({ ln, d: bestD, ...best });
  }
  if (pairs.length < Math.max(2, song.lines.length * 0.3)) return null;
  const med = median(pairs.map(p => p.d));
  if (Math.abs(med) > 5) return { rejected: true, median: med, matched: pairs.length };
  const good = pairs.filter(p => Math.abs(p.d - med) <= 1.5);
  return {
    pairs: good, median: med, matched: good.length, total: song.lines.length,
    ratio: good.length / song.lines.length,
  };
}

function rankCandidates(list, song) {
  const nt = normText(song.title);
  const na = normText(song.artist).split(/[\/,、&]/).filter(Boolean);
  const score = (c) => {
    const t = normText(c.title);
    let s = 0;
    if (t === nt) s += 3; else if (t.includes(nt) || nt.includes(t)) s += 1;
    const a = normText(c.artist);
    if (na.some(x => x && a.includes(x))) s += 2;
    if (/inst|カラオケ|off ?vocal|伴奏/i.test(c.title || '')) s -= 5;
    return s;
  };
  return list.map((c, i) => ({ c, s: score(c), i })).sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.c);
}

export async function fetchWordTiming(song = state.song, { quiet = false } = {}) {
  if (!song?.lines?.length) return null;
  const results = [];
  const notes = [];
  let answered = 0;   // 有来源正常返回（而不是网络错误）才记录「已尝试」，网络故障时下次打开还会重试
  const q = [song.title, song.artist].filter(Boolean).join(' ');
  if (!quiet) setStatus('正在从网易云查找逐字时间轴…');
  try {
    const res = await api.online.neteaseSearch(q);
    answered++;
    for (const c of rankCandidates(res.results || [], song).slice(0, 3)) {
      const data = await api.online.neteaseLyric(c.id);
      const ext = (data.lines || []).filter(l => l.wordTiming?.length)
        .map(l => ({ text: l.text, words: l.wordTiming, zh: l.zh || '' }));
      if (ext.length < 3) { notes.push(`网易云「${c.title}」无逐字数据`); continue; }
      const m = matchTiming(song, ext);
      if (m?.rejected) { notes.push(`网易云「${c.title}」时间相差 ${m.median.toFixed(1)}s，疑似不同版本`); continue; }
      if (m) results.push({ source: '网易云', ...m });
      if (m && m.ratio >= 0.7) break;
    }
  } catch (e) {
    notes.push('网易云：' + e.message);
  }
  if (!results.some(r => r.ratio >= 0.7)) {
    if (!quiet) setStatus('正在从 PetitLyrics 查找逐字时间轴…');
    try {
      const res = await api.online.petit(song.title || '', song.artist || '');
      answered++;
      const m = matchTiming(song, (res.lines || []).map(l => ({ text: l.text, words: l.words })));
      if (m?.rejected) notes.push(`PetitLyrics 时间相差 ${m.median.toFixed(1)}s，疑似不同版本`);
      else if (m) results.push({ source: 'PetitLyrics', ...m });
      else notes.push('PetitLyrics 未匹配');
    } catch (e) {
      notes.push('PetitLyrics：' + e.message);
    }
  }
  const best = results.sort((a, b) => b.matched - a.matched)[0];
  if (state.song !== song) return null;
  if (!best) {
    if (answered) {
      song.syncInfo = { status: 'none', at: Date.now() / 1000, note: notes.join('；') };
      api.patchSong(song.id, { syncInfo: song.syncInfo }).catch(() => {});
    }
    setStatus('');
    if (!quiet) toast('没有找到可用的逐字时间轴：' + (notes.join('；') || '无结果') + '。可用「按音拍估算句尾」+「对齐」校准。', { ms: 6000 });
    return null;
  }
  const patches = [];
  for (const p of best.pairs) {
    const patch = { id: p.ln.id, wordTiming: p.words };
    p.ln.wordTiming = p.words;
    if (!p.ln.zh && p.zh) { patch.zh = p.zh; p.ln.zh = p.zh; renderLineContent(p.ln); }
    patches.push(patch);
  }
  await api.patchLines(song.id, patches, { record: false });
  const coarse = best.pairs.filter(p => isCoarseTiming(p.words)).length;
  song.syncInfo = { status: 'ok', source: best.source, matched: best.matched, total: best.total,
    median: Math.round(best.median * 100) / 100, coarse, at: Date.now() / 1000 };
  await api.patchSong(song.id, { syncInfo: song.syncInfo }).catch(() => {});
  updateSongHeader();
  syncHighlight();
  const msg = `已从${best.source}获取${coarse > best.matched / 2 ? '分段时间（不是真正的逐字数据，段内已按音拍补全）' : '逐字时间轴'}：${best.matched}/${best.total} 句`
    + (Math.abs(best.median) >= 0.3 ? `（与 LRC 平均相差 ${best.median > 0 ? '+' : ''}${best.median.toFixed(2)} 秒，若听感不同步可点「对齐」）` : '');
  setStatus(msg);
  toast(msg, { ms: 4500 });
  return best;
}

export async function clearWordTiming() {
  const song = state.song;
  if (!song) return;
  const lines = song.lines.filter(l => l.wordTiming?.length);
  if (!lines.length) { toast('当前歌曲没有逐字时间轴'); return; }
  await api.patchLines(song.id, lines.map(l => ({ id: l.id, wordTiming: null })), { record: false });
  lines.forEach(l => { l.wordTiming = null; });
  song.syncInfo = { status: 'cleared', at: Date.now() / 1000 };
  await api.patchSong(song.id, { syncInfo: song.syncInfo }).catch(() => {});
  updateSongHeader();
  toast(`已清除 ${lines.length} 句的逐字时间轴，改用音拍估算`);
}

export async function translateMissing() {
  const song = state.song;
  if (!song) return;
  const todo = song.lines.filter(l => !l.zh && l.text.trim());
  if (!todo.length) { toast('所有行都已有中文'); return; }
  setStatus(`机器翻译 ${todo.length} 行…（MyMemory 免费接口，较慢）`);
  const patches = [];
  for (let i = 0; i < todo.length; i += 10) {
    const chunk = todo.slice(i, i + 10);
    try {
      const res = await api.online.translate(chunk.map(l => l.text));
      chunk.forEach((ln, j) => {
        const zh = res.results?.[j] || '';
        if (zh) { ln.zh = zh; renderLineContent(ln); patches.push({ id: ln.id, zh }); }
      });
      setStatus(`机器翻译 ${Math.min(i + 10, todo.length)}/${todo.length}`);
    } catch (e) {
      setStatus('翻译失败：' + e.message, { error: true });
      break;
    }
  }
  if (patches.length) await api.patchLines(song.id, patches, { record: true, kind: 'edit', note: '机器翻译' });
  setStatus(`翻译完成：${patches.length} 行`);
}

export function initSong() {
  bus.on('song:reload', ({ keepPosition } = {}) => state.song && openSong(state.song.id, { keepPosition }));
  bus.on('song:reanalyze', (opts) => analyzeSong(opts));
  bus.on('song:changed', () => updateSongHeader());
}

