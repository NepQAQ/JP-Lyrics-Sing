// 歌词渲染：行 → 单词（注音 / 罗马音 / 标记 / 样式）
import { $, escapeHTML, h } from './util.js';
import { state } from './state.js';
import { rubyHTML } from './kana.js';
import { lineRomaji } from './analyzer.js';

export const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>',
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/></svg>',
};

const TONE_GLYPH = { 1: 'ˉ', 2: 'ˊ', 3: 'ˇ', 4: 'ˋ' };

function wordClasses(w, colorIdx) {
  const cls = ['w'];
  if (w.p) cls.push('w-p');
  else cls.push(`c${colorIdx % 4}`);
  const m = w.m || {};
  if (m.hl) cls.push(`hl-${m.hl}`);
  if (m.box) cls.push('mk-box');
  if (m.note) cls.push('has-note');
  if (m.link) cls.push('mk-link');
  if (m.brk) cls.push('mk-brk');
  return cls.join(' ');
}

function romajiWordHTML(w, i, colorIdx) {
  const m = w.m || {};
  const tone = m.tone ? `<sup class="tone">${TONE_GLYPH[m.tone] || ''}</sup>` : '';
  const cls = ['rw', `c${colorIdx % 4}`];
  if (m.hl) cls.push(`hl-${m.hl}`);
  if (m.box) cls.push('mk-box');
  return `<span class="${cls.join(' ')}" data-wi="${i}">${escapeHTML(w.r || '')}${tone}</span>`;
}

/** .jp 区域 HTML */
export function jpHTML(line, { inline = false } = {}) {
  const script = state.settings.kanaScript || 'hiragana';
  if (!Array.isArray(line.words) || !line.words.length) {
    return `<span class="w pending">${escapeHTML(line.text)}</span>`;
  }
  let color = 0;
  return line.words.map((w, i) => {
    const ci = w.p ? 0 : color++;
    const note = w.m?.note ? ` data-note="${escapeHTML(w.m.note)}"` : '';
    const title = w.m?.note ? ` title="${escapeHTML(w.m.note)}"` : '';
    const ruby = w.p ? escapeHTML(w.t) : rubyHTML(w.t, w.k, script, escapeHTML);
    if (!inline) {
      return `<span class="${wordClasses(w, ci)}" data-wi="${i}"${note}${title}>${ruby}</span>`;
    }
    const tone = w.m?.tone ? `<sup class="tone">${TONE_GLYPH[w.m.tone]}</sup>` : '';
    const ro = w.p ? '&nbsp;' : `${escapeHTML(w.r || '')}${tone}`;
    return `<span class="${wordClasses(w, ci)}" data-wi="${i}"${note}${title}>`
      + `<span class="w-jp">${ruby}</span><span class="w-ro">${ro}</span></span>`;
  }).join('');
}

/** .ro 区域 HTML（逐词 span，与 .jp 的 data-wi 对应，悬停互相高亮） */
export function romajiHTML(line) {
  if (line.romaji) return `<span class="ro-override">${escapeHTML(line.romaji)}</span>`;
  if (!Array.isArray(line.words)) return '';
  let color = 0;
  const parts = [];
  line.words.forEach((w, i) => {
    if (w.p) return;
    const ci = color++;
    if (!w.r) return;
    parts.push(romajiWordHTML(w, i, ci));
    parts.push(w.m?.brk ? ' <span class="ro-brk">/</span> ' : (w.m?.link ? '<span class="ro-link">‿</span>' : ' '));
  });
  return parts.join('').trim();
}

export function renderLineContent(line) {
  const el = line._el;
  if (!el) return;
  const inline = state.settings.layout === 'inline';
  const jp = el.querySelector('.jp');
  jp.innerHTML = jpHTML(line, { inline });
  jp._karaoke = null;
  const ro = el.querySelector('.ro');
  ro.innerHTML = inline && !line.romaji ? '' : romajiHTML(line);
  ro._karaoke = null;
  ro.classList.toggle('empty', !ro.textContent.trim());
  el.querySelector('.zh').textContent = line.zh || '';
  el.classList.toggle('long', [...(line.text || '')].length >= (state.settings.longLineChars || 14));
  el.classList.toggle('edited', !!(line.wordsEdited || line.romaji));
  el.classList.toggle('analyzing', !Array.isArray(line.words));
}

