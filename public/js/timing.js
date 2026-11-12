// 时间轴计算（与音频同步的核心）
//
// LRC 只给出「每句开始时间」，原实现把「下一句开始」当作本句结束，并在整段区间内线性推进 KTV 进度：
//   * 句后有间奏/停顿时，高亮进度被拉长，看起来和原曲不同步；
//   * 单句播放会一直放到下一句开始，经常带进下一句的开头。
// 这里的改进：
//   1. 有逐字时间轴（网易云 yrc / PetitLyrics）时，句子起止 = 第一个字开始 / 最后一个字结束，逐字精确；
//   2. 没有时，按「假名音拍（mora）」估算这一句实际唱完的时间：
//      整首歌统计「每拍秒数」（取较快的分位数，排除带间奏的句子），句尾 = 开始 + 拍数 × 每拍秒数 × 余量；
//   3. KTV 进度按每个字的音拍数加权（汉字按读音拍数），不再按字符平均；
//   4. 单句播放的起止可加「提前开始 / 提前结束」余量（设置里可调）。
import { state } from './state.js';
import { alignRuby, toHiragana } from './kana.js';

const SMALL = /[ゃゅょぁぃぅぇぉゎ]/;

/** 假名的音拍数：小写拗音不计，促音/拨音/长音各计 1 拍 */
export function moraOfKana(k) {
  let n = 0;
  for (const ch of toHiragana(k || '')) {
    if (/[ぁ-ゖー]/.test(ch) && !SMALL.test(ch)) n++;
  }
  return n;
}

/** 与 line.text 逐字符对齐的音拍权重（KTV 加权进度、整句拍数都用它） */
export function charWeights(line) {
  const text = String(line.text || '');
  const chars = [...text];
  const words = line.words;
  if (!Array.isArray(words) || words.map(w => w.t).join('') !== text) {
    return chars.map(ch => (/[\s、。，,.!！?？「」『』]/.test(ch) ? 0 : 1));
  }
  const out = [];
  for (const w of words) {
    const wc = [...w.t];
    if (w.p) { wc.forEach(() => out.push(0)); continue; }
    if (!w.k) {
      wc.forEach(ch => out.push(/\s/.test(ch) ? 0 : (/[A-Za-z]/.test(ch) ? 0.35 : 1)));
      continue;
    }
    for (const seg of alignRuby(w.t, w.k)) {
      const bc = [...seg.b];
      if (seg.rt) {
        const m = Math.max(1, moraOfKana(seg.rt));
        bc.forEach(() => out.push(m / bc.length));
      } else {
        bc.forEach(ch => {
          const hch = toHiragana(ch);
          if (SMALL.test(hch)) out.push(0);
          else if (/[ぁ-ゖー]/.test(hch)) out.push(1);
          else if (/\s/.test(ch)) out.push(0);
          else out.push(0.5);
        });
      }
    }
  }
  return out.length === chars.length ? out : chars.map(() => 1);
}

export function lineMora(line) {
  return charWeights(line).reduce((a, b) => a + b, 0);
}

// 每拍秒数：按歌曲缓存
let spmCache = { key: '', value: 0.2 };
export function secPerMora(song = state.song) {
  if (!song?.lines?.length) return 0.2;
  const analyzed = song.lines.filter(l => Array.isArray(l.words)).length;
  const key = `${song.id}:${song.lines.length}:${analyzed}:${song.updatedAt}`;
  if (spmCache.key === key) return spmCache.value;
  const ratios = [];
  const lines = song.lines;
  for (let i = 0; i < lines.length - 1; i++) {
    const wt = lines[i].wordTiming;
    if (wt?.length && !isCoarseTiming(wt)) {
      // 有逐字数据的句子：直接用真实唱的时长
      const m = lineMora(lines[i]);
      const dur = (wt.at(-1).endtime - wt[0].starttime) / 1000;
      if (m >= 4 && dur > 0.3) ratios.push(dur / m);
      continue;
    }
    const m = lineMora(lines[i]);
    const gap = lineStart(lines[i + 1]) - lineStart(lines[i]);
    if (m >= 4 && gap > 0.3) ratios.push(gap / m);
  }
  let value = 0.2;
  if (ratios.length >= 3) {
    ratios.sort((a, b) => a - b);
    // 取 35% 分位：句间有间奏的句子比值偏大，取偏快的一侧更接近真实演唱速度
    value = ratios[Math.floor(ratios.length * 0.35)];
  }
  value = Math.min(0.45, Math.max(0.09, value));
  spmCache = { key, value };
  return value;
}

