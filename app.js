/* 日语跟唱 App - main logic */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const audio = $('#audio');
const lyricsView = $('#lyrics-view');
const studyView = $('#study-view');
const studyInput = $('#study-input');
const studyVoiceSelect = $('#study-voice-select');
const studyResults = $('#study-results');
const studyStatus = $('#study-status');
const statusEl = $('#status');
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const assistActions = $('#assist-actions');
let searchRequestId = 0;
let kanogomaSearchRequestId = 0;
let latestKanogomaCandidates = [];
let latestKanogomaQuery = '';

let kuroshiro = null;
let kuroshiroReady = null;
let lrcLines = [];
let activeIdx = -1;
let translationCache = new Map();
const assistSearchState = {
  title: '',
  artist: '',
  kanogoma: { status: 'idle', message: '', count: 0 },
};

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

/* ---------------- App Mode (lyrics vs study) ---------------- */
const APP_MODE_KEY = 'jplrc-app-mode';
const brandModeMenu = $('#brand-mode-menu');
function applyAppMode(mode) {
  const next = mode === 'study' ? 'study' : 'lyrics';
  document.body.classList.toggle('app-study', next === 'study');
  if (studyView) studyView.hidden = next !== 'study';
  const btn = $('#btn-app-mode');
  if (btn) {
    btn.querySelector('.brand-mode-text').textContent = next === 'study' ? '日语学习' : '日语跟唱';
    btn.title = next === 'study' ? '当前：日语学习模式 · 点击切回歌词' : '当前：歌词模式 · 点击切换';
    btn.setAttribute('aria-label', next === 'study' ? '切回歌词模式' : '切换歌词与日语学习模式');
  }
  $$('.brand-mode-option').forEach(opt => {
    const isActive = opt.dataset.mode === next;
    opt.classList.toggle('active', isActive);
    opt.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  if (next === 'study') {
    audio.pause();
    if (player.mode === 'timer' && player.timerRunning) player.timerToggle();
  }
  stopStudySpeech();
  requestAnimationFrame(syncPanelToggleButton);
  localStorage.setItem(APP_MODE_KEY, next);
}

function setBrandModeMenuOpen(open) {
  if (!brandModeMenu) return;
  brandModeMenu.hidden = !open;
  $('#btn-app-mode')?.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('brand-mode-open', open);
}

$('#btn-app-mode')?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  setBrandModeMenuOpen(brandModeMenu?.hidden !== false);
});
$$('.brand-mode-option').forEach(opt => {
  opt.addEventListener('click', () => {
    applyAppMode(opt.dataset.mode);
    setBrandModeMenuOpen(false);
  });
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') setBrandModeMenuOpen(false);
});
document.addEventListener('click', (ev) => {
  if (!brandModeMenu || brandModeMenu.hidden) return;
  if ($('#brand-mode')?.contains(ev.target) || brandModeMenu.contains(ev.target)) return;
  setBrandModeMenuOpen(false);
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
  if (next === 'read') {
    // 进入阅读模式时自动启动罗马音标记，无需展开面板勾选
    setRomajiMarkupMode(true, false);
  } else {
    setRomajiMarkupMode(false, false);
    applyMode(next);
  }
});

/* Show/hide player bar based on whether any audio source is active. */
function setPlayerVisible(visible) {
  document.body.classList.toggle('no-player', !visible);
}
setPlayerVisible(false); // default: no source

/* ---------------- UI helpers ---------------- */
function setStatus(msg, isError = false, action = null) {
  statusEl.replaceChildren();
  const text = document.createElement('span');
  text.className = 'status-text';
  text.textContent = msg || '';
  statusEl.appendChild(text);

  if (action?.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    statusEl.appendChild(btn);
  }

  statusEl.classList.toggle('error', !!isError);
}

function setStudyStatus(msg, isError = false) {
  if (!studyStatus) return;
  studyStatus.textContent = msg || '';
  studyStatus.classList.toggle('error', !!isError);
}

function resetAssistActions() {
  kanogomaSearchRequestId++;
  latestKanogomaCandidates = [];
  latestKanogomaQuery = '';
  assistSearchState.title = '';
  assistSearchState.artist = '';
  assistSearchState.kanogoma = { status: 'idle', message: '', count: 0 };
  renderAssistActions();
}

function startAssistActionsForLyric(item) {
  assistSearchState.title = item?.trackName || '';
  assistSearchState.artist = item?.artistName || '';
  assistSearchState.kanogoma = { status: 'loading', message: '', count: 0 };
  renderAssistActions();
}

function formatAssistState(state) {
  switch (state.status) {
    case 'loading': return '搜索中';
    case 'ready': return `已就绪${state.count ? ` ${state.count} 条` : ''}`;
    case 'empty': return '无结果';
    case 'error': return '不可用';
    default: return '待命';
  }
}

function applyAssistButtonState(button, state, labels) {
  button.textContent = labels[state.status] || labels.idle;
  button.dataset.state = state.status;
  button.disabled = state.status !== 'ready';
}

function renderAssistActions() {
  if (!assistActions) return;
  const meta = $('#assist-actions-meta');
  const kanogomaBtn = $('#btn-apply-kanogoma');
  const hasContext = !!(
    assistSearchState.title
    || assistSearchState.artist
    || assistSearchState.kanogoma.status !== 'idle'
  );
  assistActions.hidden = !hasContext;
  if (!hasContext || !meta || !kanogomaBtn) return;

  const label = [assistSearchState.title, assistSearchState.artist].filter(Boolean).join(' · ') || '当前歌词';
  meta.textContent = `${label} · Kanogoma${formatAssistState(assistSearchState.kanogoma)}`;

  applyAssistButtonState(kanogomaBtn, assistSearchState.kanogoma, {
    idle: 'Kanogoma 待命',
    loading: 'Kanogoma 搜索中...',
    ready: assistSearchState.kanogoma.count > 1 ? `应用 Kanogoma 注音 (${assistSearchState.kanogoma.count})` : '应用 Kanogoma 注音',
    empty: 'Kanogoma 未找到',
    error: 'Kanogoma 暂不可用',
  });
  kanogomaBtn.title = latestKanogomaCandidates[0]
    ? `将优先应用：${latestKanogomaCandidates[0].title}${latestKanogomaCandidates[0].artist ? ` - ${latestKanogomaCandidates[0].artist}` : ''}`
    : '';
}

function setPanelCollapsed(collapsed) {
  $('#panel').classList.toggle('hidden', collapsed);
  const btn = $('#btn-toggle-panel');
  if (!btn) return;
  btn.innerHTML = collapsed
    ? '<span class="icon-btn-glyph icon-panel-toggle" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 10L12 15L17 10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
    : '<span class="icon-btn-glyph icon-panel-toggle" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 14L12 9L17 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  btn.setAttribute('aria-label', collapsed ? '展开控制面板' : '收起控制面板');
  btn.title = collapsed ? '展开控制面板' : '收起控制面板';
  syncCollapsedTimerHud();
}

function setStudyPanelCollapsed(collapsed) {
  $('.study-panel')?.classList.toggle('hidden', collapsed);
  const btn = $('#btn-toggle-panel');
  if (!btn) return;
  btn.innerHTML = collapsed
    ? '<span class="icon-btn-glyph icon-panel-toggle" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 10L12 15L17 10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
    : '<span class="icon-btn-glyph icon-panel-toggle" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 14L12 9L17 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  btn.setAttribute('aria-label', collapsed ? '展开日语学习面板' : '收起日语学习面板');
  btn.title = collapsed ? '展开日语学习面板' : '收起日语学习面板';
}

function syncPanelToggleButton() {
  if (document.body.classList.contains('app-study')) {
    setStudyPanelCollapsed($('.study-panel')?.classList.contains('hidden') || false);
  } else {
    setPanelCollapsed($('#panel')?.classList.contains('hidden') || false);
  }
}

function hasDirectPlaybackSource() {
  if (player.mode === 'audio') return !!audio.src;
  if (player.mode === 'yt') return true;
  return false;
}

