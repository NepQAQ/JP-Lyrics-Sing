// 云同步前端合并逻辑单元测试：LWW 歌曲/词典/配置合并、JSON 安全解析。
// 纯函数从 public/js/cloud.js 导入（Node 可直接 import，无 DOM 依赖）。
// 运行：node --test tests/cloud-merge.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSongs, mergeDictionary, mergeConfig, parseJsonSafe } from '../public/js/cloud.js';

const song = (id, updatedAt) => ({ id, updatedAt, title: `t-${id}` });
const remote = (songId, updatedAt) => ({ songId, updatedAt, title: `t-${songId}` });

// ---------------------------------------------------------------- mergeSongs

test('mergeSongs：仅云端有 → 拉取', () => {
  const { toPull, toPush } = mergeSongs([], [remote('a', 100), remote('b', 200)]);
  assert.deepEqual(toPull.map((s) => s.songId), ['a', 'b']);
  assert.deepEqual(toPush, []);
});

test('mergeSongs：仅本地有 → 推送', () => {
  const { toPull, toPush } = mergeSongs([song('a', 100), song('b', 200)], []);
  assert.deepEqual(toPull, []);
  assert.deepEqual(toPush, ['a', 'b']);
});

test('mergeSongs：双向 LWW——云端较新拉取、本地较新推送', () => {
  const local = [song('newer-local', 300), song('newer-remote', 100)];
  const cloud = [remote('newer-local', 200), remote('newer-remote', 500)];
  const { toPull, toPush } = mergeSongs(local, cloud);
  assert.deepEqual(toPull.map((s) => s.songId), ['newer-remote']);
  assert.deepEqual(toPush, ['newer-local']);
});

test('mergeSongs：时间戳相同 → 双向都不动（避免循环同步）', () => {
  const { toPull, toPush } = mergeSongs([song('same', 100)], [remote('same', 100)]);
  assert.deepEqual(toPull, []);
  assert.deepEqual(toPush, []);
});

test('mergeSongs：混合场景', () => {
  const local = [song('local-only', 1), song('local-newer', 300), song('remote-newer', 100), song('tie', 50)];
  const cloud = [remote('local-newer', 200), remote('remote-newer', 500), remote('remote-only', 5), remote('tie', 50)];
  const { toPull, toPush } = mergeSongs(local, cloud);
  assert.deepEqual(toPull.map((s) => s.songId).sort(), ['remote-newer', 'remote-only']);
  assert.deepEqual(toPush.sort(), ['local-newer', 'local-only']);
});

test('mergeSongs：updatedAt 缺失按 0 处理；字符串时间戳可比较', () => {
  // 云端 updatedAt 为字符串（Dataverse String 列）
  const { toPull, toPush } = mergeSongs([song('x', 100)], [remote('x', '200')]);
  assert.deepEqual(toPull.map((s) => s.songId), ['x']);
  assert.deepEqual(toPush, []);

  const both0 = mergeSongs([song('y')], [remote('y', undefined)]);
  assert.deepEqual(both0.toPull, []);
  assert.deepEqual(both0.toPush, []);
});

test('mergeSongs：空输入与脏数据安全', () => {
  assert.deepEqual(mergeSongs(null, null), { toPull: [], toPush: [] });
  assert.deepEqual(mergeSongs([null, { id: 'ok', updatedAt: 1 }], [undefined, { songId: 'ok', updatedAt: 2 }]).toPull.map((s) => s.songId), ['ok']);
});

// ---------------------------------------------------------------- mergeDictionary

test('mergeDictionary：逐面 LWW，本地独有保留、云端独有并入', () => {
  const local = { surfaceA: { updatedAt: 100, data: 'old' }, surfaceB: { updatedAt: 500, data: 'local' } };
  const cloud = { surfaceA: { updatedAt: 300, data: 'new' }, surfaceC: { updatedAt: 50, data: 'cloud' } };
  const merged = mergeDictionary(local, cloud);
  assert.equal(merged.surfaceA.data, 'new'); // 云端较新
  assert.equal(merged.surfaceB.data, 'local'); // 本地独有
  assert.equal(merged.surfaceC.data, 'cloud'); // 云端独有
});

test('mergeDictionary：本地较新时保留本地', () => {
  const local = { s: { updatedAt: 900, data: 'local' } };
  const cloud = { s: { updatedAt: 100, data: 'cloud' } };
  assert.equal(mergeDictionary(local, cloud).s.data, 'local');
});

test('mergeDictionary：空输入安全', () => {
  assert.deepEqual(mergeDictionary(null, { s: { updatedAt: 1 } }), { s: { updatedAt: 1 } });
  assert.deepEqual(mergeDictionary({ s: { updatedAt: 1 } }, null), { s: { updatedAt: 1 } });
  assert.deepEqual(mergeDictionary(null, null), {});
  // 非对象条目跳过
  assert.deepEqual(mergeDictionary({}, { bad: 'string', good: { updatedAt: 2 } }), { good: { updatedAt: 2 } });
});

// ---------------------------------------------------------------- mergeConfig

test('mergeConfig：云端覆盖同名键，本地独有保留', () => {
  const local = { theme: 'dark', fontSize: 16, localOnly: true };
  const cloud = { theme: 'light', cloudOnly: 42 };
  const merged = mergeConfig(local, cloud);
  assert.equal(merged.theme, 'light');
  assert.equal(merged.fontSize, 16);
  assert.equal(merged.localOnly, true);
  assert.equal(merged.cloudOnly, 42);
});

test('mergeConfig：cloudSync 设备级开关不参与云端合并', () => {
  const local = { cloudSync: false, theme: 'dark' };
  const cloud = { cloudSync: true, theme: 'light' };
  const merged = mergeConfig(local, cloud);
  assert.equal(merged.cloudSync, false); // 本地值保留
  assert.equal(merged.theme, 'light');
});

test('mergeConfig：空输入安全', () => {
  assert.deepEqual(mergeConfig(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeConfig({ a: 1 }, null), { a: 1 });
  assert.deepEqual(mergeConfig(null, null), {});
});

// ---------------------------------------------------------------- parseJsonSafe

test('parseJsonSafe：合法 JSON 解析、非法/空返回 null', () => {
  assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonSafe('[1,2]'), [1, 2]);
  assert.equal(parseJsonSafe('not json'), null);
  assert.equal(parseJsonSafe(''), null);
  assert.equal(parseJsonSafe(null), null);
  assert.equal(parseJsonSafe(undefined), null);
});
