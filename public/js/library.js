// 曲库侧栏 + 导入本地歌曲（音频 / NCM / LRC）+ 歌曲信息编辑
import { $, $$, h, escapeHTML, toast, bus, setStatus } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { openSong, updateSongHeader } from './song.js';
import { loadSongAudio } from './player.js';
import { readTextFile } from './editor.js';

const SOURCE_LABEL = { local: '本地', netease: '网易云', lrclib: 'LRCLIB', marumaru: 'Marumaru' };

export async function refreshLibrary() {
  try {
    state.songs = await api.songs();
  } catch (e) {
    toast('曲库加载失败：' + e.message, { error: true });
    state.songs = [];
  }
  renderLibrary();
}

function renderLibrary() {
  const q = $('#lib-filter').value.trim().toLowerCase();
  const list = $('#lib-list');
  const items = state.songs.filter(s => !q || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q));
  $('#lib-count').textContent = String(state.songs.length);
  if (!items.length) {
    list.replaceChildren(h('div', { class: 'lib-empty muted', text: state.songs.length ? '没有匹配的歌曲' : '曲库为空。导入本地歌曲或联网搜索歌词后会保存在这里。' }));
    return;
  }
  list.replaceChildren(...items.map(s => {
    const badges = [];
    if (s.hasAudio) badges.push('<span class="badge ok" title="已上传音频">♪ 音频</span>');
    if (s.timeline === 'synced') badges.push('<span class="badge" title="有同步时间轴">同步</span>');
    else if (s.timeline === 'synthetic') badges.push('<span class="badge warn" title="纯文本歌词，时间为估算，可打轴">估算</span>');
    else badges.push('<span class="badge warn">无歌词</span>');
    if (s.editedCount) badges.push(`<span class="badge edit" title="手动修改过的行">✎ ${s.editedCount}</span>`);
    const item = h('button', {
      type: 'button',
      class: `lib-item${state.song?.id === s.id ? ' current' : ''}`,
      dataset: { id: s.id },
      html: `<div class="lib-title">${escapeHTML(s.title || '未命名')}</div>
             <div class="lib-meta">${escapeHTML(s.artist || '')}${s.artist ? ' · ' : ''}${SOURCE_LABEL[s.source] || s.source} · ${s.lineCount} 行</div>
             <div class="lib-badges">${badges.join('')}</div>`,
    });
    item.addEventListener('click', async () => {
      await openSong(s.id);
      renderLibrary();
      if (window.matchMedia('(max-width: 900px)').matches) toggleSidebar(false);
    });
    return item;
  }));
}

export function toggleSidebar(force) {
  const open = force ?? !document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', open);
}

// ---------------------------------------------------------------- NCM 解码（Web Worker，本机完成）
function decodeNcm(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('ncm-worker.js');
    worker.onmessage = (e) => {
      worker.terminate();
      const d = e.data;
      if (d.error) { reject(new Error(d.error)); return; }
      const blob = new Blob([d.buffer.slice(d.offset)], { type: d.mime });
      const ext = { 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[d.mime] || 'mp3';
      resolve({ blob, ext, format: d.format, meta: d.meta });
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'NCM 解析失败')); };
    worker.postMessage(file);
  });
}

/** 判断是否 NCM 文件：扩展名或文件头魔数（Android 选择器可能返回无扩展名的文件名）。 */
export async function isNcmFile(file) {
  if (/\.ncm$/i.test(file.name || '')) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return String.fromCharCode(...head) === 'CTENFDAM';
  } catch {
    return false;
  }
}

/** 统一准备上传的音频：NCM 先还原；返回 {blob, filename, meta} */
export async function prepareAudio(file) {
  if (await isNcmFile(file)) {
    setStatus('正在本机还原 NCM…');
    const res = await decodeNcm(file);
    setStatus(`NCM 已还原为 ${res.format}`);
    const base = file.name.replace(/\.ncm$/i, '');
    return { blob: res.blob, filename: `${base}.${res.ext}`, meta: res.meta };
  }
  return { blob: file, filename: file.name, meta: null };
}

// ---------------------------------------------------------------- 导入对话框
// 一次选择 / 拖入多个文件，自动识别「歌曲」与「歌词」：扩展名 → MIME → 文件头魔数 / 文本内容。
// 多首歌一起导入时按文件名配对（「歌手 - 歌名.mp3」配「歌手 - 歌名.lrc」）。
const AUDIO_EXT = new Set(['mp3', 'm4a', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'webm', 'ncm', 'wma', 'ape']);
const LYRIC_EXT = new Set(['lrc', 'txt', 'krc', 'qrc']);
const imp = { files: [], songs: [] };   // files: [{file, kind, text?, prepared?, meta?}]

