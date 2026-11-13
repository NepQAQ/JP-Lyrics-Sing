// 日语分析：kuromoji 分词 → 文节式「单词」分组 → 读音 / 罗马音。
//
// 单词结构（存进 song.json 的 line.words[]）：
//   { t: 词面, k: 读音(假名), r: 罗马音, p?: 1 表示标点/空白, m?: 标记 }
//   m = { hl: 'y'|'g'|'b'|'p'|'o', box: true, note: '备注', tone: 1..4, link: true(与下一个词连读), brk: true(词后停顿) }
// 约束：words.map(w => w.t).join('') === line.text （编辑器依赖它做字符级切分）
import { toHiragana, kanaToRomaji, wordKanaToRomaji, RE_KANA_ONLY, RE_PUNCT, hasKanji } from './kana.js';

const DICT_PATH = '/dict/';

// 原项目内置的常见误读修正（kuromoji-IPADIC 在歌词里常读错）
const DEFAULT_READINGS = {
  '二人': 'ふたり', '一人': 'ひとり', '大人': 'おとな', '今日': 'きょう', '明日': 'あした',
  '昨日': 'きのう', '今朝': 'けさ', '今宵': 'こよい', '今夜': 'こんや', '一日': 'いちにち',
  '一晩': 'ひとばん', '一度': 'いちど', '一瞬': 'いっしゅん', '一生': 'いっしょう', '一緒': 'いっしょ',
  '上手': 'じょうず', '下手': 'へた', '何処': 'どこ', '何時': 'いつ', '何故': 'なぜ', '此処': 'ここ',
  '其処': 'そこ', '彼方': 'かなた', '何時か': 'いつか', '貴方': 'あなた', '貴女': 'あなた',
  '私達': 'わたしたち', '僕達': 'ぼくたち', '君達': 'きみたち', '彼等': 'かれら', '世界中': 'せかいじゅう',
  '夜空': 'よぞら', '夕焼け': 'ゆうやけ', '朝焼け': 'あさやけ', '雪月花': 'せつげっか', '暁': 'あかつき',
};

let tokenizer = null;
let loading = null;
let userDict = {};

export const isReady = () => !!tokenizer;
export function setUserDict(dict) { userDict = dict || {}; }
export function getUserDict() { return userDict; }

export function ensureTokenizer() {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!window.kuromoji) { reject(new Error('kuromoji 未加载')); return; }
    const timer = setTimeout(() => reject(new Error('词典加载超时（17MB，首次较慢）')), 90000);
    window.kuromoji.builder({ dicPath: DICT_PATH }).build((err, tk) => {
      clearTimeout(timer);
      if (err) { reject(err); return; }
      tokenizer = tk;
      resolve(tk);
    });
  }).catch(e => { loading = null; throw e; });
  return loading;
}

// ---------------------------------------------------------------- 词典预切分
function dictEntries() {
  const map = new Map();
  for (const [surface, kana] of Object.entries(DEFAULT_READINGS)) map.set(surface, { k: kana, r: '', fixed: false });
  for (const [surface, v] of Object.entries(userDict)) {
    if (surface && v) map.set(surface, { k: v.k || '', r: v.r || '', fixed: v.fixed !== false });
  }
  return map;
}

function splitByDict(text) {
  const map = dictEntries();
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const out = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const hit = keys.find(k => text.startsWith(k, i));
    if (hit) {
      if (buf) { out.push({ text: buf }); buf = ''; }
      out.push({ text: hit, entry: map.get(hit) });
      i += hit.length;
    } else {
      buf += text[i++];
    }
  }
  if (buf) out.push({ text: buf });
  return out;
}

// ---------------------------------------------------------------- token 处理
function tokenKana(tok) {
  if (tok.reading && tok.reading !== '*') return toHiragana(tok.reading);
  if (RE_KANA_ONLY.test(tok.surface_form)) return toHiragana(tok.surface_form);
  return '';
}

