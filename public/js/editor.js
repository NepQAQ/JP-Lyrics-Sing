// 编辑功能：
//   1. 编辑模式下点选单词 → 浮动工具条（合并 / 拆分 / 高亮 / 边框 / 备注 / 连读 / 停顿）
//   2. 行编辑器（原文、时间、字间切分、逐词假名/罗马音/标记、整行罗马音、中文）
//   3. 全文编辑（LRC 文本）
//   4. 修改历史（可撤销）
//   5. 我的词典
import { $, $$, h, toast, bus, fmtTime, parseTime, setStatus } from './util.js';
import { state, sameTextLines, lineById } from './state.js';
import { api } from './api.js';
import { renderLineContent, rerenderPreservingScroll } from './render.js';
import { analyzeText, readingFor, wordsMatchText, setUserDict, getUserDict, isReady, ensureTokenizer } from './analyzer.js';
import { splitReading, wordKanaToRomaji, wordRomajiToKana, toHiragana, toKatakana, isLatinWord, isKatakanaWord } from './kana.js';
import { attachRomajiIME } from './ime.js';
import { lyricTime, playLine } from './player.js';
import { lineStart } from './timing.js';

const HL_COLORS = [
  { key: 'y', label: '黄' }, { key: 'g', label: '绿' }, { key: 'b', label: '蓝' },
  { key: 'p', label: '粉' }, { key: 'o', label: '橙' },
];

const clone = (x) => JSON.parse(JSON.stringify(x ?? null));

