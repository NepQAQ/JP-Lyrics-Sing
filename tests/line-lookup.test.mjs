import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findActiveLineIdx, lineStart, LINE_PREROLL } from '../public/js/timing.js';

// 行开始时间升序的模拟歌词（秒）
const lines = [
  { time: 10.0, text: 'line0' },
  { time: 20.0, text: 'line1' },
  { time: 30.0, text: 'line2' },
  { time: 40.0, text: 'line3' },
];

test('LINE_PREROLL 常量为 0.05（预滚量）', () => {
  assert.equal(LINE_PREROLL, 0.05);
});

test('回归：暂停点击行 → t = lineStart - 0.05 命中目标行（而非上一行）', () => {
  for (let i = 0; i < lines.length; i++) {
    const t = lineStart(lines[i]) - LINE_PREROLL;
    assert.equal(findActiveLineIdx(lines, t), i, `line ${i} 预滚窗口应命中自身`);
  }
});

test('t = lineStart - 0.07（超出容差）命中上一行', () => {
  assert.equal(findActiveLineIdx(lines, 20.0 - 0.07), 0);
  assert.equal(findActiveLineIdx(lines, 30.0 - 0.07), 1);
  assert.equal(findActiveLineIdx(lines, 40.0 - 0.07), 2);
});

test('t 恰好等于 lineStart 命中目标行', () => {
  for (let i = 0; i < lines.length; i++) {
    assert.equal(findActiveLineIdx(lines, lineStart(lines[i])), i);
  }
});

test('t = lineStart - 0.06（恰好容差边界）仍命中目标行', () => {
  // 容差 = LINE_PREROLL + 0.01 = 0.06，边界取等
  assert.equal(findActiveLineIdx(lines, 20.0 - 0.06), 1);
  assert.equal(findActiveLineIdx(lines, 30.0 - 0.06), 2);
});

test('首行：seek 到 0（Math.max(0, ...) 钳零）命中第 0 行', () => {
  const zeroStart = [{ time: 0, text: 'a' }, { time: 10.0, text: 'b' }];
  assert.equal(findActiveLineIdx(zeroStart, 0), 0);
});

test('首行预滚钳零后仍命中第 0 行', () => {
  const early = [{ time: 0.02, text: 'early' }, { time: 5.0, text: 'next' }];
  const t = Math.max(0, lineStart(early[0]) - LINE_PREROLL);
  assert.equal(t, 0);
  assert.equal(findActiveLineIdx(early, t), 0);
});

test('t 在两行之间命中较早的行', () => {
  assert.equal(findActiveLineIdx(lines, 25.0), 1);
  assert.equal(findActiveLineIdx(lines, 39.999), 3);
});

test('t 超过最后一行命中最后一行', () => {
  assert.equal(findActiveLineIdx(lines, 999.0), 3);
});

test('wordTiming 行：starttime 毫秒换算后同样命中', () => {
  const wtLines = [
    { wordTiming: [{ starttime: 15000 }], text: 'a' },
    { wordTiming: [{ starttime: 25000 }], text: 'b' },
  ];
  assert.equal(findActiveLineIdx(wtLines, 15.0 - LINE_PREROLL), 0);
  assert.equal(findActiveLineIdx(wtLines, 25.0 - LINE_PREROLL), 1);
  assert.equal(findActiveLineIdx(wtLines, 25.0 - 0.07), 0);
});

test('无命中（首行前且超出容差）返回 -1', () => {
  assert.equal(findActiveLineIdx(lines, 10.0 - 0.07), -1);
  assert.equal(findActiveLineIdx(lines, -1), -1);
});

test('空数组 / null 返回 -1', () => {
  assert.equal(findActiveLineIdx([], 5), -1);
  assert.equal(findActiveLineIdx(null, 5), -1);
  assert.equal(findActiveLineIdx(undefined, 5), -1);
});