const baseName = (name) => String(name || '').replace(/\.[^.]+$/, '');
const normName = (name) => baseName(name).toLowerCase()
  .replace(/[\s　_\-－—–~〜()（）\[\]【】「」『』.,，。・･'"]+/g, '');

async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const str = String.fromCharCode(...head);
  if (str.startsWith('CTENFDAM')) return 'audio';
  if (str.startsWith('ID3') || str.startsWith('fLaC') || str.startsWith('OggS') || str.startsWith('RIFF')
      || str.slice(4, 8) === 'ftyp' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio';
  if (file.size < 2 * 1024 * 1024) {
    const text = await readTextFile(file.slice(0, 64 * 1024));
    if (/\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(text) || /[぀-ヿ一-鿿]/.test(text)) return 'lyrics';
  }
  return 'unknown';
}

async function classify(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (LYRIC_EXT.has(ext)) return 'lyrics';
  if ((file.type || '').startsWith('audio/')) return 'audio';
  if ((file.type || '').startsWith('text/')) return 'lyrics';
  return sniff(file);
}

function guessFromName(name) {
  const stem = baseName(name).trim();
  const m = stem.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: stem, artist: '' };
}

function lrcMeta(text) {
  const ti = text.match(/^\s*\[ti:(.*)\]\s*$/mi)?.[1]?.trim() || '';
  const ar = text.match(/^\s*\[ar:(.*)\]\s*$/mi)?.[1]?.trim() || '';
  return { title: ti, artist: ar };
}

/** 文件 → 待导入歌曲列表 [{audio, lyrics, title, artist}] */
function pairFiles() {
  const audios = imp.files.filter(f => f.kind === 'audio');
  const lyrics = imp.files.filter(f => f.kind === 'lyrics');
  const songs = [];
  const used = new Set();
  if (audios.length <= 1) {
    // 单首：唯一的音频 + 最像的那份歌词（同名优先，其次带时间标签的）
    const audio = audios[0] || null;
    let lyric = null;
    if (lyrics.length) {
      const key = audio ? normName(audio.file.name) : '';
      lyric = lyrics.find(l => key && normName(l.file.name) === key)
        || lyrics.find(l => /\[\d{1,3}:\d{2}/.test(l.text || ''))
        || lyrics[0];
      used.add(lyric);
    }
    if (audio || lyric) songs.push({ audio, lyric });
  } else {
    for (const a of audios) {
      const key = normName(a.file.name);
      let lyric = lyrics.find(l => !used.has(l) && normName(l.file.name) === key)
        || lyrics.find(l => !used.has(l) && (normName(l.file.name).includes(key) || key.includes(normName(l.file.name))));
      if (lyric) used.add(lyric);
      songs.push({ audio: a, lyric: lyric || null });
    }
  }
  // 没配上音频的歌词也各自成为一首（只有歌词）
  if (audios.length > 1) lyrics.filter(l => !used.has(l)).forEach(l => songs.push({ audio: null, lyric: l }));
  for (const sg of songs) {
    const fromNcm = sg.audio?.meta;
    const fromLrc = sg.lyric ? lrcMeta(sg.lyric.text || '') : {};
    const fromName = guessFromName((sg.audio || sg.lyric).file.name);
    sg.title = fromNcm?.title || fromLrc.title || fromName.title;
    sg.artist = fromNcm?.artist || fromLrc.artist || fromName.artist;
  }
  imp.songs = songs;
  imp.unused = lyrics.filter(l => !used.has(l) && audios.length <= 1);
}

function renderImport() {
  pairFiles();
  const list = $('#imp-filelist');
  const single = imp.songs.length <= 1;
  $('#imp-single').hidden = !single;
  list.replaceChildren(...imp.files.map((f, i) => {
    const extra = f.kind === 'audio' && f.prepared && f.prepared.filename !== f.file.name ? ` → ${f.prepared.filename.split('.').pop().toUpperCase()}` : '';
    const row = h('div', { class: `imp-file kind-${f.kind}` },
      h('select', { class: 'imp-kind', 'aria-label': '文件类型', title: '识别错了可以手动改' },
        h('option', { value: 'audio', text: '🎵 歌曲', selected: f.kind === 'audio' }),
        h('option', { value: 'lyrics', text: '📝 歌词', selected: f.kind === 'lyrics' }),
        h('option', { value: 'unknown', text: '忽略', selected: f.kind === 'unknown' })),
      h('span', { class: 'imp-fname', title: f.file.name, text: f.file.name + extra }),
      h('span', { class: 'muted small', text: `${(f.file.size / 1048576).toFixed(f.file.size > 1048576 ? 1 : 2)} MB` }),
      h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': '移除', text: '×' }));
    row.querySelector('select').addEventListener('change', async (e) => {
      f.kind = e.target.value;
      if (f.kind === 'lyrics' && f.text === undefined) f.text = await readTextFile(f.file);
      renderImport();
    });
    row.querySelector('button').addEventListener('click', () => { imp.files.splice(i, 1); renderImport(); });
    return row;
  }));
  const summary = $('#imp-summary');
  if (!imp.files.length) {
    summary.textContent = '';
  } else if (single) {
    const sg = imp.songs[0];
    summary.textContent = sg
      ? `将导入 1 首：${sg.audio ? '有音频' : '无音频'} · ${sg.lyric ? '有歌词' : '无歌词'}`
        + (imp.unused?.length ? `（另有 ${imp.unused.length} 份歌词未使用）` : '')
      : '';
    if (sg) {
      if (!$('#imp-title').dataset.touched) $('#imp-title').value = sg.title || '';
      if (!$('#imp-artist').dataset.touched) $('#imp-artist').value = sg.artist || '';
      if (!$('#imp-lrc').dataset.touched) $('#imp-lrc').value = sg.lyric?.text || '';
    }
  } else {
    summary.replaceChildren(
      h('div', { text: `将导入 ${imp.songs.length} 首（按文件名配对）：` }),
      ...imp.songs.map(sg => h('div', { class: 'imp-pair' },
        h('b', { text: sg.title || '未命名' }), sg.artist ? ` · ${sg.artist}` : '',
        h('span', { class: 'muted small', text: `  ${sg.audio ? '🎵' : '—'} ${sg.lyric ? '📝 ' + sg.lyric.file.name : '无歌词'}` }))));
  }
  $('#imp-submit').textContent = imp.songs.length > 1 ? `导入 ${imp.songs.length} 首` : '导入';
}

async function addFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    const entry = { file, kind: await classify(file) };
    if (entry.kind === 'lyrics') entry.text = await readTextFile(file);
    imp.files.push(entry);
  }
  renderImport();
  // NCM 先在本机还原（并读出歌名 / 歌手）
  for (const entry of imp.files) {
    if (entry.kind === 'audio' && !entry.prepared && await isNcmFile(entry.file)) {
      try {
        entry.prepared = await prepareAudio(entry.file);
        entry.meta = entry.prepared.meta;
      } catch (e) {
        toast(`NCM 还原失败（${entry.file.name}）：${e.message}`, { error: true });
        entry.kind = 'unknown';
      }
      renderImport();
    }
  }
}

export function openImport(files = [], { pick = false } = {}) {
  imp.files = [];
  imp.songs = [];
  for (const id of ['#imp-title', '#imp-artist', '#imp-lrc']) { $(id).value = ''; delete $(id).dataset.touched; }
  $('#imp-progress').hidden = true;
  $('#imp-submit').disabled = false;
  renderImport();
  if (!$('#dlg-import').open) $('#dlg-import').showModal();
  if (files.length) addFiles(files);
  else if (pick) $('#imp-files').click();
}

function songFormData(sg, overrides = {}) {
  const fd = new FormData();
  fd.append('title', overrides.title ?? sg.title ?? '');
  fd.append('artist', overrides.artist ?? sg.artist ?? '');
  fd.append('lrc', overrides.lrc ?? sg.lyric?.text ?? '');
  return fd;
}

async function submitImport() {
  pairFiles();
  const single = imp.songs.length <= 1;
  let jobs;
  if (single) {
    const sg = imp.songs[0] || { audio: null, lyric: null };
    const lrc = $('#imp-lrc').value;
    if (!sg.audio && !lrc.trim()) { toast('请选择音频 / 歌词文件，或粘贴歌词', { error: true }); return; }
    jobs = [{ sg, fd: songFormData(sg, { title: $('#imp-title').value.trim(), artist: $('#imp-artist').value.trim(), lrc }) }];
  } else {
    jobs = imp.songs.map(sg => ({ sg, fd: songFormData(sg) }));
  }
  $('#imp-submit').disabled = true;
  $('#imp-progress').hidden = false;
  const created = [];
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { sg, fd } = jobs[i];
      if (sg.audio) {
        const prepared = sg.audio.prepared || await prepareAudio(sg.audio.file);
        fd.append('audio', prepared.blob, prepared.filename);
      }
      setStatus(jobs.length > 1 ? `导入 ${i + 1}/${jobs.length}：${sg.title || ''}` : '正在上传…');
      const song = await api.createSong(fd, (p) => {
        $('#imp-progress-bar').style.width = `${Math.round(((i + p) / jobs.length) * 100)}%`;
      });
      created.push(song);
    }
    $('#dlg-import').close();
    await refreshLibrary();
    const first = created[0];
    await openSong(first.id);
    renderLibrary();
    toast(created.length > 1 ? `已导入 ${created.length} 首` : `已导入「${first.title}」`);
    setStatus('');
    if (created.length === 1 && !first.lines?.length && $('#imp-autosearch').checked) {
      bus.emit('search:open', { q: [first.title, first.artist].filter(Boolean).join(' '), bind: true });
    }
  } catch (e) {
    toast('导入失败：' + e.message, { error: true });
    if (created.length) refreshLibrary();
  } finally {
    $('#imp-submit').disabled = false;
  }
}

