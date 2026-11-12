// 入口：加载设置 → 初始化各模块 → 绑定全局交互
import { $, $$, toast, bus, debounce, isTypingTarget, setStatus } from './util.js';
import { state, lineById } from './state.js';
import { api } from './api.js';
import { applyDisplayClasses, renderSong, rerenderAllLines } from './render.js';
import { setUserDict, ensureTokenizer } from './analyzer.js';
import {
  initPlayer, setRate, stepRate, togglePlay, stepLine, toggleLoopCurrent, seekLyric, playLine,
  player, noteUserScroll, startTapSync, tap, untap, tapSync, clearSegment, centerLine, RATES, calibrateOffset,
} from './player.js';
import { initEditor, setEditing, openLineEditor, openFulltext, openHistory, openDictionary } from './editor.js';
import { initSong, openSong, updateSongHeader, translateMissing, analyzeSong, fetchWordTiming, clearWordTiming } from './song.js';
import { initLibrary, refreshLibrary, openImport, openSongInfo, toggleSidebar } from './library.js';
import { initSearch, openSearch, openMarumaru } from './search.js';
import { initStudy, syncStudyVoice } from './study.js';
import { initExport, openExport } from './export.js';
import { speak, stopSpeech } from './tts.js';
import { lineStart, LINE_PREROLL } from './timing.js';
import { init as initAuth } from './auth.js';
import { init as initCloud } from './cloud.js';

// ---------------------------------------------------------------- 设置
const saveSettings = debounce(async (patch) => {
  try { await api.saveSettings(patch); } catch (e) { console.warn('设置保存失败', e); }
}, 400);
let pendingPatch = {};
function patchSettings(patch, { rerender = false } = {}) {
  Object.assign(state.settings, patch);
  pendingPatch = { ...pendingPatch, ...patch };
  const p = pendingPatch;
  saveSettings(p);
  setTimeout(() => { if (pendingPatch === p) pendingPatch = {}; }, 500);
  applyDisplayClasses();
  syncSettingsUI();
  if (rerender) rerenderAllLines();
}
bus.on('settings:patch', (p) => patchSettings(p));

function syncSettingsUI() {
  const s = state.settings;
  $$('#settings [data-set]').forEach(el => {
    const key = el.dataset.set;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else if (el.type === 'radio') el.checked = String(s[key]) === el.value;
    else el.value = String(s[key] ?? '');
  });
  $('#btn-view').textContent = s.viewMode === 'read' ? '阅读' : '跟唱';
  $('#btn-view').title = s.viewMode === 'read' ? '阅读模式：平铺全文（点击切换到跟唱）' : '跟唱模式：高亮并居中当前句（点击切换到阅读）';
}

function initSettingsUI() {
  const RERENDER = new Set(['layout', 'kanaScript', 'longLineChars']);
  $$('#settings [data-set]').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.set;
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'radio') { if (!el.checked) return; val = el.value; }
      else if (el.type === 'range' || el.type === 'number') val = Number(el.value);
      else val = el.value;
      patchSettings({ [key]: val }, { rerender: RERENDER.has(key) });
      if (key === 'preservePitch') $('#audio').preservesPitch = val;
    });
  });
  $('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#settings', '#btn-settings'); });
  $('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#more-menu', '#btn-more'); });
  document.addEventListener('click', (e) => {
    $$('.popover:not([hidden])').forEach(p => {
      if (!p.contains(e.target)) p.hidden = true;
    });
  });
  $('#btn-view').addEventListener('click', () => patchSettings({ viewMode: state.settings.viewMode === 'read' ? 'sing' : 'read' }));
  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.theme || 'auto') + 1) % 3];
    patchSettings({ theme: next });
    toast({ auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' }[next], { ms: 1000 });
  });
}

