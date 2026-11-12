// 联网搜索歌词：网易云 / LRCLIB / 曲库，结果可「新建到曲库」或「绑定到当前歌曲（保留音频）」
import { $, $$, h, escapeHTML, toast, bus, setStatus } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { openSong, autoEnrich, marumaruCandidates, applyMarumaru } from './song.js';

let reqId = 0;

function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function openSearch({ q = '', bind = null } = {}) {
  const dlg = $('#dlg-search');
  const input = $('#sr-q');
  if (q) input.value = q;
  else if (!input.value && state.song) input.value = [state.song.title, state.song.artist].filter(Boolean).join(' ');
  const canBind = !!state.song;
  $('#sr-bind-row').hidden = !canBind;
  if (canBind) {
    $('#sr-bind-name').textContent = `「${state.song.title}」`;
    $('#sr-bind').checked = bind ?? (!!state.song.audio && !state.song.lines?.length);
  }
  if (!dlg.open) dlg.showModal();
  input.focus();
  input.select();
  if (q) doSearch();
}

function setTab(src) {
  $$('#dlg-search .sr-tab').forEach(t => t.classList.toggle('active', t.dataset.src === src));
  $$('#dlg-search .sr-pane').forEach(p => { p.hidden = p.dataset.pane !== src; });
}

function setDot(src, st) {
  const dot = $(`#dlg-search .sr-tab[data-src="${src}"] .dot`);
  if (dot) dot.dataset.state = st;
}

async function doSearch() {
  const q = $('#sr-q').value.trim();
  if (!q) return;
  const id = ++reqId;
  const panes = { netease: $('#sr-netease'), lrclib: $('#sr-lrclib'), library: $('#sr-library') };
  Object.values(panes).forEach(p => p.replaceChildren(h('div', { class: 'muted pad', text: '搜索中…' })));
  setDot('netease', 'loading');
  setDot('lrclib', 'loading');

  // 曲库：本地即时过滤
  const lq = q.toLowerCase();
  const libHits = state.songs.filter(s => lq.split(/\s+/).every(tok => `${s.title} ${s.artist}`.toLowerCase().includes(tok)));
  panes.library.replaceChildren(...(libHits.length ? libHits.map(s => resultItem({
    title: s.title, meta: `${s.artist || ''} · ${s.lineCount} 行${s.hasAudio ? ' · 有音频' : ''}`, badge: '曲库',
    onClick: async () => { $('#dlg-search').close(); await openSong(s.id); },
  })) : [h('div', { class: 'muted pad', text: '曲库中没有匹配的歌曲' })]));
  setDot('library', libHits.length ? 'done' : 'empty');

  const counts = { netease: 0, lrclib: 0 };
  const settle = () => {
    const active = $('#dlg-search .sr-tab.active')?.dataset.src;
    if (active && active !== 'library' && counts[active] === 0) {
      const better = ['netease', 'lrclib'].find(s => counts[s] > 0);
      if (better) setTab(better);
    }
  };

  api.online.neteaseSearch(q).then(res => {
    if (id !== reqId) return;
    const list = res.results || [];
    counts.netease = list.length;
    setDot('netease', list.length ? 'done' : 'empty');
    panes.netease.replaceChildren(...(list.length ? list.map(item => resultItem({
      title: item.title, badge: '网易云',
      meta: [item.artist, item.album, fmtDur((item.duration || 0) / 1000)].filter(Boolean).join(' · '),
      onClick: () => loadNetease(item),
    })) : [h('div', { class: 'muted pad', text: '网易云未找到匹配歌曲' })]));
    settle();
  }).catch(e => {
    if (id !== reqId) return;
    setDot('netease', 'error');
    panes.netease.replaceChildren(h('div', { class: 'error pad', text: '网易云搜索失败：' + e.message }));
    settle();
  });

  api.online.lrclibSearch(q).then(res => {
    if (id !== reqId) return;
    const list = res.results || [];
    counts.lrclib = list.length;
    setDot('lrclib', list.length ? 'done' : 'empty');
    panes.lrclib.replaceChildren(...(list.length ? list.map(item => resultItem({
      title: item.trackName, badge: item.syncedLyrics ? '同步' : '纯文本',
      meta: [item.artistName, item.albumName, fmtDur(item.duration)].filter(Boolean).join(' · '),
      onClick: () => loadLrclib(item),
    })) : [h('div', { class: 'muted pad', text: 'LRCLIB 未找到' })]));
    settle();
  }).catch(e => {
    if (id !== reqId) return;
    setDot('lrclib', 'error');
    panes.lrclib.replaceChildren(h('div', { class: 'error pad', text: 'LRCLIB 搜索失败：' + e.message }));
    settle();
  });
}

