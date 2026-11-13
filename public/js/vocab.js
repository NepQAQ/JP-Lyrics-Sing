// 单词本：自动从歌词整理单词（vocab-core.js 按 line.words 统计，始终跟随你对分词 / 读音的编辑），
// 显示 平假名 / 片假名 / 罗马音 / 原形 / 释义 / 例句；释义可自动机器翻译（复用 api.online.translate
// 的 MyMemory 路径），也可手动修改（手动的不会被覆盖）。笔记存进设置（vocabNotes），随云同步传播。
import { $, h, escapeHTML, toast, bus, debounce, downloadText } from './util.js';
import { state, lineById } from './state.js';
import { api } from './api.js';
import { rubyHTML, toHiragana, toKatakana, kanaToRomaji } from './kana.js';
import { baseFormOf, ensureTokenizer } from './analyzer.js';
import { speak } from './tts.js';

const vs = {
  entries: [],
  scope: 'song',          // song | all | starred
  loading: false,
  translating: false,
  autoTried: new Set(),   // 本次会话已自动翻译过的歌曲
};

function scopeSongId() {
  return vs.scope === 'song' ? state.song?.id : 'all';
}

export async function openVocab() {
  if (vs.scope === 'song' && !state.song) vs.scope = 'all';
  $('#vb-scope').value = vs.scope;
  await loadVocab();
}

async function loadVocab() {
  const sid = scopeSongId();
  if (!sid) { renderVocab(); return; }
  vs.loading = true;
  $('#vb-list').replaceChildren(h('div', { class: 'muted pad', text: '正在整理单词…' }));
  try {
    const res = await api.vocab(sid);
    vs.entries = res.entries || [];
  } catch (e) {
    $('#vb-list').replaceChildren(h('div', { class: 'error pad', text: '加载失败：' + e.message }));
    vs.loading = false;
    return;
  }
  vs.loading = false;
  // 原形（辞书形）由浏览器端分词器补充
  try {
    await ensureTokenizer();
    for (const e of vs.entries) {
      const b = baseFormOf(e.t);
      if (b) { e.base = b.base; e.baseKana = b.baseKana; }
    }
  } catch {}
  renderVocab();
  // 当前歌曲第一次打开单词本：自动补全缺失的释义
  if (vs.scope === 'song' && sid && !vs.autoTried.has(sid)) {
    vs.autoTried.add(sid);
    const missing = vs.entries.filter(e => !e.meaning).length;
    if (missing && missing <= 200) translateMissing({ auto: true });
  }
}

function filtered() {
  const q = $('#vb-filter').value.trim().toLowerCase();
  let list = vs.entries;
  if (vs.scope === 'starred') list = list.filter(e => e.starred);
  if (q) {
    const qh = toHiragana(q);
    list = list.filter(e => [e.t, e.k, toHiragana(e.k), e.r, e.base, e.meaning, ...(e.forms || [])]
      .some(x => x && (String(x).toLowerCase().includes(q) || toHiragana(String(x)).includes(qh))));
  }
  const sort = $('#vb-sort').value;
  const arr = [...list];
  if (sort === 'count') arr.sort((a, b) => b.count - a.count);
  else if (sort === 'kana') arr.sort((a, b) => toHiragana(a.k || a.t).localeCompare(toHiragana(b.k || b.t), 'ja'));
  return arr;
}

function renderVocab() {
  const box = $('#vb-list');
  if (vs.scope === 'song' && !state.song) {
    box.replaceChildren(h('div', { class: 'muted pad', text: '还没有打开歌曲。可以在上方切换到「全部歌曲」。' }));
    $('#vb-count').textContent = '';
    return;
  }
  const list = filtered();
  const missing = vs.entries.filter(e => !e.meaning).length;
  $('#vb-count').textContent = `${list.length} 个单词` + (missing ? ` · ${missing} 个缺释义` : '');
  $('#vb-translate').disabled = vs.translating || !missing;
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'muted pad', text: vs.entries.length ? '没有匹配的单词' : '这首歌还没有可整理的单词（歌词分析完成后会自动出现）' }));
    return;
  }
  box.replaceChildren(...list.map(entryRow));
}

