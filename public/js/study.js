// 日语学习模式：输入任意日语句子 → 分词 / 注音 / 罗马音（与歌词相同的单词样式）+ 朗读
import { $, h, toast } from './util.js';
import { state } from './state.js';
import { jpHTML, romajiHTML, ICONS } from './render.js';
import { analyzeText, ensureTokenizer } from './analyzer.js';
import { speak, stopSpeech, splitSentences, VOICES } from './tts.js';

const KEY = 'jls-study-input';

function setStudyStatus(msg, err = false) {
  const el = $('#study-status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!err);
}

async function convert() {
  const text = $('#study-input').value;
  try { localStorage.setItem(KEY, text); } catch {}
  const sentences = splitSentences(text);
  const out = $('#study-results');
  if (!sentences.length) { out.replaceChildren(); return; }
  setStudyStatus('正在加载词典…');
  try { await ensureTokenizer(); } catch (e) { setStudyStatus('分词器加载失败：' + e.message, true); return; }
  setStudyStatus('');
  const inline = state.settings.layout === 'inline';
  const nodes = [];
  for (const s of sentences) {
    const line = { text: s, words: await analyzeText(s) };
    const el = h('div', { class: 'line study-line' });
    el.innerHTML = `<div class="line-body"><div class="jp" lang="ja">${jpHTML(line, { inline })}</div>
      <div class="ro">${inline ? '' : romajiHTML(line)}</div></div>
      <div class="line-tools"><button type="button" class="tool" title="朗读">${ICONS.speak}</button></div>`;
    el.querySelector('.tool').addEventListener('click', () => speak(s, { onStatus: setStudyStatus }));
    nodes.push(el);
  }
  out.replaceChildren(...nodes);
}

export function initStudy() {
  try { $('#study-input').value = localStorage.getItem(KEY) || ''; } catch {}
  const sel = $('#study-voice');
  sel.replaceChildren(...Object.entries(VOICES).map(([k, v]) => h('option', { value: k, text: v.label })));
  $('#study-convert').addEventListener('click', convert);
  $('#study-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) convert(); });
  $('#study-clear').addEventListener('click', () => { $('#study-input').value = ''; $('#study-results').replaceChildren(); stopSpeech(); });
  $('#study-speak').addEventListener('click', () => {
    const t = $('#study-input').value.trim();
    if (!t) { toast('请先输入日语'); return; }
    speak(t, { onStatus: setStudyStatus });
  });
}

export function syncStudyVoice() {
  const sel = $('#study-voice');
  if (sel) sel.value = state.settings.voice || 'cn-default';
}

export { convert as convertStudy };