function joinRomaji(a, b) {
  return [a, b].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function mergeMarks(words) {
  const m = {};
  for (const w of words) Object.assign(m, w.m || {});
  delete m.link;
  if (words.at(-1)?.m?.link) m.link = true;
  return Object.keys(m).length ? m : undefined;
}

export function mergeWords(words, a, b) {
  const part = words.slice(a, b + 1);
  const merged = {
    t: part.map(w => w.t).join(''),
    k: part.map(w => w.k || (w.p ? '' : '')).join(''),
    r: part.filter(w => !w.p).map(w => w.r).reduce(joinRomaji, ''),
  };
  if (part.every(w => w.p)) merged.p = 1;
  const m = mergeMarks(part);
  if (m) merged.m = m;
  return [...words.slice(0, a), merged, ...words.slice(b + 1)];
}

/** 在词 wi 内部按字符偏移 cuts 拆分；读音尽量精确拆，拆不出的用分词器补 */
export async function splitWord(words, wi, cuts) {
  const w = words[wi];
  const parts = splitReading(w.t, w.k, cuts);
  const out = [];
  for (const p of parts) {
    let k = p.k;
    let r;
    if (k === null || k === undefined) {
      if (isReady()) {
        const res = await readingFor(p.t);
        k = res.k;
        r = res.r;
      } else {
        k = '';
      }
    }
    if (r === undefined) r = wordKanaToRomaji(p.t, k);
    const nw = { t: p.t, k, r };
    if (/^[\s　、。，,.!！?？「」『』（）()…・~〜♪]+$/.test(p.t)) { nw.p = 1; nw.k = ''; nw.r = ''; }
    if (w.m && !nw.p) nw.m = clone(w.m);
    out.push(nw);
  }
  return [...words.slice(0, wi), ...out, ...words.slice(wi + 1)];
}

// =============================================================== 保存
/**
 * 保存一行的修改（可同步到本曲相同原文的行），写入编辑历史。
 * fields: 要更新的字段 {words, wordsEdited, romaji, zh, text, time}
 */
export async function saveLine(line, fields, { kind = 'edit', note = '', applySame } = {}) {
  const same = applySame ?? state.settings.applySameLines !== false;
  const targets = [line, ...(same && fields.text === undefined ? sameTextLines(line) : [])];
  const patches = targets.map((ln, i) => {
    const p = { id: ln.id };
    for (const [k, v] of Object.entries(fields)) {
      if (i > 0 && (k === 'time' || k === 'wordTiming')) continue; // 时间只改当前行
      p[k] = clone(v);
    }
    return p;
  });
  const res = await api.patchLines(state.song.id, patches, { record: true, kind, note });
  if (res.resorted) {
    // 时间改动导致重新排序：用服务端返回的整首歌词刷新
    const keep = new Map(state.song.lines.map(l => [l.id, l._el]));
    state.song.lines = res.lines;
    state.song.lines.forEach(l => { l._el = keep.get(l.id); });
    rerenderPreservingScroll();
  } else {
    for (const ln of targets) {
      const f = clone(fields);
      if (ln !== line) { delete f.time; delete f.wordTiming; }
      Object.assign(ln, f);
      renderLineContent(ln);
    }
  }
  bus.emit('song:changed');
  if (targets.length > 1) toast(`已保存，并同步到 ${targets.length - 1} 处相同歌词`);
  return targets;
}

// =============================================================== 单词选中 & 工具条
const sel = { lineId: null, a: -1, b: -1 };

function clearSelection() {
  sel.lineId = null;
  sel.a = sel.b = -1;
  $$('.w.selected, .rw.selected').forEach(el => el.classList.remove('selected'));
  $('#word-toolbar').hidden = true;
}

function paintSelection() {
  $$('.w.selected, .rw.selected').forEach(el => el.classList.remove('selected'));
  const line = lineById(sel.lineId);
  if (!line?._el) return;
  for (let i = sel.a; i <= sel.b; i++) {
    line._el.querySelectorAll(`[data-wi="${i}"]`).forEach(el => el.classList.add('selected'));
  }
  positionToolbar(line);
}

function positionToolbar(line) {
  // 工具条固定停靠在播放条上方（不遮挡被选中的词和相邻行）
  const tb = $('#word-toolbar');
  if (!line._el.querySelector(`.jp [data-wi="${sel.a}"]`)) { tb.hidden = true; return; }
  tb.hidden = false;
  const count = sel.b - sel.a + 1;
  $('#wt-merge').disabled = count < 2;
  $('#wt-info').textContent = count > 1 ? `已选 ${count} 个词（Shift+点击扩展）` : `「${line.words[sel.a]?.t || ''}」`;
  const m = line.words[sel.a]?.m || {};
  $$('#word-toolbar [data-hl]').forEach(b => b.classList.toggle('active', m.hl === b.dataset.hl));
  $('#wt-box').classList.toggle('active', !!m.box);
  $('#wt-link').classList.toggle('active', !!m.link);
  $('#wt-brk').classList.toggle('active', !!m.brk);
  $('#wt-note-row').hidden = true;
}

function onWordClick(ev, wordEl) {
  const lineEl = wordEl.closest('.line');
  const line = lineById(lineEl?.dataset.id);
  if (!line || !Array.isArray(line.words)) return;
  const wi = Number(wordEl.dataset.wi);
  if (ev.shiftKey && sel.lineId === line.id) {
    sel.a = Math.min(sel.a, wi);
    sel.b = Math.max(sel.b, wi);
  } else if (sel.lineId === line.id && sel.a === wi && sel.b === wi) {
    clearSelection();
    return;
  } else {
    sel.lineId = line.id;
    sel.a = sel.b = wi;
  }
  paintSelection();
}

async function applyToSelection(mutator, kind, note) {
  const line = lineById(sel.lineId);
  if (!line) return;
  const words = clone(line.words);
  const res = mutator(words);
  const next = res instanceof Promise ? await res : res;
  try {
    await saveLine(line, { words: next, wordsEdited: true }, { kind, note });
  } catch (e) {
    toast('保存失败：' + e.message, { error: true });
    return;
  }
}

function setMark(words, key, value) {
  for (let i = sel.a; i <= sel.b; i++) {
    const w = words[i];
    if (!w || w.p) continue;
    const m = { ...(w.m || {}) };
    if (value === undefined || value === null || value === false || value === '') delete m[key];
    else m[key] = value;
    if (Object.keys(m).length) w.m = m; else delete w.m;
  }
  return words;
}

function initToolbar() {
  const tb = $('#word-toolbar');
  tb.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });

  $('#wt-merge').addEventListener('click', async () => {
    const { a, b } = sel;
    await applyToSelection(words => mergeWords(words, a, b), 'merge', '合并单词');
    sel.b = sel.a;
    paintSelection();
  });
  $('#wt-split').addEventListener('click', () => {
    const line = lineById(sel.lineId);
    const wi = sel.a;
    clearSelection();
    if (line) openLineEditor(line, { focusWord: wi });
  });
  $$('#word-toolbar [data-hl]').forEach(btn => btn.addEventListener('click', async () => {
    const line = lineById(sel.lineId);
    const cur = line?.words?.[sel.a]?.m?.hl;
    const val = cur === btn.dataset.hl ? null : btn.dataset.hl;
    await applyToSelection(words => setMark(words, 'hl', val), 'mark', val ? '高亮' : '取消高亮');
    paintSelection();
  }));
  const toggle = (key, label) => async () => {
    const line = lineById(sel.lineId);
    const cur = !!line?.words?.[sel.a]?.m?.[key];
    await applyToSelection(words => setMark(words, key, !cur), 'mark', (cur ? '取消' : '') + label);
    paintSelection();
  };
  $('#wt-box').addEventListener('click', toggle('box', '边框'));
  $('#wt-link').addEventListener('click', toggle('link', '连读'));
  $('#wt-brk').addEventListener('click', toggle('brk', '停顿'));
  $('#wt-clear').addEventListener('click', async () => {
    await applyToSelection(words => {
      for (let i = sel.a; i <= sel.b; i++) if (words[i]) delete words[i].m;
      return words;
    }, 'mark', '清除标记');
    paintSelection();
  });
  $('#wt-note').addEventListener('click', () => {
    const line = lineById(sel.lineId);
    $('#wt-note-row').hidden = false;
    const input = $('#wt-note-input');
    input.value = line?.words?.[sel.a]?.m?.note || '';
    input.focus();
  });
  const saveNote = async () => {
    const val = $('#wt-note-input').value.trim();
    await applyToSelection(words => setMark(words, 'note', val), 'mark', val ? `备注「${val}」` : '删除备注');
    paintSelection();
  };
  $('#wt-note-save').addEventListener('click', saveNote);
  $('#wt-note-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveNote(); } });
  $$('#word-toolbar [data-tone]').forEach(btn => btn.addEventListener('click', async () => {
    const line = lineById(sel.lineId);
    const t = Number(btn.dataset.tone);
    const cur = line?.words?.[sel.a]?.m?.tone;
    await applyToSelection(words => setMark(words, 'tone', cur === t ? null : t), 'mark', '声调');
    paintSelection();
  }));
  $('#wt-edit').addEventListener('click', () => {
    const line = lineById(sel.lineId);
    const wi = sel.a;
    clearSelection();
    if (line) openLineEditor(line, { focusWord: wi });
  });
  $('#wt-close').addEventListener('click', clearSelection);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !tb.hidden) clearSelection(); });
}