function entryRow(e) {
  const script = state.settings.kanaScript || 'hiragana';
  const hira = toHiragana(e.k || '');
  const kata = toKatakana(e.k || '');
  const romaji = e.r || (e.k ? kanaToRomaji(e.k) : '');
  const row = h('div', { class: 'vb-row', dataset: { t: e.t } });
  const star = h('button', { type: 'button', class: `vb-star${e.starred ? ' on' : ''}`, title: e.starred ? '取消收藏' : '收藏', text: e.starred ? '★' : '☆' });
  star.addEventListener('click', async () => {
    e.starred = !e.starred;
    await saveNote(e, { starred: e.starred });
    if (vs.scope === 'starred') renderVocab(); else row.replaceWith(entryRow(e));
  });
  const say = h('button', { type: 'button', class: 'tool', title: '朗读', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>' });
  say.addEventListener('click', () => speak(e.base || e.t));

  const meaning = h('input', { class: 'input vb-mean', value: e.meaning || '', placeholder: '释义（可编辑，自动保存）', lang: 'zh-CN' });
  const tag = h('span', { class: `vb-src ${e.meaningSource || ''}`, text: e.meaning ? (e.meaningSource === 'user' ? '手动' : '机翻') : '' });
  const saveMeaning = debounce(async () => {
    const v = meaning.value.trim();
    if (v === (e.meaning || '')) return;
    e.meaning = v;
    e.meaningSource = 'user';
    tag.textContent = v ? '手动' : '';
    tag.className = 'vb-src user';
    await saveNote(e, { meaning: v, source: 'user' });
  }, 600);
  meaning.addEventListener('input', saveMeaning);

  const examples = (e.examples || []).map(x => {
    const a = h('button', { type: 'button', class: 'vb-ex', title: '跳到这句歌词', lang: 'ja' });
    a.innerHTML = highlightForm(x.text, x.form || e.t) + (x.zh ? `<span class="vb-ex-zh">${escapeHTML(x.zh)}</span>` : '');
    a.addEventListener('click', () => jumpToLine(x.songId, x.lineId));
    return a;
  });
  const songs = vs.scope !== 'song' && e.songs?.length
    ? h('div', { class: 'vb-songs muted small', text: '出自：' + e.songs.map(s => s.title).join('、') }) : null;

  const parts = [
    h('div', { class: 'vb-head' },
      star,
      h('span', { class: 'vb-word', lang: 'ja', html: rubyHTML(e.t, e.k, script, escapeHTML) }),
      say,
      h('span', { class: 'vb-count muted small', text: `×${e.count}` }),
      e.edited ? h('span', { class: 'badge edit', title: '读音来自你编辑过的歌词', text: '已编辑' }) : null),
    h('div', { class: 'vb-read' },
      h('span', { class: 'vb-kana', lang: 'ja', title: '平假名', text: hira || '—' }),
      h('span', { class: 'vb-kana kata', lang: 'ja', title: '片假名', text: kata || '—' }),
      h('span', { class: 'vb-ro', title: '罗马音', text: romaji || '—' })),
    (e.base || (e.altReadings?.length) || (e.forms?.length))
      ? h('div', { class: 'vb-extra muted small', lang: 'ja' },
        e.base ? h('span', { html: `原形：<b>${escapeHTML(e.base)}</b>（${escapeHTML(toHiragana(e.baseKana || ''))}）` }) : null,
        e.altReadings?.length ? h('span', { text: `其它读法：${e.altReadings.join('、')}` }) : null,
        e.forms?.length ? h('span', { text: `歌词中：${e.forms.join('、')}` }) : null)
      : null,
    h('div', { class: 'vb-mean-row' }, meaning, tag),
    examples.length ? h('div', { class: 'vb-exs' }, ...examples) : null,
    songs,
  ];
  row.append(...parts.filter(Boolean));
  return row;
}

function highlightForm(text, form) {
  const i = text.indexOf(form);
  if (i < 0) return escapeHTML(text);
  return escapeHTML(text.slice(0, i)) + `<mark>${escapeHTML(form)}</mark>` + escapeHTML(text.slice(i + form.length));
}

async function saveNote(e, fields) {
  try {
    await api.saveVocabNotes([{ surface: e.t, kana: e.k, ...fields }]);
  } catch (err) {
    toast('保存失败：' + err.message, { error: true });
  }
}

/** 批量机器翻译缺失的释义（动词 / 形容词用原形翻译，结果更像词典释义） */
async function translateMissing({ auto = false } = {}) {
  if (vs.translating) return;
  const todo = vs.entries.filter(e => !e.meaning);
  if (!todo.length) { if (!auto) toast('所有单词都已有释义'); return; }
  vs.translating = true;
  $('#vb-translate').disabled = true;
  const status = $('#vb-status');
  let done = 0;
  try {
    for (let i = 0; i < todo.length; i += 10) {
      const chunk = todo.slice(i, i + 10);
      status.textContent = `正在翻译释义 ${done}/${todo.length}…（MyMemory 免费接口，较慢）`;
      const res = await api.online.translate(chunk.map(e => e.base || e.t));
      const items = [];
      chunk.forEach((e, j) => {
        const m = String(res.results?.[j] || '').trim();
        if (m && !e.meaning) {
          e.meaning = m;
          e.meaningSource = 'auto';
          items.push({ surface: e.t, kana: e.k, meaning: m, source: 'auto' });
        }
      });
      if (items.length) await api.saveVocabNotes(items);
      done += chunk.length;
      if ($('#vocab').offsetParent) renderVocab();
    }
    status.textContent = `释义已补全 ${done} 个（机翻仅供参考，可直接修改）`;
  } catch (e) {
    status.textContent = '翻译失败：' + e.message + (auto ? '（可稍后点「补全释义」重试）' : '');
  } finally {
    vs.translating = false;
    renderVocab();
  }
}

async function jumpToLine(songId, lineId) {
  bus.emit('app:mode', 'lyrics');
  if (state.song?.id !== songId) {
    bus.emit('song:open', songId);
    await new Promise(r => {
      const off = bus.on('song:opened', () => { off(); r(); });
      setTimeout(r, 5000);
    });
  }
  const line = lineById(lineId);
  if (!line?._el) return;
  line._el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  line._el.classList.add('flash-line');
  setTimeout(() => line._el?.classList.remove('flash-line'), 2200);
}

function exportCsv() {
  const rows = [['词', '平假名', '片假名', '罗马音', '原形', '释义', '出现次数', '例句']];
  for (const e of filtered()) {
    rows.push([e.t, toHiragana(e.k || ''), toKatakana(e.k || ''), e.r || '', e.base || '', e.meaning || '', String(e.count),
      e.examples?.[0]?.text || '']);
  }
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const name = vs.scope === 'song' && state.song ? `单词本-${state.song.title}.csv` : '单词本.csv';
  downloadText(name, csv, 'text/csv;charset=utf-8');
}

export function initVocab() {
  $('#vb-scope').addEventListener('change', (e) => { vs.scope = e.target.value; loadVocab(); });
  $('#vb-filter').addEventListener('input', debounce(renderVocab, 150));
  $('#vb-sort').addEventListener('change', renderVocab);
  $('#vb-refresh').addEventListener('click', loadVocab);
  $('#vb-translate').addEventListener('click', () => translateMissing());
  $('#vb-export').addEventListener('click', exportCsv);
  bus.on('song:opened', () => { if (document.body.dataset.app === 'vocab' && vs.scope === 'song') loadVocab(); });
}