function syncCollapsedTimerHud() {
  const panelCollapsed = $('#panel')?.classList.contains('hidden');
  const singMode = !document.body.classList.contains('mode-read');
  if (!panelCollapsed || !singMode) return;
  if (player.mode === 'timer') {
    showTimerHud();
    return;
  }
  if (!hasDirectPlaybackSource()) {
    switchToTimerMode();
  }
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

/* ---------------- Romaji annotations ---------------- */
const ROMAJI_ANNOTATIONS_KEY = 'jplrc-romaji-annotations';
const romajiMarkupToggle = $('#enable-romaji-markup');
const annotationPopover = $('#romaji-annotation-popover');
const annotationNoteInput = $('#annotation-note');
let romajiAnnotations = {};
let annotationSelection = null;
let selectedAnnotationType = 'phrase';
let annotationAnchorRect = null;

try {
  romajiAnnotations = JSON.parse(localStorage.getItem(ROMAJI_ANNOTATIONS_KEY) || '{}');
} catch {
  romajiAnnotations = {};
}

function getRomajiAnnotationKey(sourceText, romajiText) {
  return `${sourceText || ''}\u241e${romajiText || ''}`;
}

function saveRomajiAnnotations() {
  localStorage.setItem(ROMAJI_ANNOTATIONS_KEY, JSON.stringify(romajiAnnotations));
}

function renderRomajiText(el, text, sourceText = '') {
  if (!el) return;
  const romajiText = String(text || '');
  const key = getRomajiAnnotationKey(sourceText, romajiText);
  el.dataset.annotationKey = key;
  el.dataset.annotationSource = sourceText || '';
  el.classList.remove('has-romaji-note');

  const annotations = (romajiAnnotations[key] || [])
    .map(item => item.type === 'accent' ? { ...item, type: 'tone4' } : item)
    .filter(item => {
      if (!Number.isInteger(item.start) || !Number.isInteger(item.end)) return false;
      if (item.type === 'break') {
        return item.start === item.end && item.start >= 0 && item.start <= romajiText.length;
      }
      return item.start >= 0 && item.end <= romajiText.length && item.end > item.start;
    });
  if (!annotations.length) {
    el.textContent = romajiText;
    return;
  }

  const fragment = document.createDocumentFragment();
  const breakPositions = [...new Set(annotations
    .filter(item => item.type === 'break')
    .map(item => item.start))].sort((a, b) => a - b);
  const rangeAnnotations = annotations
    .filter(item => item.type !== 'break')
    .sort((a, b) => a.start - b.start);
  const renderedBreaks = new Set();

  function appendTextWithBreaks(parent, start, end, includeEnd = false) {
    let textCursor = start;
    for (const position of breakPositions) {
      if (renderedBreaks.has(position) || position < start || position > end) continue;
      if (position === end && !includeEnd) continue;
      if (position > textCursor) {
        parent.appendChild(document.createTextNode(romajiText.slice(textCursor, position)));
      }
      const breakpoint = document.createElement('span');
      breakpoint.className = 'romaji-break';
      breakpoint.dataset.position = position;
      breakpoint.setAttribute('aria-label', '中断');
      breakpoint.title = '中断';
      parent.appendChild(breakpoint);
      renderedBreaks.add(position);
      textCursor = position;
    }
    if (textCursor < end) {
      parent.appendChild(document.createTextNode(romajiText.slice(textCursor, end)));
    }
  }

  let cursor = 0;
  for (const annotation of rangeAnnotations) {
    if (annotation.start < cursor) continue;
    if (annotation.start > cursor) {
      appendTextWithBreaks(fragment, cursor, annotation.start);
    }
    const mark = document.createElement('span');
    mark.className = `romaji-mark romaji-mark-${annotation.type}`;
    mark.dataset.start = annotation.start;
    mark.dataset.end = annotation.end;
    if (/^tone[1-4]$/.test(annotation.type)) {
      const tone = annotation.type.slice(-1);
      mark.dataset.tone = tone;
      mark.title = `${tone} 声`;
    }
    if (annotation.type === 'note' && annotation.note) {
      mark.dataset.note = annotation.note;
      mark.title = annotation.note;
      el.classList.add('has-romaji-note');
    }
    appendTextWithBreaks(mark, annotation.start, annotation.end, true);
    fragment.appendChild(mark);
    cursor = annotation.end;
  }
  if (cursor < romajiText.length) {
    appendTextWithBreaks(fragment, cursor, romajiText.length, true);
  } else {
    appendTextWithBreaks(fragment, cursor, cursor, true);
  }
  el.replaceChildren(fragment);
}

function rerenderRomajiAnnotations(key, text, sourceText) {
  $$('.romaji').forEach(el => {
    if (el.dataset.annotationKey === key) renderRomajiText(el, text, sourceText);
  });
}

function closeAnnotationPopover(clearSelection = true) {
  if (annotationPopover) annotationPopover.hidden = true;
  annotationSelection = null;
  annotationAnchorRect = null;
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

function setAnnotationType(type) {
  selectedAnnotationType = type;
  $$('.annotation-type').forEach(button => {
    const active = button.dataset.annotationType === type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (annotationNoteInput) {
    annotationNoteInput.disabled = type !== 'note';
    if (type === 'note') annotationNoteInput.focus();
  }
}

function positionAnnotationPopover(rect) {
  if (!annotationPopover || annotationPopover.hidden) return;
  const gap = 10;
  const width = annotationPopover.offsetWidth;
  const height = annotationPopover.offsetHeight;
  const left = Math.min(window.innerWidth - width - gap, Math.max(gap, rect.left + rect.width / 2 - width / 2));
  const roomBelow = window.innerHeight - rect.bottom;
  const preferredTop = roomBelow >= height + gap
    ? rect.bottom + gap
    : rect.top - height - gap;
  const top = Math.min(window.innerHeight - height - gap, Math.max(gap, preferredTop));
  annotationPopover.style.left = `${left}px`;
  annotationPopover.style.top = `${top}px`;
}

function captureRomajiSelection() {
  if (!romajiMarkupToggle?.checked) return;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const startEl = (range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement)?.closest?.('.romaji');
  const endEl = (range.endContainer.nodeType === Node.ELEMENT_NODE
    ? range.endContainer
    : range.endContainer.parentElement)?.closest?.('.romaji');
  if (!startEl || startEl !== endEl || startEl.closest('.karaoke-char')) return;

  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(startEl);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(startEl);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const fullText = startEl.textContent || '';
  let start = beforeStart.toString().length;
  let end = beforeEnd.toString().length;
  if (!selection.isCollapsed) {
    while (start < end && /\s/.test(fullText[start])) start++;
    while (end > start && /\s/.test(fullText[end - 1])) end--;
    if (end <= start) return;
  }

  annotationSelection = {
    el: startEl,
    key: startEl.dataset.annotationKey || getRomajiAnnotationKey(startEl.dataset.annotationSource, fullText),
    sourceText: startEl.dataset.annotationSource || '',
    text: fullText,
    start,
    end,
  };
  const contextStart = Math.max(0, start - 8);
  const contextEnd = Math.min(fullText.length, start + 8);
  $('#annotation-selection').textContent = selection.isCollapsed
    ? `插入点：${fullText.slice(contextStart, start)}|${fullText.slice(start, contextEnd)}`
    : `“${fullText.slice(start, end)}”`;
  annotationNoteInput.value = '';
  setAnnotationType(selection.isCollapsed ? 'break' : 'phrase');
  annotationPopover.hidden = false;
  annotationAnchorRect = range.getBoundingClientRect();
  requestAnimationFrame(() => positionAnnotationPopover(annotationAnchorRect));
}

function setRomajiMarkupMode(enabled, announce = true) {
  if (!romajiMarkupToggle) return;
  romajiMarkupToggle.checked = enabled;
  document.body.classList.toggle('romaji-markup-mode', enabled);
  if (enabled) {
    $('#show-romaji').checked = true;
    applyToggleClasses();
    applyMode('read');
    if (announce) setStatus('罗马音标记已开启：拖选文字添加声调、连读或备注；单击字母间添加中断 /。');
  } else {
    closeAnnotationPopover();
  }
}

romajiMarkupToggle?.addEventListener('change', () => setRomajiMarkupMode(romajiMarkupToggle.checked));
document.addEventListener('pointerup', event => {
  if (annotationPopover?.contains(event.target)) return;
  setTimeout(captureRomajiSelection, 0);
});
document.addEventListener('keyup', event => {
  if (event.key === 'Shift' || event.shiftKey) captureRomajiSelection();
});
window.addEventListener('resize', () => {
  if (annotationAnchorRect && !annotationPopover?.hidden) positionAnnotationPopover(annotationAnchorRect);
});
window.visualViewport?.addEventListener('resize', () => {
  if (annotationAnchorRect && !annotationPopover?.hidden) positionAnnotationPopover(annotationAnchorRect);
});
document.addEventListener('click', event => {
  if (romajiMarkupToggle?.checked && event.target.closest('.romaji')) event.stopPropagation();
}, true);

$$('.annotation-type').forEach(button => {
  button.addEventListener('click', () => setAnnotationType(button.dataset.annotationType));
});
$('#btn-close-annotation')?.addEventListener('click', () => closeAnnotationPopover());
$('#btn-apply-annotation')?.addEventListener('click', () => {
  if (!annotationSelection) return;
  const note = annotationNoteInput?.value.trim() || '';
  if (selectedAnnotationType === 'note' && !note) {
    annotationNoteInput?.focus();
    return;
  }
  const { key, text, sourceText, start, end } = annotationSelection;
  const existing = romajiAnnotations[key] || [];
  let next;
  if (selectedAnnotationType === 'break') {
    const position = end;
    next = existing.filter(item => item.type !== 'break' || item.start !== position);
    next.push({ start: position, end: position, type: 'break', note: '' });
  } else {
    if (end <= start) {
      setStatus('请先拖选一段罗马音，再添加声调、连读或备注。', true);
      return;
    }
    next = existing.filter(item => item.type === 'break' || item.end <= start || item.start >= end);
    next.push({ start, end, type: selectedAnnotationType, note });
  }
  romajiAnnotations[key] = next;
  saveRomajiAnnotations();
  rerenderRomajiAnnotations(key, text, sourceText);
  closeAnnotationPopover();
  setStatus(selectedAnnotationType === 'break' ? '已添加中断 /。' : '罗马音标记已保存。');
});
$('#btn-remove-annotation')?.addEventListener('click', () => {
  if (!annotationSelection) return;
  const { key, text, sourceText, start, end } = annotationSelection;
  const next = (romajiAnnotations[key] || []).filter(item => {
    if (item.type === 'break') {
      return end > start
        ? item.start < start || item.start > end
        : item.start !== start;
    }
    if (end <= start) return true;
    return item.end <= start || item.start >= end;
  });
  if (next.length) romajiAnnotations[key] = next;
  else delete romajiAnnotations[key];
  saveRomajiAnnotations();
  rerenderRomajiAnnotations(key, text, sourceText);
  closeAnnotationPopover();
  setStatus('所选范围内的标记已清除。');
});

$('#btn-clear-all-annotations')?.addEventListener('click', () => {
  if (!lrcLines.length) {
    setStatus('当前没有歌词可清除。', true);
    return;
  }
  let cleared = 0;
  for (const ln of lrcLines) {
    const key = getRomajiAnnotationKey(ln.text, ln.romaji || '');
    if (romajiAnnotations[key]) {
      delete romajiAnnotations[key];
      cleared++;
    }
  }
  saveRomajiAnnotations();
  for (const ln of lrcLines) {
    const romajiEl = ln.el?.querySelector('.romaji');
    if (romajiEl) {
      romajiEl._karaokeText = undefined;
      romajiEl._karaokeBuilt = false;
      renderRomajiText(romajiEl, ln.romaji || '', ln.text);
    }
  }
  closeAnnotationPopover();
  setStatus(cleared ? `已清除本曲 ${cleared} 行的标记。` : '本曲尚无标记。');
});

$('#btn-toggle-panel').addEventListener('click', () => {
  if (document.body.classList.contains('app-study')) {
    setStudyPanelCollapsed(!$('.study-panel')?.classList.contains('hidden'));
    return;
  }
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
// The browser build of kuromoji does not reliably handle absolute remote dict URLs.
// On GitHub Pages it can degrade "https://cdn..." into a same-origin path such as
// "/cdn.jsdelivr.net/...", which leaves the UI stuck at "加载分词器" while requests 404.
// Serving the dictionary from this site avoids that broken URL normalization entirely.
const DICT_CDNS = ['dict/'];
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
  let out = '';
  const combo = {
    'きゃ':'kya','きゅ':'kyu','きょ':'kyo','ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
    'しゃ':'sha','しゅ':'shu','しょ':'sho','じゃ':'ja','じゅ':'ju','じょ':'jo',
    'ちゃ':'cha','ちゅ':'chu','ちょ':'cho','にゃ':'nya','にゅ':'nyu','にょ':'nyo',
    'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo','びゃ':'bya','びゅ':'byu','びょ':'byo',
    'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo','みゃ':'mya','みゅ':'myu','みょ':'myo',
    'りゃ':'rya','りゅ':'ryu','りょ':'ryo','ふぁ':'fa','ふぃ':'fi','ふぇ':'fe','ふぉ':'fo',
    'てぃ':'ti','でぃ':'di','とぅ':'tu','どぅ':'du','うぃ':'wi','うぇ':'we','うぉ':'wo',
    'しぇ':'she','じぇ':'je','ちぇ':'che','つぁ':'tsa','つぃ':'tsi','つぇ':'tse','つぉ':'tso',
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1];
    const pair = ch + (next || '');
    if (next && combo[pair]) {
      out += combo[pair];
      i++;
    } else if (ch === 'っ' && next) {
      const r = combo[pair] || HIRA_ROMAJI[next] || '';
      out += r[0] || '';
    } else if (/^[ぁぃぅぇぉゃゅょ]$/.test(ch)) {
      out += HIRA_ROMAJI[ch.replace(/[ぁぃぅぇぉゃゅょ]/, m => ({ 'ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お','ゃ':'や','ゅ':'ゆ','ょ':'よ' }[m]))] || '';
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

/* ---------------- Export lyrics ---------------- */
function setExportPopoverOpen(open) {
  const popover = $('#export-popover');
  const btn = $('#btn-export');
  if (!popover || !btn) return;
  popover.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) generateExportText();
}

function generateExportText() {
  const wantJp = $('#export-jp')?.checked;
  const wantRomaji = $('#export-romaji')?.checked;
  const wantZh = $('#export-zh')?.checked;
  const out = $('#export-output');
  if (!out) return;
  if (!lrcLines.length) { out.value = '暂无歌词'; return; }
  const blocks = [];
  for (const ln of lrcLines) {
    const parts = [];
    if (wantJp) parts.push(ln.text || '');
    if (wantRomaji) {
      // 从 DOM 中取纯文本罗马音（去除可能的 karaoke span）
      let romaji = ln.romaji || '';
      const romajiEl = ln.el?.querySelector('.romaji');
      if (romajiEl) romaji = romajiEl.textContent || romaji;
      if (romaji) parts.push(romaji);
    }
    if (wantZh) {
      let zh = ln.zh || '';
      const zhEl = ln.el?.querySelector('.zh');
      if (zhEl) zh = zhEl.textContent || zh;
      if (zh) parts.push(zh);
    }
    if (parts.length) blocks.push(parts.join('\n'));
  }
  out.value = blocks.join('\n\n');
}

$('#btn-export')?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const popover = $('#export-popover');
  setExportPopoverOpen(popover?.hidden !== false);
});
$('#btn-close-export')?.addEventListener('click', () => setExportPopoverOpen(false));
$('#btn-generate-export')?.addEventListener('click', () => generateExportText());
['export-jp', 'export-romaji', 'export-zh'].forEach(id => {
  $('#' + id)?.addEventListener('change', () => generateExportText());
});
$('#btn-copy-export')?.addEventListener('click', async () => {
  const out = $('#export-output');
  if (!out?.value) return;
  try {
    await navigator.clipboard.writeText(out.value);
    setStatus('已复制到剪贴板');
  } catch {
    out.select();
    document.execCommand('copy');
    setStatus('已复制到剪贴板');
  }
});
$('#btn-save-export')?.addEventListener('click', () => {
  const out = $('#export-output');
  if (!out?.value) return;
  const blob = new Blob([out.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lyrics.txt';
  a.click();
  URL.revokeObjectURL(url);
});
document.addEventListener('click', (ev) => {
  const popover = $('#export-popover');
  if (!popover || popover.hidden) return;
  if (popover.contains(ev.target) || $('#btn-export')?.contains(ev.target)) return;
  setExportPopoverOpen(false);
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
  // 避免相同时间戳导致多行同时高亮：给重复时间戳加微小偏移
  for (let i = 1; i < out.length; i++) {
    if (out[i].time <= out[i - 1].time) {
      out[i].time = out[i - 1].time + 0.05;
    }
  }
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
  stopKaraokeLoop();
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
      <button class="icon-btn lrc-speak-btn" type="button" aria-label="朗读这一句" title="朗读这一句">🔊</button>
      <div class="jp">${p.jpHTML || escapeHTML(p.text)}</div>
      <div class="romaji"></div>
      <div class="zh"></div>
    `;
    el.querySelector('.lrc-speak-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      speakJapanese(p.text);
    });
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
    const needsGeneratedRomaji = !ln.cached && (!ln.romaji || !hasWordSpacedRomaji(ln.romaji));
    if (ln.jpHTML && !needsGeneratedRomaji) {
      ln.el.querySelector('.jp').innerHTML = ln.jpHTML;
      renderRomajiText(ln.el.querySelector('.romaji'), ln.romaji || '', ln.text);
    } else {
      try {
        const { html, romaji } = await toFurigana(ln.text);
        if (!ln.jpHTML) ln.jpHTML = html;
        if (romaji) ln.romaji = romaji;
        ln.el.querySelector('.jp').innerHTML = ln.jpHTML || html || escapeHTML(ln.text);
        renderRomajiText(ln.el.querySelector('.romaji'), romaji || ln.romaji || '', ln.text);
      } catch (e) { /* ignore */ }
    }
    if (ln.zh) ln.el.querySelector('.zh').textContent = ln.zh;
    if (i % 10 === 0) setStatus(`处理歌词中 ${i + 1}/${lrcLines.length}...`);
  }
  setStatus(`已就绪 ✓ 共 ${lrcLines.length} 行`);

  if (autoTranslate) {
    setStatus('正在翻译中文（受 API 速率限制，可能较慢）...');
    for (let i = 0; i < lrcLines.length; i++) {
      const ln = lrcLines[i];
      if (ln.zh) continue;
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

function hasWordSpacedRomaji(romaji) {
  const text = String(romaji || '').replace(/\u3000/g, ' ').trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const latinWords = words.filter(word => /[a-z]/i.test(word));
  if (latinWords.length < 3) return false;
  return !latinWords.some(word => word.length > 18);
}

/* ---------------- Japanese study mode ---------------- */
let studyLines = [];
let studySpeechAudio = null;
let studySpeechRunId = 0;
const studyTtsCache = new Map();
const STUDY_AUDIO_PLAYBACK_RATE = 0.9;
const STUDY_BROWSER_SPEECH_RATE = 0.8;
const STUDY_VOICE_KEY = 'jplrc-study-voice';
const STUDY_VOICE_OPTIONS = {
  'cn-default': {
    label: '中国区优先',
    preferChina: true,
    voicevoxSpeaker: '13',
  },
  'voicevox-13': { label: 'VOICEVOX 青山龍星', voicevoxSpeaker: '13' },
  'voicevox-11': { label: 'VOICEVOX 玄野武宏', voicevoxSpeaker: '11' },
  'voicevox-8': { label: 'VOICEVOX 春日部つむぎ', voicevoxSpeaker: '8' },
  'voicevox-2': { label: 'VOICEVOX 四国めたん', voicevoxSpeaker: '2' },
  'voicevox-3': { label: 'VOICEVOX ずんだもん', voicevoxSpeaker: '3' },
  'browser-ja': { label: '系统日语语音', browserOnly: true },
};

function getStudyVoiceChoice() {
  const value = studyVoiceSelect?.value || localStorage.getItem(STUDY_VOICE_KEY) || 'cn-default';
  return STUDY_VOICE_OPTIONS[value] || STUDY_VOICE_OPTIONS['cn-default'];
}

function initStudyVoiceSelect() {
  if (!studyVoiceSelect) return;
  const saved = localStorage.getItem(STUDY_VOICE_KEY);
  if (saved && STUDY_VOICE_OPTIONS[saved]) studyVoiceSelect.value = saved;
  studyVoiceSelect.addEventListener('change', () => {
    stopStudySpeech();
    localStorage.setItem(STUDY_VOICE_KEY, studyVoiceSelect.value);
    const choice = getStudyVoiceChoice();
    setStudyStatus(`已切换朗读音色：${choice.label}`);
  });
}

function splitJapaneseSentences(text) {
  return String(text || '')
    .split(/\r?\n+/)
    .flatMap(line => (line.trim().match(/[^。！？!?]+[。！？!?]?/g) || [line]))
    .map(line => line.trim())
    .filter(Boolean);
}

function getJapaneseVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return voices.find(voice => /^ja[-_]/i.test(voice.lang))
    || voices.find(voice => /japanese|日本/i.test(voice.name))
    || null;
}

function waitForSpeechVoices(timeoutMs = 1600) {
  return new Promise(resolve => {
    const existing = window.speechSynthesis?.getVoices?.() || [];
    if (existing.length) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      window.speechSynthesis?.removeEventListener?.('voiceschanged', onVoicesChanged);
      resolve(window.speechSynthesis?.getVoices?.() || []);
    }, timeoutMs);
    function onVoicesChanged() {
      clearTimeout(timer);
      window.speechSynthesis?.removeEventListener?.('voiceschanged', onVoicesChanged);
      resolve(window.speechSynthesis?.getVoices?.() || []);
    }
    window.speechSynthesis?.addEventListener?.('voiceschanged', onVoicesChanged, { once: true });
  });
}

async function getJapaneseVoiceAsync() {
  let voice = getJapaneseVoice();
  if (voice) return voice;
  await waitForSpeechVoices();
  voice = getJapaneseVoice();
  return voice;
}

function stopStudySpeech() {
  studySpeechRunId++;
  window.speechSynthesis?.cancel?.();
  if (studySpeechAudio) {
    studySpeechAudio.pause();
    studySpeechAudio.src = '';
    studySpeechAudio = null;
  }
}

function buildJapaneseTtsChunks(text, maxLength = 120) {
  const sentences = splitJapaneseSentences(text);
  const parts = sentences.length ? sentences : [String(text || '').trim()];
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if (!part) continue;
    if ((current + part).length > maxLength && current) {
      chunks.push(current);
      current = '';
    }
    if (part.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < part.length; i += maxLength) chunks.push(part.slice(i, i + maxLength));
      continue;
    }
    current += (current && !/[。！？!?]$/.test(current) ? '。' : '') + part;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function getVoicevoxTtsProvider(text, speaker = '13') {
  const cacheKey = `voicevox:${speaker}:${text}`;
  if (studyTtsCache.has(cacheKey)) return studyTtsCache.get(cacheKey);
  try {
    const url = new URL('https://api.tts.quest/v3/voicevox/synthesis');
    url.searchParams.set('speaker', speaker);
    url.searchParams.set('text', text);
    const response = await fetch(url.toString(), { credentials: 'omit' });
    if (!response.ok) throw new Error('VOICEVOX 请求失败 ' + response.status);
    const data = await response.json();
    const audioUrl = data?.mp3StreamingUrl || data?.mp3DownloadUrl || data?.wavDownloadUrl;
    if (!data?.success || !audioUrl) throw new Error('VOICEVOX 未返回音频地址');
    const provider = {
      name: data.speakerName ? `VOICEVOX ${data.speakerName}` : 'VOICEVOX 日语语音',
      url: audioUrl,
    };
    studyTtsCache.set(cacheKey, provider);
    return provider;
  } catch (e) {
    console.warn('[study tts] voicevox failed:', e);
    return null;
  }
}

function getChinaTtsProviders(text) {
  const q = encodeURIComponent(text);
  return [
    { name: '百度日语语音', url: `https://fanyi.baidu.com/gettts?lan=jp&text=${q}&spd=4&source=web` },
    { name: '有道日语语音', url: `https://dict.youdao.com/dictvoice?audio=${q}&le=jap` },
  ];
}

async function getJapaneseTtsProviders(text) {
  const choice = getStudyVoiceChoice();
  if (choice.browserOnly) return [];
  const q = encodeURIComponent(text);
  const providers = [];
  if (choice.preferChina) providers.push(...getChinaTtsProviders(text));
  if (choice.voicevoxSpeaker) {
    const voicevox = await getVoicevoxTtsProvider(text, choice.voicevoxSpeaker);
    if (voicevox) providers.push(voicevox);
  }
  if (!choice.preferChina) providers.push(...getChinaTtsProviders(text));
  providers.push({ name: 'Google 日语语音', url: `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=${q}` });
  return providers;
}

function playStudyAudio(url, runId) {
  return new Promise((resolve, reject) => {
    const audioEl = new Audio(url);
    studySpeechAudio = audioEl;
    audioEl.preload = 'auto';
    audioEl.playbackRate = STUDY_AUDIO_PLAYBACK_RATE;
    audioEl.onended = () => resolve();
    audioEl.onerror = () => reject(new Error('音频接口不可用'));
    audioEl.onabort = () => reject(new Error('朗读已取消'));
    audioEl.play().catch(reject);
    if (runId !== studySpeechRunId) {
      audioEl.pause();
      reject(new Error('朗读已取消'));
    }
  });
}

async function speakJapaneseWithBrowser(text) {
  const voice = await getJapaneseVoiceAsync();
  if (!voice) throw new Error('没有可用的日语语音');
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      reject(new Error('浏览器不支持朗读'));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    utterance.rate = STUDY_BROWSER_SPEECH_RATE;
    utterance.pitch = 1;
    utterance.voice = voice;
    utterance.onstart = () => setStudyStatus(`日语朗读中：${voice.name}`);
    utterance.onerror = () => reject(new Error('浏览器朗读失败'));
    utterance.onend = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

async function speakJapanese(text) {
  const sourceText = String(text || '').trim();
  if (!sourceText) return;
  stopStudySpeech();
  const runId = studySpeechRunId;
  const chunks = buildJapaneseTtsChunks(sourceText);
  let usedFallback = false;

  for (let i = 0; i < chunks.length; i++) {
    if (runId !== studySpeechRunId) return;
    const chunk = chunks[i];
    let played = false;
    const providers = await getJapaneseTtsProviders(chunk);
    for (const provider of providers) {
      try {
        setStudyStatus(`日语朗读中 ${i + 1}/${chunks.length}：${provider.name}`);
        await playStudyAudio(provider.url, runId);
        played = true;
        break;
      } catch (e) {
        if (runId !== studySpeechRunId) return;
      }
    }
    if (!played) {
      usedFallback = true;
      try {
        await speakJapaneseWithBrowser(chunk);
      } catch (e) {
        setStudyStatus('朗读失败：中文区语音接口、VOICEVOX 兜底和浏览器日语语音都不可用。请稍后重试，或在系统/浏览器中安装 Japanese / ja-JP 语音。', true);
        return;
      }
    }
  }

  if (runId === studySpeechRunId) {
    studySpeechAudio = null;
    setStudyStatus(usedFallback ? '朗读完成 ✓ 已回退到浏览器语音' : '日语朗读完成 ✓');
  }
}

initStudyVoiceSelect();

function renderStudyPlaceholder(kind = 'empty') {
  if (!studyResults) return;
  const content = kind === 'cleared'
    ? '<div class="hint-emoji">🧹</div><p><strong>已清空。</strong></p><p>输入新的日语句子后可以继续转换。</p>'
    : '<div class="hint-emoji">📖</div><p><strong>日语学习模式</strong></p><p>输入句子后点击转换，会按阅读模式样式显示假名与罗马音。</p><p class="hint-sub">朗读可选择不同音色，默认优先尝试中国区可访问的免费语音接口。</p>';
  studyResults.innerHTML = `<div class="hint-card">${content}</div>`;
}

async function renderStudyLines(sentences) {
  studyResults.innerHTML = '';
  studyLines = [];
  if (!sentences.length) {
    renderStudyPlaceholder();
    return;
  }
  setStudyStatus(`正在转换 ${sentences.length} 句...`);

  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const line = document.createElement('div');
    line.className = 'lrc-line study-line';
    line.innerHTML = `
      <button class="icon-btn study-speak-btn" type="button" aria-label="朗读这一句" title="朗读这一句">🔊</button>
      <div class="jp">${escapeHTML(text)}</div>
      <div class="romaji"></div>
      <div class="zh"></div>
    `;
    line.querySelector('.study-speak-btn').addEventListener('click', () => speakJapanese(text));
    studyResults.appendChild(line);
    studyLines.push({ text, el: line });

    try {
      const { html, romaji } = await toFurigana(text);
      line.querySelector('.jp').innerHTML = html || escapeHTML(text);
      renderRomajiText(line.querySelector('.romaji'), romaji || '', text);
    } catch (e) {
      renderRomajiText(line.querySelector('.romaji'), kanaToRomajiSimple(kanaToHiragana(text)), text);
    }
    if (i % 3 === 0) setStudyStatus(`转换中 ${i + 1}/${sentences.length}...`);
  }
  setStudyStatus(`转换完成 ✓ 共 ${sentences.length} 句`);
}

async function convertStudyInput() {
  const sentences = splitJapaneseSentences(studyInput?.value || '');
  if (!sentences.length) {
    setStudyStatus('请先输入日语句子。', true);
    studyInput?.focus();
    return;
  }
  await renderStudyLines(sentences);
}

$('#btn-study-convert')?.addEventListener('click', convertStudyInput);
$('#btn-study-clear')?.addEventListener('click', () => {
  if (studyInput) studyInput.value = '';
  studyLines = [];
  stopStudySpeech();
  renderStudyPlaceholder('cleared');
  setStudyStatus('');
});
$('#btn-study-speak-all')?.addEventListener('click', () => {
  const rawText = studyLines.length
    ? studyLines.map(line => line.text).join('\n')
    : (studyInput?.value || '').trim();
  const text = splitJapaneseSentences(rawText).join('\n');
  if (!text) {
    setStudyStatus('请先输入或转换日语句子。', true);
    return;
  }
  speakJapanese(text);
});
studyInput?.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') convertStudyInput();
});

/* ---------------- Playback abstraction (audio + timer) ---------------- */
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
  timerRestart() {
    this.timerOffset = 0;
    this.timerBase = performance.now();
    if (!this.timerRunning) {
      this.timerRunning = true;
      setPanelCollapsed(true);
    }
    updateTimerHud();
  },
  timerNudge(delta) {
    this.timerOffset += delta;
    if (this.timerOffset < 0) this.timerOffset = 0;
    if (!this.timerRunning) updateTimerHud();
  }
};
applyAppMode(localStorage.getItem(APP_MODE_KEY) || 'lyrics');
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

/* ---------------- KTV karaoke progress (char-level spans) ---------------- */
let karaokeRafId = null;

function buildKaraokeSpansPreservingRuby(el, text, parentEl) {
  if (el._karaokeText === text && el._karaokeBuilt) return;
  // 备份原始 HTML（用于恢复 furigana）
  if (parentEl && !parentEl._jpHTMLBackup) {
    parentEl._jpHTMLBackup = el.innerHTML;
  }
  el._karaokeText = text;
  el._karaokeBuilt = true;
  // 仅包裹基础字符（跳过 <rt> 注音），保留 ruby/rt 结构，使跟唱高亮行仍显示假名
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest('rt')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  let count = 0;
  for (const tn of textNodes) {
    const frag = document.createDocumentFragment();
    for (const ch of tn.nodeValue) {
      const span = document.createElement('span');
      span.className = 'karaoke-char';
      span.textContent = ch;
      frag.appendChild(span);
      count++;
    }
    tn.parentNode.replaceChild(frag, tn);
  }
  el._karaokeCharCount = count;
  el._karaokeCharsDirty = true;
}

// 包裹所有文本字符为 karaoke span，同时保留 .romaji-mark / .romaji-break 标记结构
function buildKaraokeSpansPreservingMarks(el, text) {
  if (el._karaokeText === text && el._karaokeBuilt) return;
  el._karaokeText = text;
  el._karaokeBuilt = true;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  let count = 0;
  for (const tn of textNodes) {
    const frag = document.createDocumentFragment();
    for (const ch of tn.nodeValue) {
      const span = document.createElement('span');
      span.className = 'karaoke-char';
      span.textContent = ch;
      frag.appendChild(span);
      count++;
    }
    tn.parentNode.replaceChild(frag, tn);
  }
  el._karaokeCharCount = count;
  el._karaokeCharsDirty = true;
}

function updateKaraokeProgress(t) {
  if (activeIdx < 0 || !lrcLines[activeIdx]) return;
  const line = lrcLines[activeIdx];
  const jpEl = line.el.querySelector('.jp');
  const romajiEl = line.el.querySelector('.romaji');
  if (!jpEl) return;

  // 确保 span 已构建（保留 furigana 注音）
  const plainText = line.text || '';
  if (plainText && jpEl._karaokeText !== plainText) {
    buildKaraokeSpansPreservingRuby(jpEl, plainText, line.el);
  }
  // 罗马音也需要 span（保留标记结构）
  const romajiText = line.romaji || romajiEl?.textContent || '';
  if (romajiEl && romajiText && romajiEl._karaokeText !== romajiText) {
    buildKaraokeSpansPreservingMarks(romajiEl, romajiText);
  }

  let sungChars;
  if (line.wordTiming && line.wordTiming.length > 0) {
    // PetitLyrics 逐字时间轴
    if (!line._plLogged) { line._plLogged = true; console.log('[KTV] 逐字模式:', line.text, '|', line.wordTiming.length, '字'); }
    const tMs = t * 1000;
    const totalChars = line.wordTiming.reduce((sum, w) => sum + w.text.length, 0);
    // DOM 中实际 karaoke span 数（可能与 wordTiming 字符数不一致：部分匹配/多行合并/空格标点差异）
    const domCharCount = jpEl._karaokeCharCount || plainText.length || totalChars;
    if (totalChars === 0) { sungChars = 0; }
    else {
      let completed = 0;
      for (const word of line.wordTiming) {
        if (tMs >= word.endtime) {
          completed += word.text.length;
        } else if (tMs >= word.starttime) {
          const wordDur = word.endtime - word.starttime;
          const wordProg = wordDur > 0 ? (tMs - word.starttime) / wordDur : 1;
          completed += word.text.length * wordProg;
          break;
        } else {
          break;
        }
      }
      // 修复：wordTiming 字符序列与 DOM karaoke span 序列长度不一致时（长行/合并行尤甚），
      // 直接把 completed 当 DOM 索引用会导致高亮提前停滞或错位。
      // 这里按进度比例映射到 DOM 字符数，保证高亮与播放进度同步。
      sungChars = (completed / totalChars) * domCharCount;
    }
  } else {
    // 线性估算
    const lineStart = line.time;
    const lineEnd = activeIdx < lrcLines.length - 1
      ? lrcLines[activeIdx + 1].time
      : lineStart + Math.max(5, (jpEl._karaokeCharCount || plainText.length || 0) / 3);
    const duration = Math.max(0.1, lineEnd - lineStart);
    const progress = Math.min(1, Math.max(0, (t - lineStart) / duration));
    sungChars = progress * (jpEl._karaokeCharCount || plainText.length);
  }

  // 逐字符标记已唱/未唱（缓存 + 增量更新，长行时避免每帧全量遍历导致掉帧）
  const jpSungInt = Math.floor(sungChars);
  applyKaraokeSung(jpEl, jpSungInt);

  // 罗马音同步
  if (romajiEl && romajiEl._karaokeCharCount) {
    const romajiSungInt = Math.floor((sungChars / (jpEl._karaokeCharCount || 1)) * romajiEl._karaokeCharCount);
    applyKaraokeSung(romajiEl, romajiSungInt);
  }
}

// 按缓存的 span 列表增量更新已唱高亮：只处理 [last, sung) 之间变化的字符
function applyKaraokeSung(el, sungInt) {
  let chars = el._karaokeCharEls;
  if (!chars || el._karaokeCharsDirty) {
    chars = el._karaokeCharEls = Array.from(el.querySelectorAll('.karaoke-char'));
    el._karaokeCharsDirty = false;
    el._lastSungInt = -1;
  }
  const clamped = Math.max(0, Math.min(chars.length, sungInt));
  const last = el._lastSungInt < 0 ? 0 : el._lastSungInt;
  if (last === clamped) return;
  const lo = Math.min(last, clamped);
  const hi = Math.max(last, clamped);
  for (let i = lo; i < hi; i++) {
    if (i < clamped) chars[i].classList.add('karaoke-sung');
    else chars[i].classList.remove('karaoke-sung');
  }
  el._lastSungInt = clamped;
}

function startKaraokeLoop() {
  stopKaraokeLoop();
  function tick() {
    if (!isPlaybackActive()) { stopKaraokeLoop(); return; }
    updateKaraokeProgress(player.getTime());
    karaokeRafId = requestAnimationFrame(tick);
  }
  karaokeRafId = requestAnimationFrame(tick);
}

function stopKaraokeLoop() {
  if (karaokeRafId) { cancelAnimationFrame(karaokeRafId); karaokeRafId = null; }
}

function clearKaraokeProgress(el) {
  // 恢复原始 HTML（furigana/romaji），移除 karaoke span
  const jp = el?.querySelector('.jp');
  if (jp && jp._karaokeText !== undefined) {
    jp.innerHTML = el._jpHTMLBackup || jp._karaokeText;
    jp._karaokeText = undefined;
    jp._karaokeBuilt = false;
    jp._karaokeCharCount = 0;
    jp._karaokeCharsDirty = true;
    jp._karaokeCharEls = null;
    jp._lastSungInt = -1;
  }
  const romaji = el?.querySelector('.romaji');
  if (romaji && romaji._karaokeText !== undefined) {
    const romajiText = romaji._karaokeText;
    romaji._karaokeText = undefined;
    romaji._karaokeBuilt = false;
    romaji._karaokeCharCount = 0;
    romaji._karaokeCharsDirty = true;
    romaji._karaokeCharEls = null;
    romaji._lastSungInt = -1;
    renderRomajiText(romaji, romajiText, romaji.dataset.annotationSource || '');
  }
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
    if (activeIdx >= 0) {
      lrcLines[activeIdx].el.classList.remove('active');
      clearKaraokeProgress(lrcLines[activeIdx].el);
    }
    activeIdx = idx;
    if (idx >= 0) {
      const el = lrcLines[idx].el;
      el.classList.add('active');
      if (shouldCenterLyrics()) centerActiveLyric(el);
      updateKaraokeProgress(t);
    }
  } else if (idx >= 0 && shouldCenterLyrics()) {
    const now = performance.now();
    if (now - lastAutoCenterAt > 650) centerActiveLyric(lrcLines[idx].el);
  }
  if (isPlaybackActive() && !karaokeRafId) startKaraokeLoop();
  else if (!isPlaybackActive() && karaokeRafId) stopKaraokeLoop();
}

function centerActiveLyric(el, behavior = 'smooth') {
  lastAutoCenterAt = performance.now();
  const rect = el.getBoundingClientRect();
  const viewRect = lyricsView.getBoundingClientRect();
  const targetY = viewRect.height * getLyricFocusRatio();
  const offset = rect.top - viewRect.top - targetY + rect.height / 2;
  const nextTop = Math.max(0, Math.min(
    lyricsView.scrollHeight - lyricsView.clientHeight,
    lyricsView.scrollTop + offset
  ));
  lyricsView.scrollTo({ top: nextTop, behavior });
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
  resetAssistActions();
  loadLrcFromText(text);
});

$('#btn-load-lrc').addEventListener('click', () => {
  const text = $('#lrc-text').value;
  if (!text.trim()) { setStatus('请先粘贴或上传 LRC 内容', true); return; }
  resetAssistActions();
  loadLrcFromText(text);
});

$('#btn-clear').addEventListener('click', () => {
  $('#lrc-text').value = '';
  $('#lrc-file-name').textContent = '未选择 .lrc 文件';
  lyricsView.innerHTML = '<div class="hint-card"><div class="hint-emoji">🧹</div><p>已清空。</p></div>';
  lrcLines = []; activeIdx = -1;
  stopKaraokeLoop();
  resetAssistActions();
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

/* ---------------- Local lyrics cache (search history) ---------------- */
const LYRICS_CACHE_KEY = 'jplrc-lyrics-cache';
const LYRICS_CACHE_MAX = 30;
let lyricsCache = {};
try { lyricsCache = JSON.parse(localStorage.getItem(LYRICS_CACHE_KEY) || '{}'); } catch { lyricsCache = {}; }

function lyricsCacheKey(item) {
  if (item && item.id != null) return 'id:' + item.id;
  return 'k:' + (item?.trackName || '') + '|' + (item?.artistName || '') + '|' + (item?.duration || 0);
}

function persistLyricsCache() {
  try {
    localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(lyricsCache));
  } catch (e) {
    // 配额不足：淘汰一半最旧条目后重试一次
    const entries = Object.entries(lyricsCache).sort((a, b) => a[1].savedAt - b[1].savedAt);
    const keep = Math.max(1, Math.floor(entries.length / 2));
    lyricsCache = Object.fromEntries(entries.slice(-keep));
    try { localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(lyricsCache)); }
    catch (e2) { console.warn('[lyrics-cache] save failed:', e2); }
  }
}

function saveLyricsToCache(item, lrcText) {
  if (!lrcLines.length || !item) return;
  const key = lyricsCacheKey(item);
  lyricsCache[key] = {
    meta: {
      title: item.trackName || '',
      artist: item.artistName || '',
      album: item.albumName || '',
      duration: item.duration || 0,
      query: searchInput.value.trim(),
    },
    lrc: lrcText || '',
    lines: lrcLines.map(l => ({
      time: l.time, text: l.text,
      jpHTML: l.jpHTML || '',
      romaji: l.romaji || '',
      zh: l.zh || '',
      wordTiming: l.wordTiming || null,
    })),
    savedAt: Date.now(),
  };
  const entries = Object.entries(lyricsCache);
  if (entries.length > LYRICS_CACHE_MAX) {
    entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (let i = 0; i < entries.length - LYRICS_CACHE_MAX; i++) delete lyricsCache[entries[i][0]];
  }
  persistLyricsCache();
}

function cacheMatchesQuery(entry, q) {
  if (!q) return false;
  const ql = q.toLowerCase();
  const m = entry.meta || {};
  return (m.title || '').toLowerCase().includes(ql)
    || (m.artist || '').toLowerCase().includes(ql)
    || (m.query || '').toLowerCase().includes(ql);
}

async function loadFromCache(entry) {
  searchResults.hidden = true;
  setSearchHistoryOpen(false);
  $('#lrc-text').value = entry.lrc || '';
  const parsed = (entry.lines || []).map(l => ({
    time: l.time, text: l.text,
    jpHTML: l.jpHTML, romaji: l.romaji, zh: l.zh,
    wordTiming: l.wordTiming, cached: true,
  }));
  setStatus(`从本地缓存载入：${entry.meta?.title || ''} - ${entry.meta?.artist || ''}`);
  await renderLyrics(parsed);
  setPanelCollapsed(true);
  if (!entry.lrc) switchToTimerMode();
}

function getCacheEntries(query = '') {
  return Object.values(lyricsCache)
    .filter(entry => !query || cacheMatchesQuery(entry, query))
    .sort((a, b) => b.savedAt - a.savedAt);
}

function createCacheResult(entry) {
  const div = document.createElement('div');
  div.className = 'result-item';
  div.innerHTML = `
    <div class="title">${escapeHTML(entry.meta?.title || '(无标题)')} <span class="badge badge-cache">缓存</span></div>
    <div class="meta">${escapeHTML(entry.meta?.artist || '')} · ${formatDur(entry.meta?.duration)} · ${new Date(entry.savedAt).toLocaleDateString()}</div>
  `;
  div.addEventListener('click', () => loadFromCache(entry));
  return div;
}

function renderCacheResults(container, query = '') {
  const entries = getCacheEntries(query);
  if (!entries.length) return 0;
  const head = document.createElement('div');
  head.className = 'search-section-head';
  head.textContent = '本地缓存（点击直接载入）';
  container.appendChild(head);
  entries.forEach(entry => container.appendChild(createCacheResult(entry)));
  return entries.length;
}

function renderSearchHistory() {
  const list = $('#search-history-list');
  if (!list) return;
  const entries = getCacheEntries();
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '暂无搜索历史';
    list.appendChild(empty);
    return;
  }
  entries.forEach(entry => list.appendChild(createCacheResult(entry)));
}

