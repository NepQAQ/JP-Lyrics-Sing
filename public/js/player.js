// 播放控制：本地音频 / 计时器两种音源、全局倍速、歌词同步高亮、逐字 KTV 进度、单句播放/循环、打轴。
import { $, $$, fmtTime, toast, bus, setStatus, debounce } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { renderLineContent } from './render.js';
import { lineStart, segmentRange, karaokeProgress, weightedChars } from './timing.js';

export const RATES = [0.5, 0.6, 0.75, 0.85, 1, 1.25, 1.5];
const audio = () => $('#audio');

export const player = {
  mode: 'audio',          // audio | timer
  rate: 1,
  timerRunning: false,
  timerBase: 0,           // 计时器：暂停时累计的歌词时间
  timerStartedAt: 0,      // performance.now()
  segment: null,          // {lineId, start, end, loop}
  hasAudio: false,
};

// ------------------------------------------------------------ 时间
const offset = () => Number(state.song?.offset) || 0;

/** 当前「歌词时间」（秒）：音频时间 − 偏移 */
export function lyricTime() {
  if (player.mode === 'timer') {
    if (!player.timerRunning) return player.timerBase;
    return player.timerBase + (performance.now() - player.timerStartedAt) / 1000 * player.rate;
  }
  return (audio().currentTime || 0) - offset();
}

export function seekLyric(t) {
  t = Math.max(0, t);
  if (player.mode === 'timer') {
    player.timerBase = t;
    if (player.timerRunning) player.timerStartedAt = performance.now();
  } else if (player.hasAudio) {
    audio().currentTime = Math.max(0, t + offset());
  }
  syncHighlight(true);
  updateTimeUI();
}

export function isPlaying() {
  return player.mode === 'timer' ? player.timerRunning : (player.hasAudio && !audio().paused && !audio().ended);
}

export function play() {
  if (player.mode === 'timer') {
    if (!player.timerRunning) {
      player.timerRunning = true;
      player.timerStartedAt = performance.now();
    }
    startLoop();
  } else if (player.hasAudio) {
    audio().play().catch(e => toast('播放失败：' + e.message, { error: true }));
  } else {
    toast('这首歌还没有音频：可上传音频，或切换到「计时」音源配合外部播放器');
    return;
  }
  updatePlayUI();
}

export function pause() {
  if (player.mode === 'timer') {
    if (player.timerRunning) {
      player.timerBase = lyricTime();
      player.timerRunning = false;
    }
  } else {
    audio().pause();
  }
  updatePlayUI();
}

export const togglePlay = () => (isPlaying() ? pause() : play());

// ------------------------------------------------------------ 倍速
export function setRate(rate, { save = true } = {}) {
  rate = Math.min(2, Math.max(0.25, Number(rate) || 1));
  if (player.mode === 'timer' && player.timerRunning) {
    player.timerBase = lyricTime();
    player.timerStartedAt = performance.now();
  }
  player.rate = rate;
  const a = audio();
  a.playbackRate = rate;
  a.defaultPlaybackRate = rate;
  a.preservesPitch = state.settings.preservePitch !== false;
  $$('[data-rate]').forEach(b => b.classList.toggle('active', Number(b.dataset.rate) === rate));
  const sel = $('#rate-select');
  if (sel) sel.value = String(rate);
  $('#rate-label').textContent = `${rate}×`;
  if (save) bus.emit('settings:patch', { playbackRate: rate });
}

export function stepRate(dir) {
  const i = RATES.findIndex(r => r >= player.rate - 1e-6);
  const next = RATES[Math.min(RATES.length - 1, Math.max(0, (i < 0 ? RATES.length - 1 : i) + dir))];
  setRate(next);
  toast(`播放速度 ${next}×`, { ms: 900 });
}