function togglePopover(sel, anchorSel) {
  const pop = $(sel);
  const willOpen = pop.hidden;
  $$('.popover').forEach(p => { p.hidden = true; });
  if (!willOpen) return;
  pop.hidden = false;
  const a = $(anchorSel).getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${a.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, a.right - w))}px`;
}

// ---------------------------------------------------------------- 歌词区交互
function initLyricsInteractions() {
  const view = $('#lyrics');
  view.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) { runCommand(cmd.dataset.cmd); return; }
    const lineEl = e.target.closest('.line');
    if (!lineEl) return;
    const line = lineById(lineEl.dataset.id);
    if (!line) return;
    const tool = e.target.closest('.tool');
    if (tool) {
      e.stopPropagation();
      const act = tool.dataset.act;
      if (act === 'play') {
        if (player.segment && !player.segment.loop && player.segment.lineId === line.id) { clearSegment(); togglePlay(); }
        else playLine(line);
      } else if (act === 'speak') speak(line.text);
      else if (act === 'edit') openLineEditor(line);
      return;
    }
    if (state.editing) {
      const w = e.target.closest('.jp .w, .ro .rw');
      if (w) bus.emit('word:click', { ev: e, el: lineEl.querySelector(`.jp [data-wi="${w.dataset.wi}"]`) || w });
      return;
    }
    if (window.getSelection()?.toString()) return;
    clearSegment();
    seekLyric(Math.max(0, lineStart(line) - LINE_PREROLL));
    if (state.settings.viewMode !== 'read' || player.mode === 'timer') centerLine(lineEl);
  });
  view.addEventListener('dblclick', (e) => {
    const lineEl = e.target.closest('.line');
    if (!lineEl || e.target.closest('.tool')) return;
    const line = lineById(lineEl.dataset.id);
    if (line) {
      window.getSelection()?.removeAllRanges();
      const w = e.target.closest('[data-wi]');
      openLineEditor(line, { focusWord: w ? Number(w.dataset.wi) : -1 });
    }
  });
  // 悬停：原文词 ↔ 罗马音词 互相高亮
  view.addEventListener('mouseover', (e) => {
    const w = e.target.closest('[data-wi]');
    $$('.hover-pair').forEach(el => el.classList.remove('hover-pair'));
    if (!w) return;
    const lineEl = w.closest('.line');
    lineEl?.querySelectorAll(`[data-wi="${w.dataset.wi}"]`).forEach(el => el.classList.add('hover-pair'));
  });
  view.addEventListener('wheel', noteUserScroll, { passive: true });
  view.addEventListener('touchmove', noteUserScroll, { passive: true });
}

// ---------------------------------------------------------------- 命令
function runCommand(cmd) {
  $$('.popover').forEach(p => { p.hidden = true; });
  switch (cmd) {
    case 'import': return openImport([], { pick: true });
    case 'search': return openSearch({});
    case 'search-bind': return openSearch({ bind: true });
    case 'fulltext': return openFulltext();
    case 'history': return openHistory();
    case 'dictionary': return openDictionary();
    case 'export': return openExport();
    case 'info': return state.song ? openSongInfo() : toast('请先打开一首歌');
    case 'marumaru': return state.song ? openMarumaru() : toast('请先打开一首歌');
    case 'translate': return translateMissing();
    case 'tapsync': return startTapSync();
    case 'wordtiming':
      if (!state.song?.lines?.length) return toast('请先打开有歌词的歌曲');
      if (state.song.timeline !== 'synced') return toast('当前是估算时间轴：先「打轴」或导入带时间的 LRC，再获取逐字时间轴');
      return fetchWordTiming(state.song, { quiet: false });
    case 'clear-wordtiming': return clearWordTiming();
    case 'reanalyze':
      if (!state.song) return;
      if (!confirm('重新自动分析本曲所有「未手动编辑」的行？手动修改过的行保持不变。')) return;
      return analyzeSong({ onlyUnedited: true });
    case 'upload-audio': return $('#si-audio-file').click();
    default: return null;
  }
}

// ---------------------------------------------------------------- 键盘
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (state.appMode !== 'lyrics') return;
    const k = e.key;
    if (tapSync.active) {
      if (k === 't' || k === 'T' || k === 'Enter') { e.preventDefault(); tap(); return; }
      if (k === 'Backspace') { e.preventDefault(); untap(); return; }
    }
    if (k === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepLine(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepLine(1); }
    else if (k === '[') stepRate(-1);
    else if (k === ']') stepRate(1);
    else if (k === 'r' || k === 'R') toggleLoopCurrent();
    else if (k === 'a' || k === 'A') calibrateOffset();
    else if (k === 'e' || k === 'E') setEditing(!state.editing);
    else if (k === 'Escape' && state.editing) setEditing(false);
  });
}

// ---------------------------------------------------------------- 应用模式（歌词 / 学习）
function setAppMode(mode) {
  $$('.popover').forEach(p => { p.hidden = true; });
  state.appMode = mode;
  document.body.dataset.app = mode;
  $$('button[data-app]').forEach(b => b.classList.toggle('active', b.dataset.app === mode));
  if (mode === 'study') { stopSpeech(); ensureTokenizer().catch(() => {}); }
}

// ---------------------------------------------------------------- 云同步 UI
function initCloudUI() {
  bus.on('cloud:config-applied', ({ config } = {}) => {
    if (!config) return;
    Object.assign(state.settings, config);
    applyDisplayClasses();
    syncSettingsUI();
    setRate(state.settings.playbackRate || 1, { save: false });
    syncStudyVoice();
    const audio = $('#audio');
    if (audio) audio.preservesPitch = !!state.settings.preservePitch;
  });
  bus.on('cloud:dict-applied', ({ dict } = {}) => {
    if (dict) setUserDict(dict);
  });
  bus.on('cloud:songs-applied', ({ ids } = {}) => {
    refreshLibrary().catch(() => {});
    if (state.song && Array.isArray(ids) && ids.includes(state.song.id)) {
      openSong(state.song.id).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------- 启动
async function boot() {
  try {
    state.settings = await api.settings();
  } catch (e) {
    state.settings = {};
    toast('无法连接后端：' + e.message, { error: true, ms: 6000 });
  }
  applyDisplayClasses();
  initSettingsUI();
  syncSettingsUI();
  initPlayer();
  initEditor();
  initSong();
  initLibrary();
  initSearch();
  initStudy();
  initExport();
  initLyricsInteractions();
  initKeyboard();
  initCloudUI();
  initCloud(); // 绑定云同步监听（须在 initAuth 之前，确保收到 auth:changed）
  initAuth().catch(() => {}); // 恢复会话（异步，不阻塞启动）

  const rateSel = $('#rate-select');
  rateSel.replaceChildren(...RATES.map(r => new Option(`${r}×`, String(r))));
  setRate(state.settings.playbackRate || 1, { save: false });
  syncStudyVoice();
  $('#study-voice').addEventListener('change', (e) => patchSettings({ voice: e.target.value }));

  $$('[data-cmd]').forEach(el => {
    if (el.closest('#lyrics')) return;
    if (el.dataset.cmd === 'import') return; // 已在 library.js 绑定
    el.addEventListener('click', (e) => { e.stopPropagation(); runCommand(el.dataset.cmd); });
  });
  $('#btn-edit-mode').addEventListener('click', () => setEditing(!state.editing));
  $$('button[data-app]').forEach(b => b.addEventListener('click', () => setAppMode(b.dataset.app)));

  bus.on('song:closed', () => { renderSong(); updateSongHeader(); });

  try { setUserDict(await api.dictionary()); } catch {}
  await refreshLibrary();
  renderSong();
  updateSongHeader();
  let last = null;
  try { last = localStorage.getItem('jls-last-song'); } catch {}
  if (!(last && state.songs.some(s => s.id === last))) last = state.songs[0]?.id || null;
  if (last) await openSong(last);
  if (window.matchMedia('(min-width: 901px)').matches) toggleSidebar(true);
  setAppMode('lyrics');
  // 空闲时预热词典，首次分析更快
  setTimeout(() => ensureTokenizer().then(() => { if (!state.song) setStatus('词典已就绪'); }).catch(() => {}), 800);
}

boot();