function setSearchHistoryOpen(open) {
  const popover = $('#search-history-popover');
  const btn = $('#btn-search-history');
  if (!popover || !btn) return;
  if (open) renderSearchHistory();
  popover.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

$('#btn-search-history')?.addEventListener('click', (event) => {
  event.stopPropagation();
  setSearchHistoryOpen($('#search-history-popover')?.hidden !== false);
});
$('#btn-close-search-history')?.addEventListener('click', () => setSearchHistoryOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setSearchHistoryOpen(false);
});
document.addEventListener('click', (event) => {
  const popover = $('#search-history-popover');
  if (!popover || popover.hidden) return;
  if (popover.contains(event.target) || $('#btn-search-history')?.contains(event.target)) return;
  setSearchHistoryOpen(false);
});

// LRCLIB 搜索请求：单次请求限时 8s（限流时服务器会拖慢响应），503/429 退避重试一次
async function fetchLrclibSearch(params, { retries = 1, retryDelay = 500, timeout = 8000 } = {}) {
  const url = new URL('https://lrclib.net/api/search');
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(url.toString(), { signal: controller.signal });
      if (r.status === 503 || r.status === 429) {
        // 服务器过载/限流，稍后重试
        lastErr = new Error(`HTTP ${r.status}`);
      } else if (!r.ok) {
        return { __error: `HTTP ${r.status}` };
      } else {
        const data = await r.json();
        return Array.isArray(data) ? data : [];
      }
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('请求超时') : e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await new Promise(res => setTimeout(res, retryDelay));
    }
  }
  return { __error: lastErr?.message || '网络错误' };
}