// ---------------------------------------------------------------- 粗粒度「逐字」数据修复
// PetitLyrics 有些歌曲的 Type 3 数据并不是真正的逐字时间：一整段的每个字 starttime 几乎相同、
// endtime == starttime（例：「風に触った闇は揺れて」10 个字全在 24.508~24.694s 之间）。
// 直接拿来做 KTV 会在 0.2 秒内「一下全跳完」。这类数据只保留「分段起点」（相邻字时间跳变 ≥ 250ms 处），
// 段内按音拍重新分配每个字的时间。真正的逐字数据（如网易云 yrc）不受影响。

/** 是否为粗粒度（伪逐字）数据：多数字时长≈0，或整句平均每字不到 60ms */
export function isCoarseTiming(wt) {
  if (!wt?.length) return false;
  const chars = wt.reduce((n, w) => n + [...w.text].length, 0) || 1;
  const zero = wt.filter(w => (w.endtime - w.starttime) < 30).length;
  const span = wt.at(-1).endtime - wt[0].starttime;
  return zero / wt.length > 0.5 || span < chars * 60;
}

function simpleWeight(ch) {
  const hch = toHiragana(ch);
  if (/[\s、。，,.!！?？「」『』()（）]/.test(ch)) return 0;
  if (SMALL.test(hch)) return 0;
  if (/[\u3041-\u3096ー]/.test(hch)) return 1;
  if (/[A-Za-z]/.test(ch)) return 0.35;
  return 1.6; // 汉字平均约 1.6 拍
}

const repaired = new WeakMap(); // line -> {src, next, spm, wt}

/** 本句用于计算的逐字时间（真实逐字数据原样返回；粗粒度数据按音拍修复） */
export function effectiveTiming(lines, idx) {
  const line = lines[idx];
  const wt = line?.wordTiming;
  if (!wt?.length) return null;
  if (!isCoarseTiming(wt)) return wt;
  const nxt = nextStart(lines, idx);
  const spm = secPerMora();
  const hit = repaired.get(line);
  if (hit && hit.src === wt && hit.next === nxt && hit.spm === spm) return hit.wt;

  // 逐字展开，权重优先用本行分词读音（与原文一致时），否则用简单估计
  const chars = [];
  wt.forEach(w => [...w.text].forEach(ch => chars.push({ ch, t: w.starttime })));
  const lw = charWeights(line);
  const useLine = chars.map(c => c.ch).join('') === String(line.text || '') && lw.length === chars.length;
  chars.forEach((c, i) => { c.w = useLine ? lw[i] : simpleWeight(c.ch); });

  // 分段：时间跳变 ≥ 250ms 处是一个新的演唱片段起点
  const phrases = [];
  let cur = null;
  for (const c of chars) {
    if (!cur || c.t - cur.last >= 250) { cur = { start: c.t, chars: [], last: c.t }; phrases.push(cur); }
    cur.chars.push(c);
    cur.last = c.t;
  }
  const out = [];
  phrases.forEach((ph, pi) => {
    const weight = ph.chars.reduce((a, c) => a + c.w, 0);
    const est = ph.start + (weight * spm * 1.2 + 0.25) * 1000;
    let limit = pi + 1 < phrases.length ? phrases[pi + 1].start - 60 : (Number.isFinite(nxt) ? nxt * 1000 - 100 : est);
    const end = Math.max(ph.start + 200, Math.min(est, limit));
    let tcur = ph.start;
    const per = weight > 0 ? (end - ph.start) / weight : 0;
    for (const c of ph.chars) {
      const d = c.w * per;
      out.push({ text: c.ch, starttime: Math.round(tcur), endtime: Math.round(tcur + d) });
      tcur += d;
    }
  });
  repaired.set(line, { src: wt, next: nxt, spm, wt: out });
  return out;
}

/** 句子的实际开始时间（歌词时间轴，秒） */
export function lineStart(line) {
  const wt = line?.wordTiming;
  return wt?.length ? wt[0].starttime / 1000 : (line?.time ?? 0);
}

