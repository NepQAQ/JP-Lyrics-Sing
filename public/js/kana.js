// 假名 / 罗马音 / 注音对齐 —— 纯函数，无 DOM 依赖（可在 Node 中单测）

export const RE_KANJI = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/;
const RE_KANJI_CHAR = /^[㐀-䶿一-鿿豈-﫿々〆ヶ]$/;
export const RE_KANA_ONLY = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/;
export const RE_PUNCT = /^[\s　、。，．,.!！?？「」『』（）()\[\]【】〈〉《》…‥・･~〜～\-－—–♪☆★♡♥"“”'‘’:：;；/／]+$/;

export const hasKanji = (s) => RE_KANJI.test(s || '');
export const isKanjiChar = (c) => RE_KANJI_CHAR.test(c);

export function toHiragana(s) {
  return String(s || '').replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/ヽ/g, 'ゝ').replace(/ヾ/g, 'ゞ');
}

export function toKatakana(s) {
  return String(s || '').replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// ---------------------------------------------------------------- 罗马音（Hepburn，长音按拼写展开）
const DIGRAPHS = {
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo', 'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
  'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho', 'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
  'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho', 'ぢゃ': 'ja', 'ぢゅ': 'ju', 'ぢょ': 'jo',
  'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo', 'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
  'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo', 'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
  'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo', 'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
  // 外来语扩展
  'しぇ': 'she', 'じぇ': 'je', 'ちぇ': 'che', 'てぃ': 'ti', 'でぃ': 'di', 'とぅ': 'tu', 'どぅ': 'du',
  'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo', 'ふゅ': 'fyu', 'うぃ': 'wi', 'うぇ': 'we',
  'うぉ': 'wo', 'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo', 'つぁ': 'tsa', 'つぃ': 'tsi',
  'つぇ': 'tse', 'つぉ': 'tso', 'いぇ': 'ye', 'くぁ': 'kwa', 'ぐぁ': 'gwa', 'てゅ': 'tyu', 'でゅ': 'dyu',
};
const MONO = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o', 'ん': 'n', 'ゔ': 'vu',
  'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', 'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ゎ': 'wa',
  'ゕ': 'ka', 'ゖ': 'ke',
};

/**
 * 假名（平/片均可）→ 罗马音。长音 ー 展开为前一个元音；促音 っ 双写下一个辅音；ん 在元音/y 前写作 n'。
 * 非假名字符原样保留。
 */
export function kanaToRomaji(input) {
  const s = toHiragana(input);
  let out = '';
  let pendingSokuon = false;
  let lastWasN = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === 'っ') { pendingSokuon = true; lastWasN = false; continue; }
    if (ch === 'ー' || ch === '〜') {
      const m = out.match(/[aeiou]$/);
      if (m) out += m[0];
      lastWasN = false;
      continue;
    }
    if (ch === 'ゝ' || ch === 'ゞ') continue;
    const two = s.slice(i, i + 2);
    let syl = null;
    if (DIGRAPHS[two]) { syl = DIGRAPHS[two]; i++; }
    else if (MONO[ch] !== undefined) syl = MONO[ch];
    if (syl === null) {
      pendingSokuon = false;
      lastWasN = false;
      out += ch;
      continue;
    }
    if (pendingSokuon) {
      pendingSokuon = false;
      if (syl.startsWith('ch')) out += 't';
      else if (/^[bcdfghjkmpqrstvwxyz]/.test(syl)) out += syl[0];
    }
    if (lastWasN && /^[aeiouy]/.test(syl)) out += "'";
    out += syl;
    lastWasN = ch === 'ん';
  }
  return out;
}

/**
 * 用户手动修改读音后，按词面推断罗马音：词尾单独的助词 は/へ/を 读作 wa/e/o 并空格隔开。
 */