// 搜索策略分两波：
// 第一波（并行）：全文 q + 整句当 track_name —— 覆盖绝大多数场景，一轮往返即出结果
// 第二波（并行）：「歌名 歌手」「歌手 歌名」拆分 —— 第一波结果不足时补充
// LRCLIB 的 q 全文搜索对部分查询（如 "Bloody Stream"）会稳定 503，字段搜索是可靠兜底
function buildLrclibSearchWaves(q) {
  const waves = [[{ q }, { track_name: q }]];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const rest = tokens.slice(0, -1).join(' ');
    const first = tokens[0];
    const after = tokens.slice(1).join(' ');
    const secondWave = [{ track_name: rest, artist_name: last }];
    if (after !== rest) secondWave.push({ track_name: after, artist_name: first });
    waves.push(secondWave);
  }
  return waves;
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  const requestId = ++searchRequestId;
  resetAssistActions();
  setStatus('搜索中...');
  searchResults.hidden = false;
  searchResults.replaceChildren();
  renderCacheResults(searchResults, q);
  const onlineResults = document.createElement('div');
  onlineResults.className = 'online-search-results';
  const resultsHead = document.createElement('div');
  resultsHead.className = 'search-section-head';
  resultsHead.textContent = 'LRCLIB 歌词结果';
  const resultsList = document.createElement('div');
  const searchingMsg = document.createElement('div');
  searchingMsg.className = 'search-message';
  searchingMsg.textContent = '搜索中...';
  onlineResults.append(resultsHead, searchingMsg, resultsList);
  searchResults.appendChild(onlineResults);

  // 结果到达即渲染（先到先显示），不等全部请求完成
  const seen = new Set();
  const merged = [];
  let lastError = null;
  let anySuccess = false;
  const renderMerged = () => {
    if (requestId !== searchRequestId) return;
    resultsList.replaceChildren();
    merged.slice(0, 16).forEach(item => {
      const div = document.createElement('div');
      div.className = 'result-item';
      const synced = !!item.syncedLyrics;
      const title = item.trackName || '(无标题)';
      const artist = item.artistName || '';
      div.innerHTML = `
        <div class="title">${escapeHTML(title)} ${synced ? '<span class="badge">同步</span>' : ''}</div>
        <div class="meta">${escapeHTML(artist)} · ${escapeHTML(item.albumName || '')} · ${formatDur(item.duration)}</div>
      `;
      div.addEventListener('click', () => loadFromLrclib(item));
      resultsList.appendChild(div);
    });
    searchingMsg.hidden = merged.length > 0;
    setStatus(merged.length ? `找到 ${merged.length} 条歌词` : '搜索中...');
  };
  const absorb = (data) => {
    if (requestId !== searchRequestId) return;
    if (Array.isArray(data)) {
      anySuccess = true;
      for (const item of data) {
        const key = `${item.trackName}||${item.artistName}||${item.duration}`;
        if (!seen.has(key)) { seen.add(key); merged.push(item); }
      }
    } else {
      lastError = data?.__error || lastError;
    }
  };

  // 按波次并行请求：波内并发、各自完成后立即渲染；结果足够即不再发起下一波
  const waves = buildLrclibSearchWaves(q);
  for (const wave of waves) {
    await new Promise(resolve => {
      let pending = wave.length;
      for (const s of wave) {
        fetchLrclibSearch(s)
          .then(data => { absorb(data); renderMerged(); })
          .finally(() => { if (--pending === 0) resolve(); });
      }
    });
    if (requestId !== searchRequestId) return;
    if (merged.length >= 5) break;
  }

  if (requestId !== searchRequestId) return;
  searchingMsg.hidden = true;
  if (!merged.length && lastError && !anySuccess) {
    const error = document.createElement('div');
    error.className = 'search-message error';
    error.textContent = `搜索失败：${lastError}`;
    resultsList.appendChild(error);
    setStatus('LRCLIB 搜索失败，本地缓存仍可使用', true);
    return;
  }
  if (!merged.length) {
    const empty = document.createElement('div');
    empty.className = 'search-message';
    empty.textContent = '未找到歌词。换个关键词试试？';
    resultsList.appendChild(empty);
    setStatus('未找到歌词');
  } else {
    setStatus(`找到 ${merged.length} 条歌词`);
  }
}