// ------------------------------------------------------------ 音源
let audioLoadToken = 0;
export function loadSongAudio(song) {
  const a = audio();
  const token = ++audioLoadToken;
  clearSegment();
  pause();
  if (song?.audio) {
    // 音频以 Blob 存于 IndexedDB，object URL 异步生成；期间先进入音频模式
    player.hasAudio = true;
    setMode('audio');
    const bust = String(song.audio.size || '') + (song.updatedAt || '');
    api.audioUrl(song.id, bust).then((url) => {
      if (token !== audioLoadToken) return; // 已切换到其他歌曲
      a.src = url;
      a.load();
      a.playbackRate = player.rate;
      updateTimeUI();
      updatePlayUI();
    }).catch(() => {
      if (token !== audioLoadToken) return;
      player.hasAudio = false;
      setMode(song?.lines?.length ? 'timer' : 'audio', { quiet: true });
      updateTimeUI();
      updatePlayUI();
    });
  } else {
    a.removeAttribute('src');
    a.load();
    player.hasAudio = false;
    setMode(song?.lines?.length ? 'timer' : 'audio', { quiet: true });
  }
  player.timerBase = 0;
  player.timerRunning = false;
  a.playbackRate = player.rate;
  updateTimeUI();
  updatePlayUI();
}

export function setMode(mode, { quiet = false } = {}) {
  if (mode === 'audio' && !player.hasAudio && !quiet) {
    toast('当前歌曲没有音频，请先上传音频');
    mode = 'timer';
  }
  if (player.mode !== mode) pause();
  player.mode = mode;
  document.body.dataset.source = mode;
  $$('button[data-source]').forEach(b => b.classList.toggle('active', b.dataset.source === mode));
  updateTimeUI();
  updatePlayUI();
}

// ------------------------------------------------------------ 高亮同步 & KTV
let rafId = null;
let lastCenterAt = 0;