export function wordKanaToRomaji(surface, kana) {
  const k = toHiragana(kana || '');
  const t = toHiragana(surface || '');
  if (!k) return /^[\x20-\x7e]+$/.test(surface || '') ? String(surface).toLowerCase() : '';
  const particle = { 'は': 'wa', 'へ': 'e', 'を': 'o' };
  const last = t.slice(-1);
  if (t.length > 1 && particle[last] && k.endsWith(last) && k.length > 1) {
    return `${kanaToRomaji(k.slice(0, -1))} ${particle[last]}`;
  }
  return kanaToRomaji(k);
}

// ---------------------------------------------------------------- 注音对齐
/**
 * 把读音对齐到词面，只给汉字部分注音：
 *   alignRuby('触った', 'さわった') → [{b:'触', rt:'さわ'}, {b:'った', rt:''}]
 *   alignRuby('取り戻す', 'とりもどす') → [{b:'取',rt:'と'},{b:'り',rt:''},{b:'戻',rt:'もど'},{b:'す',rt:''}]
 * 对不上时整体注音。返回的 rt 保留输入读音原有的平/片假名写法。
 */
export function alignRuby(surface, reading) {
  const t = String(surface || '');
  const r = String(reading || '');
  if (!t) return [];
  if (!r || !hasKanji(t)) return [{ b: t, rt: '' }];
  const runs = [];
  for (const ch of t) {
    const kanji = isKanjiChar(ch);
    const last = runs[runs.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else runs.push({ kanji, text: ch });
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '^' + runs.map(run => (run.kanji ? '(.+?)' : esc(toHiragana(run.text)))).join('') + '$';
  let m = null;
  try { m = toHiragana(r).match(new RegExp(pattern)); } catch { m = null; }
  if (!m) return [{ b: t, rt: r }];
  // 用捕获组在原读音中的位置截取（保留原书写体系）
  const out = [];
  let gi = 1;
  let pos = 0;
  const hr = toHiragana(r);
  for (const run of runs) {
    if (run.kanji) {
      const cap = m[gi++];
      const idx = hr.indexOf(cap, pos);
      out.push({ b: run.text, rt: r.slice(idx, idx + cap.length) });
      pos = idx + cap.length;
    } else {
      out.push({ b: run.text, rt: '' });
      pos += run.text.length;
    }
  }
  return out;
}

/**
 * 按若干切分点拆分一个词，尽量从注音对齐结果推出各部分读音。
 * cuts: 词内字符偏移（升序，不含 0 与 length）。无法精确推出的部分返回 k=null（调用方再用分词器补）。
 */
export function splitReading(surface, reading, cuts) {
  const segs = alignRuby(surface, reading);
  // 每个字符对应的「读音块」
  const charInfo = [];
  for (const seg of segs) {
    if (!seg.rt) {
      for (const ch of seg.b) charInfo.push({ ch, rt: ch, atomic: false, start: true });
    } else {
      [...seg.b].forEach((ch, i) => charInfo.push({ ch, rt: i === 0 ? seg.rt : '', atomic: seg.b.length > 1, start: i === 0 }));
    }
  }
  const bounds = [0, ...cuts, [...surface].length];
  const parts = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    const slice = charInfo.slice(a, b);
    const t = slice.map(c => c.ch).join('');
    // 切点落在多字汉字注音块中间 → 无法精确拆分读音
    const brokenStart = slice[0] && !slice[0].start;
    const brokenEnd = charInfo[b] && !charInfo[b].start;
    const k = (brokenStart || brokenEnd || !reading) ? null : slice.map(c => c.rt).join('');
    parts.push({ t, k });
  }
  return parts;
}

/** 渲染词的注音 HTML（rt 按设置转平/片假名） */
export function rubyHTML(surface, reading, script = 'hiragana', esc = (s) => s) {
  const segs = alignRuby(surface, reading);
  return segs.map(seg => {
    if (!seg.rt) return esc(seg.b);
    const rt = script === 'katakana' ? toKatakana(seg.rt) : toHiragana(seg.rt);
    return `<ruby>${esc(seg.b)}<rt>${esc(rt)}</rt></ruby>`;
  }).join('');
}