function isPunctTok(tok) {
  return RE_PUNCT.test(tok.surface_form) || (tok.pos === '記号' && !/[A-Za-z0-9]/.test(tok.surface_form));
}
const isLatinTok = (tok) => /^[A-Za-z0-9'’&.\-]+$/.test(tok.surface_form);

/** 当前 token 是否并入前一个单词（文节式分组） */
function attaches(prev, tok) {
  if (!prev) return false;
  if (isPunctTok(tok) || isPunctTok(prev)) return false;
  if (tok.fixed || prev.fixed) return false;
  if (isLatinTok(tok) || isLatinTok(prev)) return false;
  if (prev.pos === '接頭詞') return true;
  switch (tok.pos) {
    case '助詞':
    case '助動詞':
      return true;
    case '動詞':
      return ['非自立', '接尾'].includes(tok.pos_detail_1)
        || (prev.pos === '名詞' && prev.pos_detail_1 === 'サ変接続' && ['する', 'できる'].includes(tok.basic_form));
    case '形容詞':
      return ['非自立', '接尾'].includes(tok.pos_detail_1);
    case '名詞':
      return tok.pos_detail_1 === '接尾' || (tok.pos_detail_1 === '非自立' && ['の', 'ん', 'ン'].includes(tok.surface_form));
    default:
      return false;
  }
}

/** 单词内部的罗马音分段：独立助词 / 非自立动词前加空格，便于阅读（kaze ni / sawatte ita） */
function startsRomajiRun(tok, idx, prev) {
  if (idx === 0) return true;
  // 名词 / 形容动词词干 + です・だ：kirei desu / tenki da
  if (tok.pos === '助動詞' && ['です', 'だ'].includes(tok.basic_form)
      && prev?.pos === '名詞' && prev.pos_detail_1 !== '非自立') return true;
  // 前一个 token 以促音结尾时不能断开，否则 っ 的双写辅音会丢失（hoshigatteru）
  if (/[っッ]$/.test(prev?.surface_form || '')) return false;
  if (tok.pos === '助詞' && tok.pos_detail_1 !== '接続助詞') return true;
  // 「見て いる」「して しまう」：只在接续助词 て/で 之后的非自立动词前断开；「てる」等缩约形不断开
  if (tok.pos === '動詞' && tok.pos_detail_1 === '非自立') return prev?.pos === '助詞' && ['て', 'で'].includes(prev.surface_form);
  return false;
}

function tokensToWord(tokens) {
  const t = tokens.map(x => x.surface_form).join('');
  if (tokens.every(isPunctTok)) return { t, k: '', r: '', p: 1 };
  if (tokens.length === 1 && isLatinTok(tokens[0])) return { t, k: '', r: t };
  const k = tokens.map(tok => tok.forcedKana ?? tokenKana(tok)).join('');
  // 罗马音分段
  const runs = [];
  tokens.forEach((tok, i) => {
    if (startsRomajiRun(tok, i, tokens[i - 1])) runs.push([tok]);
    else runs[runs.length - 1].push(tok);
  });
  const r = runs.map(run => {
    if (run.length === 1) {
      const tok = run[0];
      if (tok.forcedRomaji) return tok.forcedRomaji;
      if (tok.pos === '助詞') {
        if (tok.surface_form === 'は') return 'wa';
        if (tok.surface_form === 'へ') return 'e';
        if (tok.surface_form === 'を') return 'o';
      }
    }
    const kana = run.map(tok => tok.forcedKana ?? tokenKana(tok)).join('');
    return kana ? kanaToRomaji(kana) : run.map(x => x.surface_form).join('').toLowerCase();
  }).filter(Boolean).join(' ');
  return { t, k, r };
}

/** 文本 → token 列表（词典条目作为伪 token 强制插入） */
function tokenize(text) {
  const out = [];
  for (const seg of splitByDict(text)) {
    if (seg.entry) {
      out.push({
        surface_form: seg.text, pos: '名詞', pos_detail_1: '一般', basic_form: seg.text,
        reading: seg.entry.k, forcedKana: toHiragana(seg.entry.k), forcedRomaji: seg.entry.r || '',
        fixed: seg.entry.fixed,
      });
    } else {
      out.push(...tokenizer.tokenize(seg.text));
    }
  }
  return out;
}

function groupTokens(tokens) {
  const groups = [];
  let prev = null;
  for (const tok of tokens) {
    if (groups.length && attaches(prev, tok)) groups[groups.length - 1].push(tok);
    else if (groups.length && isPunctTok(tok) && isPunctTok(prev)) groups[groups.length - 1].push(tok);
    else groups.push([tok]);
    prev = tok;
  }
  return groups;
}

// ---------------------------------------------------------------- 外部注音（Marumaru ruby HTML）
/** ruby HTML → [{b, rt}]（rt 为 null 表示普通文本） */
export function parseRubyHTML(html) {
  if (!html) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = `<p>${html}</p>`;
  const p = tpl.content.firstElementChild;
  if (!p) return null;
  const segs = [];
  const walk = (node) => {
    node.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.nodeValue) segs.push({ b: n.nodeValue.replace(/ /g, ' '), rt: null });
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'ruby') {
          const clone = n.cloneNode(true);
          const rtEl = clone.querySelector('rt, rtc');
          const rt = rtEl?.textContent?.trim() || '';
          clone.querySelectorAll('rt, rtc, rp').forEach(x => x.remove());
          segs.push({ b: clone.textContent, rt: rt || null });
        } else if (tag === 'br') {
          segs.push({ b: ' ', rt: null });
        } else if (!['rt', 'rtc', 'rp'].includes(tag)) {
          walk(n);
        }
      }
    });
  };
  walk(p);
  return segs;
}

