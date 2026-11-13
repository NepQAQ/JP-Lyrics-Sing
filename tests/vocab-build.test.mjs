// 单词本核心逻辑测试（vocab-core.js 纯函数，上游 server/vocab.py 移植的回归）
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripParticles, buildVocab, toHiraStr, stripRomaji } from '../public/js/vocab-core.js';

test('toHiraStr 片假名转平假名', () => {
  assert.equal(toHiraStr('ア'), 'あ');
  assert.equal(toHiraStr('カタカナ'), 'かたかな');
  assert.equal(toHiraStr('あアーA'), 'ああーA'); // 平假名/长音/非假名不动
});

test('stripRomaji 去词尾助词罗马音', () => {
  assert.equal(stripRomaji('kimi no', 'no'), 'kimi');
  assert.equal(stripRomaji('kaze ga', 'ga'), 'kaze');
  assert.equal(stripRomaji('ze', 'ze'), 'ze'); // 长度相等不去
  assert.equal(stripRomaji('  kimi no  ', 'no'), 'kimi');
});

test('stripParticles 去一层助词（词面与读音都须匹配）', () => {
  assert.deepEqual(stripParticles('君の', 'きみの', 'kimi no'), { t: '君', k: 'きみ', r: 'kimi' });
  assert.deepEqual(stripParticles('裏切りは', 'うらぎりは', 'uragiri wa'), { t: '裏切り', k: 'うらぎり', r: 'uragiri' });
  assert.deepEqual(stripParticles('風が', 'かぜが', 'kaze ga'), { t: '風', k: 'かぜ', r: 'kaze' });
  // 读音不以助词结尾 → 不去
  assert.deepEqual(stripParticles('君の', 'きみ', 'kimi'), { t: '君の', k: 'きみ', r: 'kimi' });
});

test('stripParticles 最多两层', () => {
  // 君のには(には) → 君の(の) → 君
  assert.deepEqual(stripParticles('君のには', 'きみのには', 'kimi no ni wa'), { t: '君', k: 'きみ', r: 'kimi' });
});

test('stripParticles 剩余部分要像一个词（单个假名不去）', () => {
  // 「では」：去 は 剩「で」（单字符无汉字）→ 拒绝；去 で 剩「は」→ 拒绝
  assert.deepEqual(stripParticles('では', 'では', 'de wa'), { t: 'では', k: 'では', r: 'de wa' });
  // 片假名词尾助词也认（读音平假名化后匹配）
  assert.deepEqual(stripParticles('ドアを', 'ドアを', 'doa o'), { t: 'ドア', k: 'ドア', r: 'doa' });
});

test('buildVocab 基本整理：跳过助词词/纯英文，聚合计数与例句', () => {
  const songs = [
    { id: 's1', title: '風の歌', lines: [
      { id: 'l1', text: '風に触った', zh: '触碰了风', wordsEdited: true, words: [
        { t: '風に', k: 'かぜに', r: 'kaze ni' },
        { t: '触った', k: 'さわった', r: 'sawatta' },
      ] },
      { id: 'l2', text: '君の声', zh: '你的声音', wordsEdited: false, words: [
        { t: '君の', k: 'きみの', r: 'kimi no' },
        { t: '声', k: 'こえ', r: 'koe' },
        { t: 'は', k: 'は', r: 'wa', p: true },   // 助词词：跳过
        { t: 'Love', k: '', r: 'love' },          // 纯英文：跳过
        { t: 'あ', k: 'あ', r: 'a' },             // 单个假名：跳过
      ] },
    ] },
    { id: 's2', title: '海', lines: [
      { id: 'l3', text: '風が吹く', zh: '', wordsEdited: false, words: [
        { t: '風が', k: 'かぜが', r: 'kaze ga' },
      ] },
    ] },
  ];
  const entries = buildVocab(songs, {});
  const byT = new Map(entries.map(e => [e.t, e]));

  assert.ok(byT.has('風'));
  const kaze = byT.get('風');
  assert.equal(kaze.count, 2);
  assert.equal(kaze.k, 'かぜ');            // 编辑行读音优先
  assert.equal(kaze.edited, true);
  assert.deepEqual(kaze.forms.sort(), ['風に', '風が'].sort());
  assert.deepEqual(kaze.songs, [{ id: 's1', title: '風の歌' }, { id: 's2', title: '海' }]);
  assert.equal(kaze.examples.length, 2);   // 两句不同文本
  assert.equal(kaze.examples[0].lineId, 'l1');
  assert.equal(kaze.examples[0].form, '風に');

  assert.ok(byT.has('君'));
  assert.equal(byT.get('君').k, 'きみ');
  assert.ok(byT.has('声'));
  assert.ok(byT.has('触った'));
  assert.equal(entries.length, 4);         // 風/触った/君/声
});