// ---------------------------------------------------------------- 歌曲信息
export function openSongInfo() {
  const s = state.song;
  if (!s) return;
  $('#si-title').value = s.title || '';
  $('#si-artist').value = s.artist || '';
  $('#si-album').value = s.album || '';
  $('#si-audio').textContent = s.audio ? `${s.audio.name}（${(s.audio.size / 1048576).toFixed(1)} MB）` : '未上传';
  $('#si-remove-audio').hidden = !s.audio;
  $('#dlg-info').showModal();
}

async function replaceAudio(file) {
  const s = state.song;
  if (!s || !file) return;
  try {
    const prepared = await prepareAudio(file);
    setStatus('正在上传音频…');
    const song = await api.uploadAudio(s.id, prepared.blob, prepared.filename, p => setStatus(`正在上传音频 ${Math.round(p * 100)}%`));
    state.song.audio = song.audio;
    state.song.updatedAt = song.updatedAt;
    loadSongAudio(state.song);
    setStatus('音频已更新');
    toast('音频已保存在本机浏览器，下次打开无需重新上传');
    refreshLibrary();
    if ($('#dlg-info').open) openSongInfo();
  } catch (e) {
    toast('上传失败：' + e.message, { error: true });
  }
}

export function initLibrary() {
  $('#lib-filter').addEventListener('input', renderLibrary);
  $('#btn-sidebar').addEventListener('click', () => toggleSidebar());
  $('#sidebar-scrim').addEventListener('click', () => toggleSidebar(false));
  $$('[data-cmd="import"]').forEach(b => b.addEventListener('click', () => openImport([], { pick: true })));

  $('#imp-files').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addFiles(fs); });
  ['#imp-title', '#imp-artist', '#imp-lrc'].forEach(id => $(id).addEventListener('input', () => { $(id).dataset.touched = '1'; }));
  $('#imp-submit').addEventListener('click', submitImport);
  $('#imp-cancel').addEventListener('click', () => $('#dlg-import').close());
  const drop = $('#imp-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  // 拖文件到页面任意位置：打开导入框
  window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (e.target.closest?.('#imp-drop')) return;
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    if ($('#dlg-import').open) addFiles(e.dataTransfer.files);
    else openImport([...e.dataTransfer.files]);
  });

  $('#si-save').addEventListener('click', async () => {
    const patch = { title: $('#si-title').value.trim(), artist: $('#si-artist').value.trim(), album: $('#si-album').value.trim() };
    try {
      const song = await api.patchSong(state.song.id, patch);
      Object.assign(state.song, { title: song.title, artist: song.artist, album: song.album });
      updateSongHeader();
      refreshLibrary();
      $('#dlg-info').close();
    } catch (e) { toast('保存失败：' + e.message, { error: true }); }
  });
  $('#si-audio-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; replaceAudio(f); });
  $('#si-remove-audio').addEventListener('click', async () => {
    if (!confirm('删除这首歌的音频文件？歌词与修改会保留。')) return;
    const song = await api.deleteAudio(state.song.id);
    state.song.audio = song.audio;
    loadSongAudio(state.song);
    refreshLibrary();
    openSongInfo();
  });
  $('#si-delete').addEventListener('click', async () => {
    const s = state.song;
    if (!confirm(`从曲库删除「${s.title}」？音频、歌词和全部修改记录都会被删除，无法恢复。`)) return;
    await api.deleteSong(s.id);
    $('#dlg-info').close();
    state.song = null;
    try { localStorage.removeItem('jls-last-song'); } catch {}
    bus.emit('song:closed');
    refreshLibrary();
  });
  $('#si-cancel').addEventListener('click', () => $('#dlg-info').close());
  bus.on('song:opened', refreshLibrary);
  bus.on('library:refresh', refreshLibrary);
  bus.on('audio:replace', replaceAudio);
}