export function setEditing(on) {
  state.editing = on;
  document.body.classList.toggle('editing', on);
  $('#btn-edit-mode').classList.toggle('active', on);
  $('#btn-edit-mode').setAttribute('aria-pressed', String(on));
  if (!on) clearSelection();
  else toast('编辑模式：点击单词选中，Shift+点击多选；点「✎」编辑整行', { ms: 2600 });
}

// =============================================================== 行编辑器
const ed = { line: null, draft: null, origWords: null, textDirty: false, busy: false };

export function openLineEditor(line, { focusWord = -1 } = {}) {
  ed.line = line;
  ed.textDirty = false;
  ed.draft = {
    text: line.text,
    time: line.time,
    zh: line.zh || '',
    words: clone(line.words) || [],
    romaji: line.romaji || '',
    romajiManual: !!line.romaji,
  };
  ed.origWords = clone(line.words) || [];
  const idx = state.song.lines.indexOf(line);
  $('#le-title').textContent = `编辑第 ${idx + 1} 行`;
  // 有逐字时间轴时显示第一个字的实际开始时间；修改时整体平移逐字时间
  $('#le-time').value = fmtTime(lineStart(line), 2);
  $('#le-text').value = line.text;
  $('#le-zh').value = line.zh || '';
  const same = sameTextLines(line).length;
  $('#le-same').checked = state.settings.applySameLines !== false && same > 0;
  $('#le-same').disabled = same === 0;
  $('#le-same-count').textContent = same ? `（另有 ${same} 处）` : '（无）';
  $('#le-dict').checked = false;
  renderEditor();
  const dlg = $('#dlg-line');
  if (!dlg.open) dlg.showModal();
  if (focusWord >= 0) {
    setTimeout(() => {
      const row = $(`#le-words [data-wi="${focusWord}"]`);
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('flash');
      $(`#le-chars .chip-word[data-wi="${focusWord}"]`)?.classList.add('flash');
    }, 50);
  }
}

