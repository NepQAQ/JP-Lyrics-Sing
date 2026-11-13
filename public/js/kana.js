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

// ---------------------------------------------------------------- 罗马音 → 假名（不需要日语输入法）
// 规则与常见日语输入法一致：ka→か、shi/si→し、tsu/tu→つ、kka→っか、nn / n' / n+辅音→ん、xa/la→ぁ、- → ー
const R2K = {
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', ca: 'か', cu: 'く', co: 'こ', qa: 'くぁ', qi: 'くぃ', qe: 'くぇ', qo: 'くぉ',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
  sa: 'さ', si: 'し', shi: 'し', su: 'す', se: 'せ', so: 'そ',
  za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  ta: 'た', ti: 'ち', chi: 'ち', tu: 'つ', tsu: 'つ', te: 'て', to: 'と',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', ye: 'いぇ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ', la: 'ら', li: 'り', lu: 'る', le: 'れ', lo: 'ろ',
  wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を', wu: 'う',
  va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
  fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', fyu: 'ふゅ',
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  sha: 'しゃ', shu: 'しゅ', she: 'しぇ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', sye: 'しぇ', syo: 'しょ',
  ja: 'じゃ', ju: 'じゅ', je: 'じぇ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ', zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ',
  cha: 'ちゃ', chu: 'ちゅ', che: 'ちぇ', cho: 'ちょ', cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
  dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ', thi: 'てぃ', thu: 'てゅ', dhi: 'でぃ', dhu: 'でゅ', twu: 'とぅ', dwu: 'どぅ', tsa: 'つぁ',
  nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ', hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ', pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  mya: 'みゃ', myu: 'みゅ', myo: 'みょ', rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ', xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', xtu: 'っ', xtsu: 'っ', xwa: 'ゎ',
  ltu: 'っ', ltsu: 'っ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ',
  '-': 'ー',
};
const MACRON = { 'ā': 'aa', 'ī': 'ii', 'ū': 'uu', 'ē': 'ee', 'ō': 'ou', 'â': 'aa', 'î': 'ii', 'û': 'uu', 'ê': 'ee', 'ô': 'ou' };

/**
 * 罗马音 → 平假名（katakana=true 时为片假名）。非罗马字母（汉字、假名、标点）原样保留。
 * final=false 用于「边打边转」：末尾还没打完的辅音（如 k、sh、单个 n）保留为字母，等待后续输入。
 */
export function romajiToKana(input, { katakana = false, final = true, caseKatakana = false } = {}) {
  const s = String(input || '').replace(/[āīūēōâîûêô]/gi, ch => MACRON[ch.toLowerCase()] || ch);
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  // 只对新转换出的假名应用片假名（已有的平假名 / 汉字原样保留）；caseKatakana：大写字母打出片假名
  const emit = (kana, from) => {
    const upper = caseKatakana && /[A-Z]/.test(s[from] || '');
    out += (katakana || upper) ? toKatakana(kana) : kana;
  };
  while (i < s.length) {
    const ch = lower[i];
    if (!/[a-z'\-]/.test(ch)) { out += s[i]; i++; continue; }
    if (ch === '-') {
      // 只有紧跟在假名后的 - 才是长音
      out += /[ぁ-ヿ]$/.test(out) ? 'ー' : '-';
      i++;
      continue;
    }
    if (ch === "'") { i++; continue; }
    // ん：nn / n' / n + 辅音（非 y、非元音）
    if (ch === 'n') {
      const nx = lower[i + 1];
      // nn + 元音：第一个 n 成为「ん」，第二个 n 与元音组成な行（konnichiha → こんにちは）
      if (nx === 'n') { emit('ん', i); i += /[aiueoy]/.test(lower[i + 2] || '') ? 1 : 2; continue; }
      if (nx === "'") { emit('ん', i); i += 2; continue; }
      if (nx === undefined) { if (final) emit('ん', i); else out += s[i]; i++; continue; }
      if (!/[aiueoy]/.test(nx)) { emit('ん', i); i++; continue; }
    }
    // 促音：同一辅音连写（kk、tt、ss…），或 tch
    const nx = lower[i + 1];
    if (nx && ch === nx && /[bcdfghjklmpqrstvwxyz]/.test(ch)) { emit('っ', i); i++; continue; }
    if (ch === 't' && lower.startsWith('ch', i + 1)) { emit('っ', i); i++; continue; }
    let matched = false;
    for (let len = 4; len >= 1; len--) {
      const part = lower.slice(i, i + len);
      if (R2K[part]) { emit(R2K[part], i); i += len; matched = true; break; }
    }
    if (!matched) {
      // 还没打完的辅音：保留原字母，等待后续输入
      out += s[i];
      i++;
    }
  }
  return out;
}

export const hasLatin = (s) => /[A-Za-z]/.test(s || '');
export const isKatakanaWord = (s) => /[ァ-ヺ]/.test(s || '') && !/[ぁ-ゖ㐀-鿿]/.test(s || '');
export const isLatinWord = (s) => /^[\x20-\x7e]+$/.test(s || '') && /[A-Za-z]/.test(s || '');

/**
 * 某个词的罗马音 → 读音假名：去掉空格；词面以助词 は/へ/を 结尾时，把读作 wa/e/o 的假名还原成 は/へ/を。
 * 词面是片假名时输出片假名。
 */
export function wordRomajiToKana(surface, romaji) {
  const kata = isKatakanaWord(surface);
  let k = romajiToKana(String(romaji || '').replace(/\s+/g, ''), { katakana: false, final: true });
  const t = toHiragana(surface || '');
  const last = t.slice(-1);
  const map = { 'は': 'わ', 'へ': 'え', 'を': 'お' };
  if (t.length > 1 && map[last] && k.endsWith(map[last])) k = k.slice(0, -1) + last;
  // 长音：罗马音里写成元音重复（monsutaa），词面是「ー」时按词面还原（モンスター）
  if (/ー/.test(surface || '') && expandChoon(t) === k) return surface;
  return kata ? toKatakana(k) : k;
}

const VOWEL_KANA = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' };
/** 把长音符 ー 展开成前一个假名的元音（モンスター → もんすたあ），用于比较 */
export function expandChoon(hira) {
  let out = '';
  for (const ch of hira) {
    if (ch === 'ー') {
      const v = kanaToRomaji(out.slice(-1)).slice(-1);
      out += VOWEL_KANA[v] || ch;
    } else out += ch;
  }
  return out;
}