test('buildVocab 编辑行读音优先，其它读法进 altReadings', () => {
  const songs = [
    { id: 's1', title: 'A', lines: [
      { id: 'l1', text: '風に', zh: '', wordsEdited: false, words: [{ t: '風に', k: 'ふうに', r: 'fuu ni' }] },
    ] },
    { id: 's2', title: 'B', lines: [
      { id: 'l2', text: '風に', zh: '', wordsEdited: true, words: [{ t: '風に', k: 'かぜに', r: 'kaze ni' }] },
    ] },
  ];
  // 先遇到非编辑行（ふう），后遇到编辑行（かぜ）→ 编辑行覆盖
  const entries = buildVocab(songs, {});
  const kaze = entries.find(e => e.t === '風');
  assert.equal(kaze.k, 'かぜ');
  assert.equal(kaze.edited, true);
  assert.deepEqual(kaze.altReadings, ['ふう']);
});

test('buildVocab 首词无读音时取频次最高读音（上游语义：首词 k 为初始值）', () => {
  const songs = [
    { id: 's1', title: 'A', lines: [
      { id: 'l1', text: 'x', zh: '', wordsEdited: false, words: [{ t: '風', k: '', r: '' }] },
      { id: 'l2', text: 'y', zh: '', wordsEdited: false, words: [{ t: '風', k: 'ふう', r: 'fuu' }] },
      { id: 'l3', text: 'z', zh: '', wordsEdited: false, words: [{ t: '風', k: 'かぜ', r: 'kaze' }] },
      { id: 'l4', text: 'w', zh: '', wordsEdited: false, words: [{ t: '風', k: 'かぜ', r: 'kaze' }] },
    ] },
  ];
  const entries = buildVocab(songs, {});
  const kaze = entries.find(e => e.t === '風');
  assert.equal(kaze.k, 'かぜ');            // 首词 k 为空 → 频次最高（2 次 > 1 次）
  assert.deepEqual(kaze.altReadings, ['ふう']);
  assert.equal(kaze.edited, false);
});

test('buildVocab 首词读音为初始值（频次不覆盖非空初始 k）', () => {
  const songs = [
    { id: 's1', title: 'A', lines: [
      { id: 'l1', text: 'x', zh: '', wordsEdited: false, words: [{ t: '風', k: 'ふう', r: 'fuu' }] },
      { id: 'l2', text: 'y', zh: '', wordsEdited: false, words: [{ t: '風', k: 'かぜ', r: 'kaze' }] },
      { id: 'l3', text: 'z', zh: '', wordsEdited: false, words: [{ t: '風', k: 'かぜ', r: 'kaze' }] },
    ] },
  ];
  const entries = buildVocab(songs, {});
  const kaze = entries.find(e => e.t === '風');
  assert.equal(kaze.k, 'ふう');            // 首词读音保留，频次兜底仅在 k 为空时生效
  assert.deepEqual(kaze.altReadings, ['かぜ']);
});

test('buildVocab 合并笔记（释义/收藏按词面跨歌曲共享）', () => {
  const songs = [
    { id: 's1', title: 'A', lines: [
      { id: 'l1', text: '君の', zh: '', wordsEdited: false, words: [{ t: '君の', k: 'きみの', r: 'kimi no' }] },
    ] },
  ];
  const notes = { 君: { meaning: '你', source: 'user', starred: true } };
  const entries = buildVocab(songs, notes);
  const kimi = entries.find(e => e.t === '君');
  assert.equal(kimi.meaning, '你');
  assert.equal(kimi.meaningSource, 'user');
  assert.equal(kimi.starred, true);
  assert.equal(kimi.note, '');
});

test('buildVocab 例句上限（默认 3 条）', () => {
  const lines = Array.from({ length: 7 }, (_, i) => ({
    id: `l${i}`, text: `風が吹く${i}`, zh: '', wordsEdited: false,
    words: [{ t: '風', k: 'かぜ', r: 'kaze' }],
  }));
  const songs = [{ id: 's1', title: 'A', lines }];
  const entries = buildVocab(songs, {});
  const kaze = entries.find(e => e.t === '風');
  assert.equal(kaze.count, 7);
  assert.equal(kaze.examples.length, 3);   // maxExamples 默认 3
});

test('buildVocab 例句同文本去重', () => {
  const mk = () => ({ id: `l${Math.random()}`, text: '風が吹く', zh: '', wordsEdited: false, words: [{ t: '風', k: 'かぜ', r: 'kaze' }] });
  const songs = [{ id: 's1', title: 'A', lines: [mk(), mk(), mk()] }];
  const entries = buildVocab(songs, {});
  const kaze = entries.find(e => e.t === '風');
  assert.equal(kaze.count, 3);
  assert.equal(kaze.examples.length, 1);   // 三行同文本只留一条
});