function renderEditor() {
  renderChars();
  renderWordRows();
  renderRomajiBox();
  $('#le-stale').hidden = !ed.textDirty;
  $('#le-seg').classList.toggle('stale', ed.textDirty);
}

/** 字符 + 字间切分线：点击切分线在「切开 / 合并」之间切换 */
function renderChars() {
  const box = $('#le-chars');
  box.replaceChildren();
  const words = ed.draft.words;
  let pos = 0;
  words.forEach((w, wi) => {
    const chip = h('span', { class: `chip-word${w.p ? ' punct' : ''}`, dataset: { wi: String(wi) } });
    const chars = [...w.t];
    chars.forEach((ch, ci) => {
      chip.append(h('span', { class: 'ch', text: ch === ' ' ? '␣' : ch }));
      if (ci < chars.length - 1) {
        chip.append(h('button', {
          type: 'button', class: 'gap', title: '在这里切开',
          dataset: { wi: String(wi), ci: String(ci + 1) },
        }));
      }
    });
    box.append(chip);
    pos += chars.length;
    if (wi < words.length - 1) {
      box.append(h('button', { type: 'button', class: 'gap on', title: '合并左右两个词', dataset: { join: String(wi) } }));
    }
  });
}

function wordRow(w, wi) {
  const row = h('div', { class: `wrow${w.p ? ' punct' : ''}`, dataset: { wi: String(wi) } });
  if (w.p) {
    row.append(h('span', { class: 'wt', text: w.t === ' ' ? '␣ 空格' : w.t }), h('span', { class: 'muted small', text: '标点 / 空白' }));
    return row;
  }
  const m = w.m || {};
  const latin = isLatinWord(w.t);
  const kana = h('input', {
    class: 'wk', value: w.k || '', lang: 'ja', 'aria-label': `${w.t} 的读音`,
    placeholder: latin ? '（英文无需读音）' : '可直接打罗马音', disabled: latin || undefined,
  });
  const roma = h('input', { class: 'wr', value: w.r || '', placeholder: '罗马音', 'aria-label': `${w.t} 的罗马音` });
  // 读音框：不用日语输入法，直接打罗马音自动转假名（大写或片假名词 → 片假名）
  if (!latin) attachRomajiIME(kana, { katakana: () => isKatakanaWord(w.t) || isKatakanaWord(w.k) });
  kana.addEventListener('input', () => {
    w.k = kana.value.trim();
    // 假名 → 罗马音（还有没打完的字母时先不动罗马音）
    if (!/[A-Za-z]/.test(w.k)) { w.r = wordKanaToRomaji(w.t, w.k); roma.value = w.r; }
    renderRomajiBox();
  });
  // 罗马音 → 假名
  roma.addEventListener('input', () => {
    w.r = roma.value.trim();
    if (!latin) {
      const k = wordRomajiToKana(w.t, w.r);
      if (!/[A-Za-z]/.test(k)) { w.k = k; kana.value = k; }
    }
    renderRomajiBox();
  });
  const hl = h('select', { class: 'whl', 'aria-label': '高亮颜色' },
    h('option', { value: '' , text: '无高亮' }),
    ...HL_COLORS.map(c => h('option', { value: c.key, text: `${c.label}色`, selected: m.hl === c.key })));
  hl.addEventListener('change', () => { setWordMark(w, 'hl', hl.value || null); });
  const box = h('label', { class: 'chk small' }, h('input', { type: 'checkbox', checked: !!m.box }), '框');
  box.querySelector('input').addEventListener('change', e => setWordMark(w, 'box', e.target.checked));
  const tone = h('select', { class: 'wtone', 'aria-label': '声调' },
    h('option', { value: '', text: '声调' }),
    ...[1, 2, 3, 4].map(n => h('option', { value: String(n), text: `${n} 声`, selected: m.tone === n })));
  tone.addEventListener('change', () => setWordMark(w, 'tone', tone.value ? Number(tone.value) : null));
  const note = h('input', { class: 'wnote', value: m.note || '', placeholder: '备注', maxlength: '24' });
  note.addEventListener('input', () => setWordMark(w, 'note', note.value.trim()));
  row.append(h('span', { class: 'wt', lang: 'ja', text: w.t }), kana, roma, hl, box, tone, note);
  return row;
}

