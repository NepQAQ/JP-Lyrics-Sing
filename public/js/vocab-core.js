// 单词本核心：从歌词行的分词结果（line.words）自动整理单词。
// 上游 server/vocab.py 的纯客户端移植——本模块只做统计与词尾助词剥离，不碰存储，
// 保持可在 node --test 下单测；释义 / 收藏笔记由调用方（api.vocab）按词面合并。
//
// * 直接使用歌词里显示的「词」（包含用户合并 / 拆分 / 改读音后的结果），单词本始终跟随编辑；
// * 去掉词尾助词：「君の」→「君」、「裏切りは」→「裏切り」、「暇なんて」→「暇」（读音与罗马音同步去掉）；
// * 跳过标点、纯英文、只剩一个假名的词；
// * 按词面合并：同一个词在多首歌 / 多行出现时计数并保留例句；读音优先取用户手动编辑过的行。

// 词尾助词（长的在前）及其罗马音
export const PARTICLES = [
  ['ばかり', 'bakari'], ['くらい', 'kurai'], ['ぐらい', 'gurai'], ['なんて', 'nante'], ['なんか', 'nanka'],
  ['から', 'kara'], ['まで', 'made'], ['より', 'yori'], ['って', 'tte'], ['だけ', 'dake'], ['しか', 'shika'],
  ['ほど', 'hodo'], ['など', 'nado'], ['さえ', 'sae'], ['こそ', 'koso'], ['でも', 'demo'], ['には', 'ni wa'],
  ['では', 'de wa'], ['とは', 'to wa'], ['へと', 'e to'],
  ['は', 'wa'], ['が', 'ga'], ['を', 'o'], ['に', 'ni'], ['へ', 'e'], ['で', 'de'], ['と', 'to'], ['も', 'mo'],
  ['の', 'no'], ['や', 'ya'], ['か', 'ka'], ['ね', 'ne'], ['よ', 'yo'], ['さ', 'sa'], ['ぞ', 'zo'], ['ぜ', 'ze'],
];

export const RE_KANJI = /[㐀-鿿豈-﫿々〆ヶ]/;
export const RE_KANA = /^[ぁ-ゖァ-ヺー]+$/;
export const RE_LATIN = /^[\x20-\x7e]+$/;

/** 片假名 → 平假名（ァ-ヶ 区间平移 0x60）。 */
export function toHiraStr(s) {
  let out = '';
  for (const c of String(s || '')) {
    const code = c.codePointAt(0);
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : c;
  }
  return out;
}

/** 从罗马音尾部去掉助词的罗马音（带空格优先，去完 trim）。 */
export function stripRomaji(r, pr) {
  r = String(r || '').trim();
  if (r.endsWith(' ' + pr)) return r.slice(0, -pr.length - 1).trim();
  if (r.endsWith(pr) && r.length > pr.length) return r.slice(0, -pr.length).trim();
  return r;
}

/**
 * 去掉词尾助词（最多两层），词面与读音都必须以该助词结尾才去掉。
 * 剩下的部分要像一个词：有汉字 / 片假名，或至少两个字符。
 */
export function stripParticles(t, k, r) {
  t = String(t || '');
  k = String(k || '');
  r = String(r || '');
  outer:
  for (let round = 0; round < 2; round++) {
    for (const [p, pr] of PARTICLES) {
      if (!t.endsWith(p) || t.length <= p.length) continue;
      const core = t.slice(0, -p.length);
      if (k && !toHiraStr(k).endsWith(p)) continue;
      if (!(RE_KANJI.test(core) || /[ァ-ヺ]/.test(core) || core.length >= 2)) continue;
      t = core;
      if (k) k = k.slice(0, -p.length);
      r = stripRomaji(r, pr);
      continue outer;
    }
    break; // 一整轮都没有命中助词：结束
  }
  return { t, k, r };
}

/**
 * 整理单词。songs: [{id, title, lines: [{id, text, zh, words, wordsEdited}]}]（按曲库顺序传入，
 * 决定「按出现顺序」的排序）；notes: { [词面]: {meaning, source, note, starred} }（跨歌曲共享）。
 * 返回 entries: [{t, k, r, forms, count, songs, examples, altReadings, edited, meaning, meaningSource, note, starred}]。
 */
export function buildVocab(songs, notes = {}, maxExamples = 3) {
  const entries = new Map();
  for (const song of songs || []) {
    const sid = song?.id;
    if (!sid) continue;
    const title = String(song.title || '');
    for (const line of song.lines || []) {
      const words = line?.words;
      if (!Array.isArray(words)) continue;
      const text = String(line.text || '');
      const zh = String(line.zh || '');
      const edited = !!line.wordsEdited;
      for (const w of words) {
        if (!w || w.p) continue;
        const t0 = String(w.t || '').trim();
        if (!t0 || RE_LATIN.test(t0)) continue;
        const { t, k, r } = stripParticles(t0, String(w.k || ''), String(w.r || ''));
        if (!t || (RE_KANA.test(t) && t.length < 2)) continue;
        let e = entries.get(t);
        if (!e) {
          e = { t, k, r, forms: [], count: 0, songs: [], examples: [], readings: {}, edited: false };
          entries.set(t, e);
        }
        e.count += 1;
        if (k) {
          e.readings[k] = (e.readings[k] || 0) + 1;
          if (edited && !e.edited) {
            // 用户手动编辑过的行优先：单词本读音跟随编辑
            e.k = k;
            e.r = r;
            e.edited = true;
          }
        }
        if (t0 !== t && !e.forms.includes(t0) && e.forms.length < 6) e.forms.push(t0);
        if (!e.songs.some((s) => s.id === sid)) e.songs.push({ id: sid, title });
        if (e.examples.length < maxExamples && !e.examples.some((x) => x.text === text)) {
          e.examples.push({ songId: sid, lineId: line.id, text, zh, form: t0 });
        }
      }
    }
  }
  const out = [];
  for (const e of entries.values()) {
    const readings = e.readings;
    delete e.readings;
    const keys = Object.keys(readings);
    if (keys.length && !e.k) e.k = keys.reduce((a, b) => (readings[b] > readings[a] ? b : a));
    e.altReadings = keys.filter((k) => k !== e.k);
    const n = (notes && notes[e.t]) || {};
    e.meaning = n.meaning || '';
    e.meaningSource = n.source || '';
    e.note = n.note || '';
    e.starred = !!n.starred;
    out.push(e);
  }
  return out;
}
