// 导出：纯文本（日语 / 假名 / 罗马音 / 分词 / 中文 任意组合）与 LRC
import { $, toast, downloadText } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { lineRomaji } from './analyzer.js';
import { toKatakana, toHiragana } from './kana.js';

function kanaLine(line) {
  const script = state.settings.kanaScript === 'katakana' ? toKatakana : toHiragana;
  return (line.words || []).map(w => (w.p ? w.t : (w.k ? script(w.k) : w.t))).join('');
}

function build() {
  const song = state.song;
  if (!song) return '';
  const opt = {
    jp: $('#ex-jp').checked, kana: $('#ex-kana').checked, seg: $('#ex-seg').checked,
    ro: $('#ex-ro').checked, zh: $('#ex-zh').checked,
  };
  const blocks = [`${song.title}${song.artist ? ' - ' + song.artist : ''}`, ''];
  for (const ln of song.lines) {
    const rows = [];
    if (opt.jp) rows.push(ln.text);
    if (opt.seg && ln.words) rows.push(ln.words.filter(w => !w.p).map(w => w.t).join(' | '));
    if (opt.kana && ln.words) rows.push(kanaLine(ln));
    if (opt.ro) rows.push(lineRomaji(ln));
    if (opt.zh && ln.zh) rows.push(ln.zh);
    if (rows.length) blocks.push(rows.join('\n'), '');
  }
  return blocks.join('\n').trim() + '\n';
}

export function openExport() {
  if (!state.song) { toast('请先打开一首歌'); return; }
  $('#ex-out').value = build();
  $('#dlg-export').showModal();
}

export function initExport() {
  ['#ex-jp', '#ex-kana', '#ex-seg', '#ex-ro', '#ex-zh'].forEach(id => $(id).addEventListener('change', () => { $('#ex-out').value = build(); }));
  $('#ex-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#ex-out').value); toast('已复制'); } catch { $('#ex-out').select(); document.execCommand('copy'); toast('已复制'); }
  });
  $('#ex-txt').addEventListener('click', () => downloadText(`${state.song.title || 'lyrics'}.txt`, $('#ex-out').value));
  $('#ex-lrc').addEventListener('click', () => { api.downloadLrc(state.song.id, false).catch(e => toast(e?.message || String(e))); });
  $('#ex-lrc-zh').addEventListener('click', () => { api.downloadLrc(state.song.id, true).catch(e => toast(e?.message || String(e))); });
  $('#ex-close').addEventListener('click', () => $('#dlg-export').close());
}