function setWordMark(w, key, val) {
  const m = { ...(w.m || {}) };
  if (val === null || val === false || val === '' || val === undefined) delete m[key];
  else m[key] = val;
  if (Object.keys(m).length) w.m = m; else delete w.m;
}

function renderWordRows() {
  const box = $('#le-words');
  box.replaceChildren(...ed.draft.words.map(wordRow));
}

function autoRomaji() {
  return ed.draft.words.filter(w => !w.p && w.r).map(w => w.r).join(' ');
}

function renderRomajiBox() {
  const ta = $('#le-romaji');
  $('#le-romaji-manual').checked = ed.draft.romajiManual;
  if (document.activeElement === ta) return;
  if (!ed.draft.romajiManual) ta.value = autoRomaji();
  else if (!ta.value) ta.value = ed.draft.romaji || autoRomaji();
}

/** 只刷新各词输入框的值（不重建行，避免打断正在输入的焦点） */
function refreshWordInputs() {
  ed.draft.words.forEach((w, wi) => {
    const row = $(`#le-words .wrow[data-wi="${wi}"]`);
    if (!row) return;
    const k = row.querySelector('.wk');
    const r = row.querySelector('.wr');
    if (k && document.activeElement !== k) k.value = w.k || '';
    if (r && document.activeElement !== r) r.value = w.r || '';
  });
}

/**
 * 整行罗马音 → 各词：空格分隔的音节组数与各词罗马音的组数一致时，逐词回填（并同步假名）；
 * 对不上（增删了词）时视为整行手动覆盖。
 */
function onLineRomajiInput() {
  const tokens = $('#le-romaji').value.trim().split(/\s+/).filter(Boolean);
  const targets = ed.draft.words.filter(w => !w.p && w.r);
  const counts = targets.map(w => w.r.split(/\s+/).filter(Boolean).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total > 0 && tokens.length === total) {
    let p = 0;
    targets.forEach((w, i) => {
      const r = tokens.slice(p, p + counts[i]).join(' ');
      p += counts[i];
      if (r === w.r) return;
      w.r = r;
      if (!isLatinWord(w.t)) {
        const k = wordRomajiToKana(w.t, r);
        if (!/[A-Za-z]/.test(k)) w.k = k;
      }
    });
    ed.draft.romajiManual = false;
    refreshWordInputs();
  } else {
    ed.draft.romajiManual = true;
  }
  $('#le-romaji-manual').checked = ed.draft.romajiManual;
}

async function onCharsClick(e) {
  const gap = e.target.closest('.gap');
  if (!gap || ed.busy || ed.textDirty) return;
  if (gap.dataset.join !== undefined) {
    const i = Number(gap.dataset.join);
    ed.draft.words = mergeWords(ed.draft.words, i, i + 1);
  } else {
    const wi = Number(gap.dataset.wi);
    const ci = Number(gap.dataset.ci);
    ed.busy = true;
    try {
      ed.draft.words = await splitWord(ed.draft.words, wi, [ci]);
    } finally {
      ed.busy = false;
    }
  }
  renderEditor();
}