/** 点击歌词行 / 跳行时的预滚量（秒）：seek 到行开始前一点，防行首被切。 */
export const LINE_PREROLL = 0.05;
// 行查找容差：略大于预滚，保证预滚窗口内（暂停点击/跳行后）仍命中目标行而非上一行
const LINE_IDX_EPSILON = LINE_PREROLL + 0.01;

/** t 时刻应高亮的行下标：最后一个 lineStart ≤ t + 容差 的行（二分，行需按开始时间升序）；无命中返回 -1。 */
export function findActiveLineIdx(lines, t) {
  const arr = lines || [];
  let lo = 0, hi = arr.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStart(arr[mid]) <= t + LINE_IDX_EPSILON) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

export function nextStart(lines, idx) {
  const s = lineStart(lines[idx]);
  for (let j = idx + 1; j < lines.length; j++) {
    const t = lineStart(lines[j]);
    if (t > s + 0.01) return t;
  }
  return Infinity;
}

/** 这一句「唱完」的时间（KTV 进度在此到达 100%） */
export function sungEnd(lines, idx) {
  const line = lines[idx];
  const start = lineStart(line);
  const nxt = nextStart(lines, idx);
  const wt = effectiveTiming(lines, idx);
  if (wt?.length) return Math.min(wt.at(-1).endtime / 1000, nxt);
  // LRC 里显式的句尾（空白时间标签 / 网易云行时长）比下一句更早时，直接采用
  if (Number.isFinite(line.end) && line.end > start && line.end < nxt - 0.05) return line.end;
  const fallback = Number.isFinite(nxt) ? nxt : start + 6;
  if (state.settings.estimateSungEnd === false) return fallback;
  const est = start + lineMora(line) * secPerMora() * 1.25 + 0.6;
  return Math.max(start + 0.5, Math.min(fallback, est));
}

/** 单句播放 / 循环的音频区间（歌词时间） */
export function segmentRange(lines, idx) {
  const s = state.settings;
  const lead = Number.isFinite(s.segLead) ? s.segLead : 0.15;
  const trim = Number.isFinite(s.segTrim) ? s.segTrim : 0.2;
  const line = lines[idx];
  const st = lineStart(line);
  let start = Math.max(0, st - lead);
  if (idx > 0) {
    // 不要把上一句的尾音带进来
    const prevEnd = sungEnd(lines, idx - 1);
    if (prevEnd < st) start = Math.max(start, Math.min(prevEnd, st - 0.05));
  }
  const nxt = nextStart(lines, idx);
  let end = sungEnd(lines, idx) + (line.wordTiming?.length ? 0.3 : 0.2);
  if (Number.isFinite(nxt)) end = Math.min(end, nxt - trim);
  if (end < st + 0.4) end = Number.isFinite(nxt) ? Math.max(st + 0.4, nxt - 0.05) : st + 3;
  return { start, end };
}

/** 句内 KTV 进度 {p: 0~1, weighted}：weighted=true 表示 p 是按音拍的进度，需经 weightedChars 映射到字符 */
export function karaokeProgress(lines, idx, t) {
  const line = lines[idx];
  const wt = effectiveTiming(lines, idx);
  if (wt?.length) {
    const ms = t * 1000;
    const total = wt.reduce((s, w) => s + w.text.length, 0) || 1;
    let done = 0;
    for (const w of wt) {
      if (ms >= w.endtime) done += w.text.length;
      else if (ms >= w.starttime) {
        const d = w.endtime - w.starttime;
        done += w.text.length * (d > 0 ? (ms - w.starttime) / d : 1);
        break;
      } else break;
    }
    return { p: Math.min(1, done / total), weighted: false };
  }
  const start = lineStart(line);
  const end = sungEnd(lines, idx);
  return { p: Math.min(1, Math.max(0, (t - start) / Math.max(0.1, end - start))), weighted: true };
}

/** 把「按音拍的进度」映射为已唱字符数（汉字 1 字多拍、小写假名 0 拍） */
export function weightedChars(line, progress, domCount) {
  const w = charWeights(line);
  if (w.length !== domCount) return progress * domCount;
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let target = progress * total;
  for (let i = 0; i < w.length; i++) {
    if (target <= 0) return i;
    if (target < w[i]) return i + target / w[i];
    target -= w[i];
  }
  return w.length;
}
