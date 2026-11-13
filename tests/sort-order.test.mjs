// 曲库手动排序（songOrder 存设置）单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortSongsByOrder } from '../public/js/api.js';

const songs = [
  { id: 'a', lastOpenedAt: 5, updatedAt: 5 },
  { id: 'b', lastOpenedAt: 4, updatedAt: 4 },
  { id: 'c', lastOpenedAt: 3, updatedAt: 3 },
  { id: 'd', lastOpenedAt: 2, updatedAt: 2 },
];

test('order 为空时按最近打开倒序', () => {
  const out = sortSongsByOrder(songs, []);
  assert.deepEqual(out.map(s => s.id), ['a', 'b', 'c', 'd']);
  assert.equal(out.length, 4);
});

test('order 为 null/undefined 时同样退回最近优先', () => {
  assert.deepEqual(sortSongsByOrder(songs, null).map(s => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortSongsByOrder(songs, undefined).map(s => s.id), ['a', 'b', 'c', 'd']);
});

test('order 指定顺序生效', () => {
  const out = sortSongsByOrder(songs, ['c', 'a', 'd', 'b']);
  assert.deepEqual(out.map(s => s.id), ['c', 'a', 'd', 'b']);
});

test('不在 order 里的新歌置顶（按最近打开）', () => {
  const out = sortSongsByOrder(songs, ['b', 'c']);
  // a、d 不在 order：置顶，a 比 d 新
  assert.deepEqual(out.map(s => s.id), ['a', 'd', 'b', 'c']);
});

test('order 含已删除歌曲的 id 时被忽略', () => {
  const out = sortSongsByOrder(songs, ['c', 'ghost', 'a']);
  assert.deepEqual(out.map(s => s.id), ['b', 'd', 'c', 'a']);
});

test('不修改原数组（纯函数）', () => {
  const before = songs.map(s => s.id).join();
  sortSongsByOrder(songs, ['d', 'c', 'b', 'a']);
  assert.equal(songs.map(s => s.id).join(), before);
});