async function reanalyzeDraft() {
  const text = $('#le-text').value;
  setStatus('正在分析…');
  try {
    await ensureTokenizer();
    ed.draft.words = await analyzeText(text, { ruby: ed.line.text === text ? ed.line.ruby : null });
    ed.draft.text = text;
    ed.textDirty = false;
    renderEditor();
    setStatus('');
  } catch (e) {
    toast('分析失败：' + e.message, { error: true });
  }
}

async function saveEditor() {
  const line = ed.line;
  if (!line) return;
  const text = $('#le-text').value.trim();
  if (!text) { toast('原文不能为空', { error: true }); return; }
  if (text !== line.text && (ed.textDirty || !wordsMatchText(ed.draft.words, text))) {
    await reanalyzeDraft();
  }
  const fields = {};
  const t = parseTime($('#le-time').value);
  const curStart = lineStart(line);
  if (Number.isFinite(t) && Math.abs(t - curStart) > 0.0005) {
    const delta = t - curStart;
    fields.time = Math.max(0, Math.round((line.time + delta) * 1000) / 1000);
    if (line.wordTiming?.length) {
      const ms = Math.round(delta * 1000);
      fields.wordTiming = line.wordTiming.map(w => ({ ...w, starttime: w.starttime + ms, endtime: w.endtime + ms }));
    }
  }
  if (text !== line.text) fields.text = text;
  const zh = $('#le-zh').value.trim();
  if (zh !== (line.zh || '')) fields.zh = zh;
  const words = ed.draft.words;
  if (JSON.stringify(words) !== JSON.stringify(line.words || null)) {
    fields.words = words;
    fields.wordsEdited = true;
  }
  let romaji = ed.draft.romajiManual ? $('#le-romaji').value.trim() : null;
  if (romaji && romaji.replace(/\s+/g, ' ') === autoRomaji()) romaji = null;
  if ((romaji || null) !== (line.romaji || null)) fields.romaji = romaji || null;
  if (!Object.keys(fields).length) { $('#dlg-line').close(); return; }

  // 加入词典：词面或读音与自动结果不同的词
  if ($('#le-dict').checked) {
    const orig = new Map((ed.origWords || []).map(w => [w.t, w.k]));
    const entries = {};
    for (const w of words) {
      if (w.p || [...w.t.trim()].length < 2) continue; // 单字进词典会干扰所有歌曲的分词
      if (!orig.has(w.t) || orig.get(w.t) !== w.k) entries[w.t] = { k: w.k, r: w.r, fixed: true };
    }
    if (Object.keys(entries).length) {
      try {
        setUserDict(await api.saveDictionary(entries));
        toast(`已加入词典：${Object.keys(entries).join('、')}`);
      } catch (e) {
        toast('词典保存失败：' + e.message, { error: true });
      }
    }
  }
  try {
    await saveLine(line, fields, { kind: 'edit', applySame: $('#le-same').checked && !fields.text });
    $('#dlg-line').close();
  } catch (e) {
    toast('保存失败：' + e.message, { error: true });
  }
}