function stripHTML(s) {
  const div = document.createElement('div');
  div.innerHTML = s;
  return div.textContent || div.innerText || '';
}

function formatDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildFakeLrcFromPlainText(text, stepSeconds = 4) {
  return String(text || '')
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const totalSeconds = index * stepSeconds;
      const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      return `[${minutes}:${seconds}.00]${line}`;
    })
    .join('\n');
}

/* ---------------- PetitLyrics 逐字时间轴 ---------------- */
async function fetchPetitLyricsWordTiming(title, artist) {
  // 清理 artist：只取第一个（LRCLIB 常返回 "YOASOBI, Ayase" 格式）
  const cleanArtist = artist?.split(/[,/&]| feat\.? /i)[0]?.trim() || '';
  const attempts = [
    { key_title: title, key_artist: cleanArtist },
    { key_title: title, key_artist: '' },
  ];
  for (const params of attempts) {
    try {
      console.log('[PetitLyrics] 请求: title=' + params.key_title + ' artist=' + (params.key_artist || '(空)'));
      const body = new URLSearchParams();
      body.append('clientAppId', 'p1110417');
      body.append('lyricsType', '3');
      body.append('terminalType', '10');
      body.append('key_title', params.key_title);
      if (params.key_artist) body.append('key_artist', params.key_artist);
      const resp = await fetch('https://p0.petitlyrics.com/api/GetPetitLyricsData.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!resp.ok) { console.warn('[PetitLyrics] HTTP', resp.status); continue; }
      const xmlText = await resp.text();
      const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
      const lyricsType = doc.querySelector('lyricsType')?.textContent;
      const lyricsData = doc.querySelector('lyricsData')?.textContent;
      const matchedCount = doc.querySelector('matchedCount')?.textContent;
      console.log('[PetitLyrics] 响应: lyricsType=' + lyricsType + ' matchedCount=' + matchedCount);
      if (lyricsType === '3' && lyricsData) {
        const parsed = parsePetitLyricsWordData(lyricsData);
        console.log('[PetitLyrics] 解析成功: ' + (parsed?.length || 0) + ' 行逐字时间轴');
        if (parsed?.length) console.log('[PetitLyrics] 第1行示例:', parsed[0].text, '| 字数:', parsed[0].words.length);
        return parsed;
      }
    } catch (e) {
      console.warn('[PetitLyrics] 错误:', e);
    }
  }
  console.warn('[PetitLyrics] 无逐字数据');
  return null;
}

function base64ToUtf8(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function parsePetitLyricsWordData(base64Data) {
  try {
    const xmlStr = base64ToUtf8(base64Data);
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    const lines = [];
    const lineEls = doc.querySelectorAll('line');
    lineEls.forEach(lineEl => {
      const linestring = lineEl.querySelector('linestring')?.textContent || '';
      const words = [];
      lineEl.querySelectorAll('word').forEach(wordEl => {
        const starttime = parseInt(wordEl.querySelector('starttime')?.textContent || '0', 10);
        const endtime = parseInt(wordEl.querySelector('endtime')?.textContent || '0', 10);
        const wordstring = wordEl.querySelector('wordstring')?.textContent || '';
        if (wordstring) words.push({ starttime, endtime, text: wordstring });
      });
      if (linestring || words.length) {
        const time = words.length ? words[0].starttime / 1000 : 0;
        lines.push({ time, text: linestring, words });
      }
    });
    return lines;
  } catch (e) {
    console.warn('[petitlyrics parse]', e);
    return null;
  }
}

function normalizeLyricsText(s) {
  return s.replace(/[^\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\uFF66-\uFF9Fa-zA-Z0-9]/g, '').toLowerCase();
}

function matchPetitLyricsToLrc(plLines, lrcArr) {
  if (!plLines || !plLines.length) return;
  for (const lrcLine of lrcArr) {
    const normLrc = normalizeLyricsText(lrcLine.text || '');
    if (!normLrc) continue;

    // 1. 尝试精确匹配单个 PL 行
    let bestMatch = null;
    let bestScore = 0;
    for (const pl of plLines) {
      const normPl = normalizeLyricsText(pl.text || '');
      if (!normPl) continue;
      let score = 0;
      if (normLrc === normPl) {
        score = 1;
      } else if (normLrc.includes(normPl) || normPl.includes(normLrc)) {
        score = Math.min(normLrc.length, normPl.length) / Math.max(normLrc.length, normPl.length);
      }
      if (score > bestScore) { bestScore = score; bestMatch = pl; }
    }
    if (bestMatch && bestScore >= 0.6) {
      lrcLine.wordTiming = bestMatch.words;
      continue;
    }

    // 2. 一个 LRC 行可能包含多个 PL 行的文本（多行合并），尝试合并匹配
    const contained = plLines.filter(pl => {
      const normPl = normalizeLyricsText(pl.text || '');
      return normPl && normPl.length >= 2 && normLrc.includes(normPl);
    });
    if (contained.length >= 2) {
      contained.sort((a, b) => (a.words[0]?.starttime || 0) - (b.words[0]?.starttime || 0));
      const mergedWords = contained.flatMap(pl => pl.words);
      const mergedNorm = normalizeLyricsText(contained.map(pl => pl.text).join(''));
      const coverage = normLrc.length > 0 ? mergedNorm.length / normLrc.length : 0;
      if (coverage >= 0.6) {
        lrcLine.wordTiming = mergedWords;
      }
    }
  }
}

async function loadFromLrclib(item) {
  searchResults.hidden = true;
  const syncedLrc = item.syncedLyrics || '';
  const plainLyrics = item.plainLyrics || '';
  const lrc = syncedLrc || buildFakeLrcFromPlainText(plainLyrics);
  if (!lrc) { setStatus('该结果无歌词内容', true); return; }
  $('#lrc-text').value = lrc;
  startAssistActionsForLyric(item);
  setStatus(`${syncedLrc ? '已载入' : '已载入纯文本歌词'}：${item.trackName} - ${item.artistName}；正在后台搜索 Kanogoma 与逐字时间轴...`);
  await loadLrcFromText(lrc);
  setPanelCollapsed(true);
  if (!syncedLrc) switchToTimerMode();
  Promise.allSettled([
    prefetchKanogomaCandidatesForLyric(item),
    (async () => {
      const plLines = await fetchPetitLyricsWordTiming(item.trackName, item.artistName);
      if (plLines) {
        matchPetitLyricsToLrc(plLines, lrcLines);
        const matched = lrcLines.filter(l => l.wordTiming).length;
        console.log('[PetitLyrics] 匹配结果: ' + matched + '/' + lrcLines.length + ' 行');
        if (matched > 0) {
          const sample = lrcLines.find(l => l.wordTiming);
          if (sample) console.log('[PetitLyrics] 匹配示例:', sample.text, '->', sample.wordTiming.length, '字');
          setStatus(`已载入：${item.trackName} - ${item.artistName} · PetitLyrics 逐字时间轴已匹配 ${matched}/${lrcLines.length} 行`);
        } else {
          console.warn('[PetitLyrics] 无匹配行，将使用线性估算');
        }
      }
    })(),
  ]).then(() => saveLyricsToCache(item, lrc));
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
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
  // Only show player bar if an audio file is actually loaded
  setPlayerVisible(!!audio.src);
}

async function switchToYouTubeMode(videoId) {
  player.mode = 'yt';
  audio.pause();
  audio.style.display = 'none';
  const yw = $('#yt-wrap'); if (yw) yw.hidden = false;
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
          setStatus(`YouTube 错误 ${e.data}：${codes[e.data] || '未知'}。请换一首或改用计时模式。`, true);
        }
      }
    });
  }
  startPolling();
}