export function rubyPlainText(html) {
  const segs = parseRubyHTML(html);
  return segs ? segs.map(s => s.b).join('').trim() : '';
}

/** 用外部注音给一个词范围 [a,b) 推读音；注音块跨越词边界时返回 null */
function readingFromRuby(segs, a, b) {
  let pos = 0;
  let out = '';
  for (const seg of segs) {
    const len = seg.b.length;
    const s0 = pos, s1 = pos + len;
    pos = s1;
    if (s1 <= a || s0 >= b) continue;
    if (seg.rt) {
      if (s0 < a || s1 > b) return null;
      out += toHiragana(seg.rt);
    } else {
      out += toHiragana(seg.b.slice(Math.max(a, s0) - s0, Math.min(b, s1) - s0));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 对外接口
/**
 * 分析一行文本 → words[]。
 * opts.ruby：外部注音 HTML（来自 Marumaru），用于覆盖 kuromoji 的读音（演唱读法更准）。
 */
export async function analyzeText(text, { ruby = null } = {}) {
  const src = String(text || '');
  if (!src.trim()) return [];
  await ensureTokenizer();
  const groups = groupTokens(tokenize(src));
  let words = groups.map(tokensToWord);

  // 外部注音覆盖读音
  const segs = ruby ? parseRubyHTML(ruby) : null;
  const segText = segs ? segs.map(s => s.b).join('') : '';
  if (segs && segText.replace(/\s+/g, '') === src.replace(/\s+/g, '') && segText.length === src.length) {
    let pos = 0;
    words = words.map(w => {
      const a = pos;
      pos += w.t.length;
      if (w.p || !hasKanji(w.t)) return w;
      const k = readingFromRuby(segs, a, pos);
      if (k && k !== w.k) return { ...w, k, r: wordKanaToRomaji(w.t, k) };
      return w;
    });
  }
  return words;
}

/** 校验 words 是否与原文一致（原文被修改后需重新分析） */
export function wordsMatchText(words, text) {
  return Array.isArray(words) && words.map(w => w.t).join('') === String(text || '');
}

/** 整行罗马音：手动覆盖优先，否则由单词拼接 */
export function lineRomaji(line) {
  if (line.romaji) return line.romaji;
  return (line.words || []).filter(w => !w.p && w.r).map(w => w.r).join(' ');
}

/** 无分词器时的兜底：整行一个词，无读音 */
export function fallbackWords(text) {
  return String(text || '') ? [{ t: String(text), k: '', r: '' }] : [];
}

/** 给一段文本（拆分出的新词）求读音与罗马音 */
export async function readingFor(surface) {
  const words = await analyzeText(surface);
  const k = words.map(w => w.k || (w.p ? '' : '')).join('');
  const r = words.filter(w => !w.p).map(w => w.r).filter(Boolean).join(' ');
  return { k, r };
}


/** 动词 / 形容词的原形（辞书形），用于单词本：触った → {base: '触る', baseKana: 'さわる'}；不是活用词或已是原形时返回 null。需要分词器已加载。 */
export function baseFormOf(surface) {
  if (!tokenizer || !surface) return null;
  const toks = tokenizer.tokenize(surface);
  const i = toks.findIndex(t => ['動詞', '形容詞'].includes(t.pos) && t.pos_detail_1 !== '非自立');
  if (i < 0) return null;
  const tk = toks[i];
  if (!tk.basic_form || tk.basic_form === '*' || (tk.basic_form === tk.surface_form && i === toks.length - 1)) return null;
  const prefix = toks.slice(0, i);
  const base = prefix.map(t => t.surface_form).join('') + tk.basic_form;
  if (base === surface) return null;
  const baseToks = tokenizer.tokenize(tk.basic_form);
  const kana = prefix.map(t => tokenKana(t)).join('') + baseToks.map(t => tokenKana(t)).join('');
  return { base, baseKana: kana };
}