function initLineEditor() {
  const dlg = $('#dlg-line');
  // 原文框：可选「罗马音输入」，不用日语输入法也能改假名（含英文的歌词行请关闭）
  attachRomajiIME($('#le-text'), { enabled: () => $('#le-text-ime').checked });
  $('#le-chars').addEventListener('click', onCharsClick);
  $('#le-text').addEventListener('input', () => {
    ed.textDirty = $('#le-text').value !== ed.draft.text;
    $('#le-stale').hidden = !ed.textDirty;
    $('#le-seg').classList.toggle('stale', ed.textDirty);
  });
  $('#le-reanalyze').addEventListener('click', reanalyzeDraft);
  $('#le-now').addEventListener('click', () => { $('#le-time').value = fmtTime(lyricTime(), 2); });
  $('#le-preview').addEventListener('click', () => ed.line && playLine(ed.line));
  $('#le-hira').addEventListener('click', () => { ed.draft.words.forEach(w => { if (w.k) w.k = toHiragana(w.k); }); renderWordRows(); });
  $('#le-kata').addEventListener('click', () => { ed.draft.words.forEach(w => { if (w.k) w.k = toKatakana(w.k); }); renderWordRows(); });
  $('#le-recalc').addEventListener('click', () => {
    ed.draft.words.forEach(w => { if (!w.p && w.k) w.r = wordKanaToRomaji(w.t, w.k); });
    renderWordRows();
    renderRomajiBox();
  });
  $('#le-romaji-manual').addEventListener('change', e => {
    ed.draft.romajiManual = e.target.checked;
    $('#le-romaji').value = e.target.checked ? (ed.draft.romaji || autoRomaji()) : autoRomaji();
    if (e.target.checked) $('#le-romaji').focus();
  });
  $('#le-romaji').addEventListener('input', onLineRomajiInput);
  try { $('#le-text-ime').checked = localStorage.getItem('jls-text-ime') === '1'; } catch {}
  $('#le-text-ime').addEventListener('change', e => {
    try { localStorage.setItem('jls-text-ime', e.target.checked ? '1' : '0'); } catch {}
    $('#le-text').focus();
  });
  $('#le-save').addEventListener('click', saveEditor);
  $('#le-cancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(); }
  });
}

// =============================================================== 全文编辑
export function openFulltext() {
  if (!state.song) { toast('请先打开或新建一首歌'); return; }
  const lines = state.song.lines || [];
  $('#ft-text').value = lines.map(l => `[${fmtTime(l.time, 2)}]${l.text}`).join('\n');
  $('#ft-keep').checked = true;
  $('#dlg-fulltext').showModal();
}

function initFulltext() {
  $('#ft-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('#ft-text').value = await readTextFile(f);
  });
  $('#ft-save').addEventListener('click', async () => {
    const lrc = $('#ft-text').value;
    try {
      await api.replaceLyrics(state.song.id, { lrc, keepEdits: $('#ft-keep').checked, note: '全文编辑' });
      $('#dlg-fulltext').close();
      bus.emit('song:reload', { keepPosition: true });
      toast('歌词已更新');
    } catch (e) {
      toast('保存失败：' + e.message, { error: true });
    }
  });
  $('#ft-cancel').addEventListener('click', () => $('#dlg-fulltext').close());
}

export async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  for (const enc of ['utf-8', 'gb18030', 'shift_jis']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch {}
  }
  return new TextDecoder('utf-8').decode(buf);
}

// =============================================================== 修改历史
const KIND_LABEL = { edit: '编辑', merge: '合并', split: '拆分', mark: '标记', lyrics: '全文', revert: '撤销', timing: '打轴' };

function timeAgo(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return new Date(ts * 1000).toLocaleString();
}

function wordsPreview(line) {
  if (!line?.words) return '';
  return line.words.filter(w => !w.p).map(w => w.t).join(' | ');
}