function lineElement(line, idx) {
  const el = h('div', { class: 'line', dataset: { id: line.id, idx: String(idx) } });
  el.innerHTML = `
    <div class="line-body">
      <div class="jp" lang="ja"></div>
      <div class="ro"></div>
      <div class="zh" lang="zh-CN"></div>
    </div>
    <div class="line-tools">
      <button type="button" class="tool" data-act="play" title="播放这一句（再点停止）" aria-label="播放这一句">${ICONS.play}</button>
      <button type="button" class="tool" data-act="speak" title="朗读（TTS）" aria-label="朗读这一句">${ICONS.speak}</button>
      <button type="button" class="tool" data-act="edit" title="编辑这一行：原文 / 分词 / 读音 / 罗马音 / 中文" aria-label="编辑这一行">${ICONS.edit}</button>
    </div>`;
  return el;
}

export function renderSong() {
  const view = $('#lyrics');
  view.replaceChildren();
  state.activeIdx = -1;
  const song = state.song;
  if (!song) {
    view.append(emptyCard('welcome'));
    return;
  }
  if (!song.lines?.length) {
    view.append(emptyCard('nolyrics'));
    return;
  }
  view.append(h('div', { class: 'spacer top' }));
  song.lines.forEach((line, i) => {
    line._el = lineElement(line, i);
    renderLineContent(line);
    view.append(line._el);
  });
  view.append(h('div', { class: 'spacer bottom' }));
  view.scrollTop = 0;
}

export function rerenderAllLines() {
  state.song?.lines?.forEach(renderLineContent);
}

/** 时间改动后行顺序可能变化：重新渲染整首但保留滚动位置 */
export function rerenderPreservingScroll() {
  const view = $('#lyrics');
  const top = view.scrollTop;
  renderSong();
  view.scrollTop = top;
}

function emptyCard(kind) {
  if (kind === 'welcome') {
    return h('div', { class: 'empty-card', html: `
      <h2>开始练习</h2>
      <p>从左侧<b>曲库</b>选择歌曲，或<b>导入本地音频 + 歌词</b>（支持 mp3 / m4a / flac / ncm 与 LRC）。</p>
      <p>也可以 <b>联网搜索</b> 歌词（网易云 / LRCLIB），结果会自动保存到曲库。</p>
      <div class="empty-actions">
        <button type="button" class="btn primary" data-cmd="import">导入本地歌曲</button>
        <button type="button" class="btn" data-cmd="search">联网搜索歌词</button>
      </div>
      <p class="muted small">快捷键：空格 播放/暂停 · ←/→ 上/下一句 · [ / ] 调速 · R 单句循环 · E 编辑模式</p>` });
  }
  return h('div', { class: 'empty-card', html: `
    <h2>这首歌还没有歌词</h2>
    <p>可以联网搜索并绑定到当前歌曲（保留已上传的音频），或者粘贴 / 上传 LRC。</p>
    <div class="empty-actions">
      <button type="button" class="btn primary" data-cmd="search-bind">联网搜索歌词</button>
      <button type="button" class="btn" data-cmd="fulltext">粘贴 / 上传 LRC</button>
    </div>` });
}

/** 把显示设置映射到 body 上的 class，CSS 据此切换样式 */
export function applyDisplayClasses() {
  const s = state.settings;
  const b = document.body;
  b.classList.toggle('hide-furigana', !s.showFurigana);
  b.classList.toggle('hide-romaji', !s.showRomaji);
  b.classList.toggle('hide-zh', !s.showZh);
  b.classList.toggle('mode-read', s.viewMode === 'read');
  b.classList.toggle('mode-sing', s.viewMode !== 'read');
  b.classList.toggle('layout-inline', s.layout === 'inline');
  b.dataset.wordStyle = s.wordStyle || 'box';
  b.classList.toggle('ws-long-only', !!s.wordStyleLongOnly);
  document.documentElement.style.setProperty('--font-scale', String(s.fontScale || 1));
  const theme = s.theme || 'auto';
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