function switchToTimerMode() {
  player.mode = 'timer';
  audio.pause();
  audio.style.display = 'none';
  const yw = $('#yt-wrap'); if (yw) yw.hidden = true;
  if (player.yt) { try { player.yt.stopVideo(); } catch {} }
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
$('#hud-restart').addEventListener('click', () => player.timerRestart());
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
$('#btn-timer-restart').addEventListener('click', () => {
  if (player.mode !== 'timer') switchToTimerMode();
  player.timerRestart();
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

$('#btn-apply-kanogoma')?.addEventListener('click', () => {
  if (!latestKanogomaCandidates.length) {
    setStatus('当前还没有可用的 Kanogoma 注音结果', true);
    return;
  }
  loadFromKanogoma(latestKanogomaCandidates[0]);
});

/* ---------------- Kanogoma (lyrics + high-quality furigana) ---------------- */
function kanogomaBuildSearchUrl(query) {
  const u = new URL('https://kanogoma.com/wp-json/wp/v2/song');
  u.searchParams.set('search', query);
  u.searchParams.set('per_page', '12');
  return u.toString();
}

async function kanogomaFetchHtml(url) {
  const response = await fetch('https://r.jina.ai/' + url, {
    headers: { 'X-Return-Format': 'html' }
  });
  if (!response.ok) throw new Error('网络错误 ' + response.status);
  return await response.text();
}

const RE_KANJI = /[\u3400-\u9fff々ヶ]/;

function decodeHtmlText(text) {
  const el = document.createElement('textarea');
  el.innerHTML = text || '';
  return el.value;
}

function kanogomaTitleFromSlug(slug = '') {
  const decoded = decodeURIComponent(String(slug).replace(/\+/g, '%20'));
  const parts = decoded.split('-').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts.shift().toUpperCase()} - ${parts.join('-')}`;
  }
  return decoded || '(无标题)';
}

function kanogomaArtistFromItem(item) {
  const artistClass = (item.class_list || []).find(name => name.startsWith('kngm_artist-')) || '';
  const raw = artistClass.replace(/^kngm_artist-/, '').replace(/-/g, ' ');
  return raw ? raw.replace(/\b\w/g, c => c.toUpperCase()) : '';
}

function normalizeLyricText(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」『』“”\"'’‘.,，。！？!?…・･♪\-－—–~〜]/g, '')
    .toLowerCase();
}

function textFromRubyElement(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('rt').forEach(rt => rt.remove());
  return (clone.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function kanaToHiragana(text) {
  return String(text || '').replace(/[\u30a1-\u30f6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function splitLeadingOkurigana(chunk) {
  const markers = ['その', 'この', 'あの', 'どの', 'ここ', 'そこ', 'どこ', 'こと', 'もの', 'とこ', 'から', 'まで', 'だけ', 'でも', 'なら', 'より', 'って', 'さえ'];
  let splitAt = chunk.length;
  for (const marker of markers) {
    const pos = chunk.indexOf(marker);
    if (pos > 0 && pos < splitAt) splitAt = pos;
  }
  return [chunk.slice(0, splitAt), chunk.slice(splitAt)];
}

function pushKanaWord(words, kana) {
  const normalized = kanaToHiragana(kana).replace(/\s+/g, '');
  if (!normalized) return;
  const romaji = kanaToRomajiSimple(normalized).replace(/-/g, '');
  if (romaji) words.push(romaji);
}

function splitStandaloneHiraganaWords(chunk) {
  const protectedWords = ['それ', 'これ', 'あれ', 'その', 'この', 'あの', 'どの', 'ここ', 'そこ', 'どこ', 'こと', 'もの', 'とこ', 'ない'];
  const particles = ['さえ', 'なら', 'から', 'まで', 'だけ', 'でも', 'より', 'って', 'は', 'が', 'を', 'に', 'へ', 'で', 'と', 'も', 'の', 'や', 'か'];
  const out = [];
  let rest = chunk;
  while (rest) {
    const protectedHit = protectedWords.find(word => rest.startsWith(word));
    if (protectedHit) {
      out.push(protectedHit);
      rest = rest.slice(protectedHit.length);
      continue;
    }
    const particleHit = particles.find(word => rest.startsWith(word));
    if (particleHit) {
      out.push(particleHit);
      rest = rest.slice(particleHit.length);
      continue;
    }
    let nextAt = rest.length;
    for (const word of [...protectedWords, ...particles]) {
      const pos = rest.indexOf(word, 1);
      if (pos > 0 && pos < nextAt) nextAt = pos;
    }
    out.push(rest.slice(0, nextAt));
    rest = rest.slice(nextAt);
  }
  return out.filter(Boolean);
}

function pushPlainKanaWords(words, text) {
  const parts = String(text || '').split(/([\s\u3000、。,.，.!！?？「」『』（）()\[\]【】]+|[\u30a0-\u30ffー]+|[A-Za-z0-9]+)/g).filter(Boolean);
  for (const part of parts) {
    if (/^[\s\u3000、。,.，.!！?？「」『』（）()\[\]【】]+$/.test(part)) continue;
    if (/^[A-Za-z0-9]+$/.test(part)) { words.push(part.toLowerCase()); continue; }
    if (/^[\u30a0-\u30ffー]+$/.test(part)) { pushKanaWord(words, part); continue; }
    const hira = kanaToHiragana(part);
    if (/^[\u3041-\u3096ー]+$/.test(hira)) {
      splitStandaloneHiraganaWords(hira).forEach(word => pushKanaWord(words, word));
    }
  }
}

function kanogomaRomajiFromRubyElement(rubyEl) {
  const words = [];
  let pendingRuby = '';

  const flushPending = () => {
    if (!pendingRuby) return;
    pushKanaWord(words, pendingRuby);
    pendingRuby = '';
  };

  rubyEl.childNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'ruby') {
      flushPending();
      pendingRuby = node.querySelector('rt')?.textContent?.trim() || '';
      return;
    }

    const text = node.textContent || '';
    if (!text.trim()) {
      flushPending();
      return;
    }

    if (pendingRuby) {
      const leading = text.match(/^[\u3041-\u3096ー]+/)?.[0] || '';
      if (leading && !/^(の|は|が|を|に|へ|で|と|も|や|か)$/.test(leading)) {
        const [okurigana, rest] = splitLeadingOkurigana(leading);
        pendingRuby += okurigana;
        flushPending();
        pushPlainKanaWords(words, rest + text.slice(leading.length));
      } else {
        flushPending();
        pushPlainKanaWords(words, text);
      }
    } else {
      pushPlainKanaWords(words, text);
    }
  });

  flushPending();
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

function kanogomaParseLyric(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('article h1, h1')?.textContent?.trim() || '';
  const body = doc.querySelector('#kngm');
  if (!body) return { title, lines: [], pairs: {} };

  const pairs = {};
  const lines = [];
  body.querySelectorAll(':scope > div').forEach(row => {
    const rubyEl = row.querySelector('p.ruby');
    if (!rubyEl) return;
    rubyEl.querySelectorAll('ruby').forEach(ruby => {
      const clone = ruby.cloneNode(true);
      const rt = clone.querySelector('rt');
      const kana = rt?.textContent?.trim() || '';
      if (rt) rt.remove();
      const kanji = clone.textContent.trim();
      if (kanji && kana && RE_KANJI.test(kanji) && !pairs[kanji]) pairs[kanji] = kana;
    });
    const text = textFromRubyElement(rubyEl);
    if (!text) return;
    lines.push({
      text,
      jpHTML: rubyEl.innerHTML.trim(),
      romaji: kanogomaRomajiFromRubyElement(rubyEl) || row.querySelector('p.rmj')?.textContent?.trim() || '',
      zh: row.querySelector('p.zh')?.textContent?.trim() || '',
    });
  });
  return { title, lines, pairs };
}

function kanogomaResultFromItem(item) {
  const slug = item.slug || item.link?.match(/\/song\/([^/]+)\/?/)?.[1] || '';
  const renderedTitle = stripHTML(item.title?.rendered || '').trim();
  return {
    id: item.id,
    url: item.link || `https://kanogoma.com/song/${slug}/`,
    slug,
    title: decodeHtmlText(renderedTitle) || kanogomaTitleFromSlug(slug),
    artist: kanogomaArtistFromItem(item),
  };
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

async function searchKanogomaCandidates(title, artist = '') {
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) return [];
  const response = await fetch(kanogomaBuildSearchUrl(q), { credentials: 'omit' });
  if (!response.ok) throw new Error('网络错误 ' + response.status);
  let items = await response.json();
  items = Array.isArray(items) ? items.map(kanogomaResultFromItem) : [];
  if (artist) {
    const artistLower = artist.toLowerCase();
    items = items.slice().sort((left, right) => {
      const leftText = `${left.title} ${left.artist}`.toLowerCase();
      const rightText = `${right.title} ${right.artist}`.toLowerCase();
      const leftHit = leftText.includes(artistLower) ? 1 : 0;
      const rightHit = rightText.includes(artistLower) ? 1 : 0;
      return rightHit - leftHit;
    });
  }
  return items;
}

async function prefetchKanogomaCandidatesForLyric(item) {
  const title = item?.trackName || '';
  const artist = item?.artistName || '';
  const requestId = ++kanogomaSearchRequestId;
  latestKanogomaCandidates = [];
  latestKanogomaQuery = title;
  assistSearchState.kanogoma = { status: 'loading', message: '', count: 0 };
  renderAssistActions();
  try {
    const items = await searchKanogomaCandidates(title, artist);
    if (requestId !== kanogomaSearchRequestId) return;
    if (!items.length) {
      assistSearchState.kanogoma = { status: 'empty', message: '', count: 0 };
      renderAssistActions();
      return;
    }
    latestKanogomaCandidates = items.slice(0, 10);
    latestKanogomaQuery = title;
    assistSearchState.kanogoma = { status: 'ready', message: '', count: latestKanogomaCandidates.length };
    renderAssistActions();
  } catch (e) {
    if (requestId !== kanogomaSearchRequestId) return;
    assistSearchState.kanogoma = { status: 'error', message: e.message, count: 0 };
    renderAssistActions();
  }
}

function buildTimedLinesFromKanogoma(lines, stepSeconds = 4) {
  return lines.map((line, index) => ({
    time: index * stepSeconds,
    text: line.text,
    jpHTML: line.jpHTML,
    romaji: line.romaji,
    zh: line.zh,
  }));
}

async function applyKanogomaToCurrentLyrics(data) {
  const byText = new Map();
  for (const line of data.lines) {
    const key = normalizeLyricText(line.text);
    if (key && !byText.has(key)) byText.set(key, line);
  }
  let applied = 0;
  for (const ln of lrcLines) {
    const hit = byText.get(normalizeLyricText(ln.text));
    if (!hit) continue;
    ln.jpHTML = hit.jpHTML;
    ln.romaji = hit.romaji;
    if (!hasWordSpacedRomaji(ln.romaji)) {
      try {
        const generated = await toFurigana(ln.text);
        if (generated.romaji) ln.romaji = generated.romaji;
      } catch {}
    }
    ln.zh = hit.zh;
    ln.el.querySelector('.jp').innerHTML = hit.jpHTML || escapeHTML(ln.text);
    renderRomajiText(ln.el.querySelector('.romaji'), ln.romaji || '', ln.text);
    ln.el.querySelector('.zh').textContent = hit.zh || '';
    applied++;
  }
  return applied;
}

async function loadFromKanogoma(item) {
  setStatus(`Kanogoma 载入：${item.title}...`);
  try {
    const html = await kanogomaFetchHtml(item.url);
    const data = kanogomaParseLyric(html);
    if (!data.lines.length) {
      setStatus('Kanogoma 页面未能解析出歌词', true);
      return;
    }
    const added = mergeOverridesFromPairs(data.pairs);
    searchResults.hidden = true;

    const lrcText = $('#lrc-text').value;
    if (lrcText.trim() && lrcLines.length) {
      const applied = await applyKanogomaToCurrentLyrics(data);
      if (applied) {
        applyToggleClasses();
        setStatus(`Kanogoma ✓ 已应用 ${applied} 行注音/罗马音/中文，学到 ${added} 个新读音。`);
      } else {
        setStatus(`Kanogoma ✓ 学到 ${added} 个新读音，未找到可直接匹配的同步歌词行，正在重新渲染本地注音...`);
        await loadLrcFromText(lrcText);
      }
    } else {
      const fakeLrc = buildFakeLrcFromPlainText(data.lines.map(line => line.text).join('\n'));
      $('#lrc-text').value = fakeLrc;
      await renderLyrics(buildTimedLinesFromKanogoma(data.lines));
      switchToTimerMode();
      setStatus(`Kanogoma ✓ 已显示歌词、注音、罗马音和中文翻译（无时间轴，请使用计时模式）。`);
    }
  } catch (e) {
    setStatus('Kanogoma 载入失败：' + e.message, true);
  }
}

/* ---------------- Init: warm up kuroshiro on first interaction ---------------- */
let warmed = false;

function formatKuroshiroInitError(err) {
  const raw = typeof err === 'string'
    ? err
    : err?.message || err?.reason || err?.toString?.() || '未知错误';

  if (location.protocol === 'file:') {
    return '当前是直接打开 HTML（file://）。部分浏览器会拦截本地词典请求，请改用本地服务器或 GitHub Pages 打开。';
  }
  return raw;
}

const warm = () => {
  if (warmed) return;
  warmed = true;
  ensureKuroshiro().catch(err => {
    setStatus('分词器加载失败：' + formatKuroshiroInitError(err) + ' · 点击页面任意位置重试', true);
    // allow retry on next user interaction
    warmed = false;
    kuroshiroFailed = false;
  });
};
document.addEventListener('click', warm, { once: false });
document.addEventListener('touchstart', warm, { once: false, passive: true });