function resultItem({ title, meta, badge, onClick }) {
  const el = h('button', { type: 'button', class: 'sr-item', html: `
    <div class="sr-title">${escapeHTML(title || '(无标题)')}${badge ? ` <span class="badge">${escapeHTML(badge)}</span>` : ''}</div>
    <div class="sr-meta">${escapeHTML(meta || '')}</div>` });
  el.addEventListener('click', async () => {
    if (el.disabled) return;
    el.disabled = true;
    el.classList.add('loading');
    try { await onClick(); } finally { el.disabled = false; el.classList.remove('loading'); }
  });
  return el;
}

const binding = () => !$('#sr-bind-row').hidden && $('#sr-bind').checked && state.song;

/** 统一落库：绑定到当前歌曲 或 新建/复用曲库条目 */
async function commitLyrics({ source, sourceId, title, artist, album, duration, lines, timeline }) {
  let song;
  if (binding()) {
    const cur = state.song;
    if (cur.lines?.length && !confirm(`用「${title}」的歌词替换当前歌曲的歌词？\n（原文相同的行会保留你的分词/读音修改，可在修改历史中撤销）`)) return null;
    song = await api.replaceLyrics(cur.id, { lines, timeline, keepEdits: true, note: `绑定${source}歌词：${title}`, source, sourceId });
    if (!cur.artist && artist) await api.patchSong(cur.id, { artist });
    await openSong(cur.id, { keepPosition: true });
  } else {
    const res = await api.importSong({ source, sourceId, title, artist, album, duration, lines, timeline });
    song = res.song;
    await openSong(song.id);
    if (res.existed) toast('曲库中已有这首歌，已打开（保留了你之前的修改）');
  }
  $('#dlg-search').close();
  bus.emit('library:refresh');
  return song;
}

async function loadNetease(item) {
  setStatus(`正在载入网易云歌词：${item.title}…`);
  let data;
  try {
    data = await api.online.neteaseLyric(item.id);
  } catch (e) {
    toast('网易云载入失败：' + e.message, { error: true });
    return;
  }
  const lines = (data.lines || []).map(l => ({
    time: Number(l.time),
    end: Number(l.duration) > 0 ? Number(l.time) + Number(l.duration) : null,
    text: l.text || '',
    zh: l.zh || '',
    wordTiming: Array.isArray(l.wordTiming) && l.wordTiming.length ? l.wordTiming : null,
  })).filter(l => Number.isFinite(l.time) && l.text);
  if (!lines.length) { toast('该结果没有可用歌词', { error: true }); return; }
  const song = await commitLyrics({
    source: 'netease', sourceId: String(data.id || item.id),
    title: data.title || item.title, artist: data.artist || item.artist, album: data.album || item.album,
    duration: (item.duration || 0) / 1000, lines, timeline: 'synced',
  });
  if (song) {
    setStatus('已载入，正在后台补充 Marumaru 注音…');
    autoEnrich(state.song, { marumaru: true, timing: !lines.some(l => l.wordTiming) }).then(() => setStatus(''));
  }
}

async function loadLrclib(item) {
  const text = item.syncedLyrics || item.plainLyrics || '';
  if (!text) { toast('该结果没有歌词内容', { error: true }); return; }
  const parsed = await api.parseLrc(text);
  const song = await commitLyrics({
    source: 'lrclib', sourceId: String(item.id), title: item.trackName, artist: item.artistName,
    album: item.albumName, duration: item.duration, lines: parsed.lines, timeline: parsed.timeline,
  });
  if (song) {
    setStatus('已载入，正在后台补充 Marumaru 注音与中文…');
    autoEnrich(state.song, { marumaru: true, timing: true }).then(() => setStatus(''));
  }
}

// ---------------------------------------------------------------- Marumaru 候选（手动）
export async function openMarumaru() {
  if (!state.song) return;
  const dlg = $('#dlg-marumaru');
  const list = $('#mm-list');
  list.replaceChildren(h('div', { class: 'muted pad', text: '正在搜索 Marumaru…' }));
  dlg.showModal();
  try {
    const cands = await marumaruCandidates();
    if (!cands.length) { list.replaceChildren(h('div', { class: 'muted pad', text: '没有找到候选。可先在「歌曲信息」中修正歌名/歌手再试。' })); return; }
    list.replaceChildren(...cands.map(c => resultItem({
      title: c.title, meta: c.artist || '', badge: 'Marumaru',
      onClick: async () => {
        try { await applyMarumaru(c); dlg.close(); } catch (e) { toast('Marumaru 失败：' + e.message, { error: true }); }
      },
    })));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'error pad', text: 'Marumaru 搜索失败：' + e.message }));
  }
}

export function initSearch() {
  $('#sr-form').addEventListener('submit', e => { e.preventDefault(); doSearch(); });
  $$('#dlg-search .sr-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.src)));
  $('#sr-close').addEventListener('click', () => $('#dlg-search').close());
  $('#mm-close').addEventListener('click', () => $('#dlg-marumaru').close());
  bus.on('search:open', opts => openSearch(opts || {}));
  setTab('netease');
}