export async function openHistory() {
  if (!state.song) return;
  const list = $('#hist-list');
  list.replaceChildren(h('div', { class: 'muted', text: '加载中…' }));
  $('#dlg-history').showModal();
  let items = [];
  try { items = await api.history(state.song.id); } catch (e) { list.replaceChildren(h('div', { class: 'error', text: e.message })); return; }
  if (!items.length) { list.replaceChildren(h('div', { class: 'muted', text: '还没有修改记录。编辑分词、读音、罗马音或标记后会出现在这里。' })); return; }
  // 同一次操作（同步到多行）合并显示
  const groupCount = new Map();
  items.forEach(it => { if (it.group) groupCount.set(it.group, (groupCount.get(it.group) || 0) + 1); });
  const seen = new Set();
  items = items.filter(it => {
    if (!it.group) return true;
    if (seen.has(it.group)) return false;
    seen.add(it.group);
    return true;
  });
  list.replaceChildren(...items.map(it => {
    const n = it.group ? groupCount.get(it.group) : 1;
    const text = it.after?.text || it.before?.text || '';
    const detail = [];
    if (it.before?.words && it.after?.words && wordsPreview(it.before) !== wordsPreview(it.after)) {
      detail.push(h('div', { class: 'hist-diff', lang: 'ja' },
        h('span', { class: 'del', text: wordsPreview(it.before) }), ' → ', h('span', { class: 'ins', text: wordsPreview(it.after) })));
    }
    const btn = h('button', { type: 'button', class: 'btn small', text: '恢复到修改前' });
    btn.addEventListener('click', async () => {
      if (!confirm('恢复到这次修改之前的状态？（恢复本身也会记录在历史中）')) return;
      try {
        await api.revert(state.song.id, it.id);
        bus.emit('song:reload', { keepPosition: true });
        toast('已恢复');
        openHistory();
      } catch (e) { toast('恢复失败：' + e.message, { error: true }); }
    });
    const canRevert = it.kind === 'lyrics' ? !!it.snapshot : !!it.before;
    return h('div', { class: 'hist-item' },
      h('div', { class: 'hist-head' },
        h('span', { class: `tag kind-${it.kind}`, text: KIND_LABEL[it.kind] || it.kind }),
        h('span', { class: 'hist-sum', text: (it.summary || '') + (n > 1 ? `（共 ${n} 行）` : '') }),
        h('span', { class: 'muted small', text: timeAgo(it.ts) })),
      text ? h('div', { class: 'hist-text', lang: 'ja', text }) : null,
      ...detail,
      canRevert ? h('div', { class: 'hist-actions' }, btn) : null);
  }));
}

// =============================================================== 我的词典
export async function openDictionary() {
  const dlg = $('#dlg-dict');
  try { setUserDict(await api.dictionary()); } catch {}
  renderDict();
  dlg.showModal();
}

function renderDict() {
  const dict = getUserDict();
  const body = $('#dict-list');
  const keys = Object.keys(dict).sort((a, b) => (dict[b].updatedAt || 0) - (dict[a].updatedAt || 0));
  if (!keys.length) {
    body.replaceChildren(h('div', { class: 'muted', text: '词典为空。在行编辑器勾选「加入我的词典」，或在上方手动添加。词典中的词在自动分词时会被当作一个整体，并使用这里的读音。' }));
    return;
  }
  body.replaceChildren(...keys.map(k => {
    const v = dict[k];
    const del = h('button', { type: 'button', class: 'btn small ghost', text: '删除' });
    del.addEventListener('click', async () => {
      setUserDict(await api.saveDictionary({}, [k]));
      renderDict();
    });
    return h('div', { class: 'dict-row' },
      h('span', { class: 'dt', lang: 'ja', text: k }),
      h('span', { class: 'dk', lang: 'ja', text: v.k || '' }),
      h('span', { class: 'dr', text: v.r || '' }),
      del);
  }));
}

function initDictionary() {
  $('#dict-add').addEventListener('click', async () => {
    const t = $('#dict-t').value.trim();
    const k = $('#dict-k').value.trim();
    if (!t) return;
    const r = $('#dict-r').value.trim() || wordKanaToRomaji(t, k);
    setUserDict(await api.saveDictionary({ [t]: { k, r, fixed: true } }));
    $('#dict-t').value = $('#dict-k').value = $('#dict-r').value = '';
    renderDict();
  });
  $('#dict-reanalyze').addEventListener('click', () => {
    $('#dlg-dict').close();
    bus.emit('song:reanalyze', { onlyUnedited: true });
  });
  $('#dict-close').addEventListener('click', () => $('#dlg-dict').close());
}

// =============================================================== 初始化
export function initEditor() {
  initToolbar();
  initLineEditor();
  initFulltext();
  initDictionary();
  $('#hist-close').addEventListener('click', () => $('#dlg-history').close());
  bus.on('song:opened', clearSelection);
  bus.on('word:click', ({ ev, el }) => onWordClick(ev, el));
}

export { clearSelection };