function startLoop() {
  if (rafId) return;
  const tick = () => {
    rafId = null;
    syncHighlight();
    checkSegment();
    updateTimeUI();
    if (player.mode === 'timer') updatePlayUI();
    if (isPlaying()) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function findIdx(t) {
  const lines = state.song?.lines || [];
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStart(lines[mid]) <= t + 1e-3) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

export function syncHighlight(forceCenter = false) {
  const lines = state.song?.lines;
  if (!lines?.length) return;
  const t = lyricTime();
  const idx = findIdx(t);
  if (idx !== state.activeIdx) {
    const prev = lines[state.activeIdx];
    if (prev?._el) {
      prev._el.classList.remove('active');
      clearKaraoke(prev);
    }
    state.activeIdx = idx;
    const cur = lines[idx];
    if (cur?._el) {
      cur._el.classList.add('active');
      if (shouldCenter() || forceCenter) centerLine(cur._el);
    }
    bus.emit('line:active', idx);
  } else if (idx >= 0 && shouldCenter() && performance.now() - lastCenterAt > 1500) {
    centerLine(lines[idx]._el, 'smooth', true);
  }
  if (idx >= 0) updateKaraoke(lines[idx], t);
}

function shouldCenter() {
  return state.settings.viewMode !== 'read' && isPlaying() && !state.editing && !userScrolling;
}

let userScrolling = false;
let userScrollTimer = null;
export function noteUserScroll() {
  userScrolling = true;
  clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(() => { userScrolling = false; }, 2500);
}

export function centerLine(el, behavior = 'smooth', onlyIfFar = false) {
  if (!el) return;
  lastCenterAt = performance.now();
  const view = $('#lyrics');
  const rect = el.getBoundingClientRect();
  const vr = view.getBoundingClientRect();
  const target = vr.height * 0.38;
  const delta = rect.top - vr.top - target + rect.height / 2;
  if (onlyIfFar && Math.abs(delta) < vr.height * 0.18) return;
  view.scrollTo({ top: Math.max(0, view.scrollTop + delta), behavior });
}

function buildKaraoke(container, skipSelector) {
  if (container._karaoke) return container._karaoke;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  const chars = [];
  for (const tn of nodes) {
    const frag = document.createDocumentFragment();
    for (const ch of tn.nodeValue) {
      const span = document.createElement('span');
      span.className = 'kc';
      span.textContent = ch;
      frag.append(span);
      chars.push(span);
    }
    tn.parentNode.replaceChild(frag, tn);
  }
  container._karaoke = { chars, sung: 0 };
  return container._karaoke;
}

function applySung(k, n) {
  const target = Math.max(0, Math.min(k.chars.length, Math.floor(n)));
  if (target === k.sung) return;
  const lo = Math.min(k.sung, target), hi = Math.max(k.sung, target);
  for (let i = lo; i < hi; i++) k.chars[i].classList.toggle('sung', i < target);
  k.sung = target;
}

function updateKaraoke(line, t) {
  if (!line._el || state.settings.viewMode === 'read' && !isPlaying()) return;
  const jp = line._el.querySelector('.jp');
  if (!Array.isArray(line.words)) return;
  const lines = state.song.lines;
  const kj = buildKaraoke(jp, 'rt, .w-ro');
  const { p, weighted } = karaokeProgress(lines, lines.indexOf(line), t);
  // 无逐字时间轴时按音拍加权（汉字按读音拍数），有逐字时间轴时按字
  applySung(kj, weighted ? weightedChars(line, p, kj.chars.length) : p * kj.chars.length);
  const ro = line._el.querySelector('.ro');
  if (ro && ro.textContent.trim()) {
    const kr = buildKaraoke(ro, '.ro-brk, .ro-link');
    applySung(kr, p * kr.chars.length);
  }
}

function clearKaraoke(line) {
  const jp = line._el?.querySelector('.jp');
  const ro = line._el?.querySelector('.ro');
  if (jp?._karaoke || ro?._karaoke) renderLineContent(line);
}

// ------------------------------------------------------------ 单句播放 / 循环
export function lineRange(line) {
  const lines = state.song.lines;
  return segmentRange(lines, lines.indexOf(line));
}

export function playLine(line, { loop = false } = {}) {
  if (!line) return;
  if (player.mode === 'audio' && !player.hasAudio) {
    toast('没有音频，无法播放原曲片段');
    return;
  }
  const { start, end } = lineRange(line);
  player.segment = { lineId: line.id, start, end, loop };
  seekLyric(start);
  play();
  updateSegmentUI();
}

export function clearSegment() {
  player.segment = null;
  updateSegmentUI();
}

export function toggleLoopCurrent() {
  if (player.segment?.loop) {
    clearSegment();
    toast('已关闭单句循环', { ms: 1000 });
    return;
  }
  const lines = state.song?.lines || [];
  const line = lines[state.activeIdx >= 0 ? state.activeIdx : 0];
  if (!line) return;
  const { start, end } = lineRange(line);
  player.segment = { lineId: line.id, start, end, loop: true };
  updateSegmentUI();
  toast(`单句循环：第 ${lines.indexOf(line) + 1} 句`, { ms: 1200 });
  if (!isPlaying()) { seekLyric(start); play(); }
}

function checkSegment() {
  const seg = player.segment;
  if (!seg) return;
  const t = lyricTime();
  if (t >= seg.end - 0.02) {
    if (seg.loop) {
      seekLyric(seg.start);
    } else {
      pause();
      seekLyric(seg.end - 0.04);
      clearSegment();
    }
  } else if (t < seg.start - 1.5) {
    // 用户手动拖到了片段之前：退出片段模式
    clearSegment();
  }
}

function updateSegmentUI() {
  const seg = player.segment;
  $('#btn-loop').classList.toggle('active', !!seg?.loop);
  $$('.line.segment').forEach(el => el.classList.remove('segment'));
  if (seg) {
    const el = state.song?.lines?.find(l => l.id === seg.lineId)?._el;
    el?.classList.add('segment');
  }
  $$('.line .tool[data-act="play"]').forEach(btn => {
    const id = btn.closest('.line')?.dataset.id;
    const on = !!seg && !seg.loop && seg.lineId === id;
    btn.classList.toggle('active', on);
  });
}

export function stepLine(dir) {
  const lines = state.song?.lines || [];
  if (!lines.length) return;
  const cur = state.activeIdx;
  let next;
  if (dir < 0) {
    // 当前句已经唱了 1.2s 以上时，「上一句」先回到本句开头
    next = (cur >= 0 && lyricTime() - lineStart(lines[cur]) > 1.2) ? cur : Math.max(0, cur - 1);
  } else {
    next = Math.min(lines.length - 1, cur + 1);
  }
  if (player.segment?.loop) {
    const { start, end } = lineRange(lines[next]);
    player.segment = { lineId: lines[next].id, start, end, loop: true };
    updateSegmentUI();
  }
  seekLyric(Math.max(0, lineStart(lines[next]) - 0.05));
  centerLine(lines[next]._el);
}

// ------------------------------------------------------------ 偏移（整体对齐歌词与音频）
const saveOffset = debounce(async (id, v) => {
  try { await api.patchSong(id, { offset: v }); } catch (err) { toast('偏移保存失败：' + err.message, { error: true }); }
}, 500);

export function setOffset(v, { quiet = false } = {}) {
  if (!state.song) return;
  v = Math.round(Math.max(-30, Math.min(30, v)) * 100) / 100;
  state.song.offset = v;
  $('#offset-input').value = String(v);
  if (player.segment) clearSegment();
  syncHighlight();
  saveOffset(state.song.id, v);
  if (!quiet) toast(`歌词偏移 ${v > 0 ? '+' : ''}${v.toFixed(2)} 秒（正数 = 歌词延后）`, { ms: 1200 });
}

export function nudgeOffset(d) {
  setOffset((Number(state.song?.offset) || 0) + d);
}

/**
 * 一键对齐：播放时，在听到某一句「刚开始唱」的瞬间按下（快捷键 A），
 * 取时间上最接近的一句，把偏移设为「当前音频时间 − 该句开始时间 − 反应时间」。
 */
export function calibrateOffset() {
  const lines = state.song?.lines || [];
  if (!lines.length) return;
  if (player.mode !== 'audio' || !player.hasAudio) { toast('对齐需要本地音频'); return; }
  if (!isPlaying()) { toast('先播放，在某一句刚开始唱时点「对齐」（快捷键 A）', { ms: 3000 }); return; }
  const REACTION = 0.18;
  const at = audio().currentTime - REACTION;
  const cur = offset();
  let best = -1, gap = Infinity;
  lines.forEach((ln, i) => {
    const d = Math.abs(lineStart(ln) + cur - at);
    if (d < gap) { gap = d; best = i; }
  });
  if (best < 0 || gap > 8) { toast('附近没有可对齐的歌词行', { error: true }); return; }
  const v = at - lineStart(lines[best]);
  if (Math.abs(v - cur) > 4 && !confirm(`将以第 ${best + 1} 句「${lines[best].text}」对齐，偏移从 ${cur.toFixed(2)} 改为 ${v.toFixed(2)} 秒，变化较大，确定吗？`)) return;
  setOffset(v, { quiet: true });
  toast(`已以第 ${best + 1} 句对齐：偏移 ${v > 0 ? '+' : ''}${v.toFixed(2)} 秒`, { ms: 2200 });
}

// ------------------------------------------------------------ 打轴（给纯文本歌词打时间）
export const tapSync = { active: false, idx: 0, stamps: [] };

export function startTapSync() {
  const lines = state.song?.lines || [];
  if (!lines.length) { toast('没有歌词可打轴'); return; }
  if (!player.hasAudio) { toast('打轴需要先上传音频'); return; }
  setMode('audio');
  tapSync.active = true;
  tapSync.idx = 0;
  tapSync.stamps = [];
  $('#tapbar').hidden = false;
  document.body.classList.add('tapping');
  pause();
  seekLyric(0);
  updateTapUI();
  toast('打轴：播放后，在每一句开始唱时按 T（或点「打点」）');
}

export function tap() {
  if (!tapSync.active) return;
  const lines = state.song.lines;
  if (tapSync.idx >= lines.length) return;
  tapSync.stamps[tapSync.idx] = Math.max(0, (audio().currentTime || 0) - offset());
  tapSync.idx++;
  updateTapUI();
  if (tapSync.idx >= lines.length) toast('全部打完，点「完成」保存');
}

export function untap() {
  if (!tapSync.active || tapSync.idx === 0) return;
  tapSync.idx--;
  tapSync.stamps.length = tapSync.idx;
  const t = tapSync.stamps[tapSync.idx - 1] ?? 0;
  audio().currentTime = Math.max(0, t + offset() - 1);
  updateTapUI();
}

export async function finishTapSync(save = true) {
  const lines = state.song?.lines || [];
  tapSync.active = false;
  $('#tapbar').hidden = true;
  document.body.classList.remove('tapping');
  $$('.line.tap-next').forEach(el => el.classList.remove('tap-next'));
  if (!save || !tapSync.stamps.length) return;
  // 未打到的行：沿用最后一个间隔往后排
  const patches = [];
  let last = 0;
  lines.forEach((ln, i) => {
    let t = tapSync.stamps[i];
    if (!Number.isFinite(t)) t = last + 3;
    last = t;
    patches.push({ id: ln.id, time: Math.round(t * 1000) / 1000, end: null });
  });
  try {
    const res = await api.patchLines(state.song.id, patches, { record: true, kind: 'timing', note: '打轴' });
    await api.patchSong(state.song.id, { timeline: 'synced' });
    bus.emit('song:reload', { keepPosition: true });
    toast(`已保存 ${tapSync.stamps.length} 句时间`);
    return res;
  } catch (e) {
    toast('保存失败：' + e.message, { error: true });
  }
}

function updateTapUI() {
  const lines = state.song?.lines || [];
  $('#tap-progress').textContent = `${Math.min(tapSync.idx, lines.length)}/${lines.length}`;
  const next = lines[tapSync.idx];
  $('#tap-next').textContent = next ? next.text : '（已全部打完）';
  $$('.line.tap-next').forEach(el => el.classList.remove('tap-next'));
  if (next?._el) {
    next._el.classList.add('tap-next');
    centerLine(next._el);
  }
}

// ------------------------------------------------------------ UI
function updateTimeUI() {
  const cur = $('#time-cur');
  const dur = $('#time-dur');
  const bar = $('#seek');
  if (player.mode === 'timer') {
    cur.textContent = fmtTime(lyricTime());
    const last = state.song?.lines?.at?.(-1);
    const total = last ? last.time + 5 : 0;
    dur.textContent = total ? fmtTime(total, 0) : '--:--';
    if (!bar._dragging) bar.value = total ? String(Math.min(1000, lyricTime() / total * 1000)) : '0';
  } else {
    const a = audio();
    const d = a.duration;
    cur.textContent = fmtTime(a.currentTime || 0);
    dur.textContent = Number.isFinite(d) ? fmtTime(d, 0) : '--:--';
    if (!bar._dragging) bar.value = Number.isFinite(d) && d > 0 ? String((a.currentTime / d) * 1000) : '0';
  }
}

function updatePlayUI() {
  const playing = isPlaying();
  const btn = $('#btn-play');
  btn.innerHTML = playing
    ? '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  btn.setAttribute('aria-label', playing ? '暂停' : '播放');
  document.body.classList.toggle('playing', playing);
}

export function initPlayer() {
  const a = audio();
  a.addEventListener('play', () => { startLoop(); updatePlayUI(); });
  a.addEventListener('pause', () => { updatePlayUI(); syncHighlight(); });
  a.addEventListener('ended', updatePlayUI);
  a.addEventListener('timeupdate', () => { if (!isPlaying()) { syncHighlight(); updateTimeUI(); } });
  a.addEventListener('seeked', () => { syncHighlight(); updateTimeUI(); });
  a.addEventListener('loadedmetadata', () => {
    a.playbackRate = player.rate;
    a.preservesPitch = state.settings.preservePitch !== false;
    updateTimeUI();
  });
  a.addEventListener('error', () => {
    if (!a.getAttribute('src')) return;
    player.hasAudio = false;
    setStatus('音频无法播放：浏览器可能不支持该格式（可换 mp3 / m4a）', { error: true });
  });

  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', () => stepLine(-1));
  $('#btn-next').addEventListener('click', () => stepLine(1));
  $('#btn-loop').addEventListener('click', toggleLoopCurrent);
  $('#btn-back5').addEventListener('click', () => seekLyric(lyricTime() - 3));

  const bar = $('#seek');
  bar.addEventListener('input', () => {
    bar._dragging = true;
    const frac = Number(bar.value) / 1000;
    if (player.mode === 'timer') {
      const last = state.song?.lines?.at?.(-1);
      seekLyric(frac * (last ? last.time + 5 : 0));
    } else if (Number.isFinite(a.duration)) {
      a.currentTime = frac * a.duration;
    }
  });
  bar.addEventListener('change', () => { bar._dragging = false; clearSegment(); });

  $('#rate-select').addEventListener('change', (e) => setRate(Number(e.target.value)));
  $$('button[data-source]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.source)));

  $('#offset-input').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (state.song && Number.isFinite(v)) setOffset(v);
  });
  $('#btn-offset-minus').addEventListener('click', () => nudgeOffset(-0.1));
  $('#btn-offset-plus').addEventListener('click', () => nudgeOffset(0.1));
  $('#btn-offset-align').addEventListener('click', calibrateOffset);

  $('#btn-tap').addEventListener('click', tap);
  $('#btn-untap').addEventListener('click', untap);
  $('#btn-tap-done').addEventListener('click', () => finishTapSync(true));
  $('#btn-tap-cancel').addEventListener('click', () => finishTapSync(false));
  $('#btn-tap-play').addEventListener('click', togglePlay);

  setInterval(() => { if (player.mode === 'timer' && !isPlaying()) updateTimeUI(); }, 500);
  updatePlayUI();
}
