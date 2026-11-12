// 云同步前端合并逻辑单元测试：LWW 歌曲/词典/配置合并、JSON 安全解析。
// 纯函数从 public/js/cloud.js 导入（Node 可直接 import，无 DOM 依赖）。
// 运行：node --test tests/cloud-merge.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSongs, mergeDictionary, mergeConfig, parseJsonSafe, audioSig, songsNeedingAudioUpload, resolvePushAudioPath } from '../public/js/cloud.js';

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

// ---------------------------------------------------------------- audioSig / songsNeedingAudioUpload

test('audioSig：size:mime:name 指纹；无音频返回 null', () => {
  assert.equal(audioSig({ audio: { size: 1024, mime: 'audio/mpeg', name: 'a.mp3' } }), '1024:audio/mpeg:a.mp3');
  assert.equal(audioSig({}), null);
  assert.equal(audioSig({ audio: null }), null);
  assert.equal(audioSig(null), null);
  assert.equal(audioSig(undefined), null);
});

test('songsNeedingAudioUpload：签名缺失或变化 → 补传；一致 → 跳过', () => {
  const songs = [
    { id: 'a', audio: { size: 1, mime: 'audio/mpeg', name: 'a.mp3' } },
    { id: 'b', audio: { size: 2, mime: 'audio/mpeg', name: 'b.mp3' } },
    { id: 'c', audio: { size: 3, mime: 'audio/mpeg', name: 'c.mp3' } },
    { id: 'no-audio' },
  ];
  const sigs = { a: '1:audio/mpeg:a.mp3', b: '999:audio/mpeg:b.mp3' };
  // a 签名一致跳过；b 签名变化补传；c 无记录补传；no-audio 无音频不涉及
  assert.deepEqual(songsNeedingAudioUpload(songs, sigs), ['b', 'c']);
});

test('songsNeedingAudioUpload：空 sigs（sharepoint 翻转场景）→ 全部有音频的歌补传', () => {
  const songs = [
    { id: 'a', audio: { size: 1, mime: 'audio/mpeg', name: 'a.mp3' } },
    { id: 'b', audio: { size: 2, mime: 'audio/mpeg', name: 'b.mp3' } },
    { id: 'none' },
  ];
  assert.deepEqual(songsNeedingAudioUpload(songs, {}), ['a', 'b']);
  assert.deepEqual(songsNeedingAudioUpload(songs, null), ['a', 'b']);
});

test('songsNeedingAudioUpload：空输入与脏数据安全', () => {
  assert.deepEqual(songsNeedingAudioUpload(null, null), []);
  assert.deepEqual(songsNeedingAudioUpload([null, { audio: { size: 1, mime: 'm', name: 'n' } }], {}), []);
});

// ---------------------------------------------------------------- resolvePushAudioPath

const SIG = '100:audio/mpeg:song.mp3';
const SIG2 = '200:audio/mpeg:new-song.mp3';

test('resolvePushAudioPath：首次上传前（无决策无签名）→ null，不发路径', () => {
  assert.equal(resolvePushAudioPath({ sig: SIG, uid: 'u1', id: 's1', decisions: {}, sigs: {} }), null);
});

test('resolvePushAudioPath：已上传过（签名一致）→ 自己的路径', () => {
  assert.equal(
    resolvePushAudioPath({ sig: SIG, uid: 'u1', id: 's1', decisions: {}, sigs: { s1: SIG } }),
    'Songs/u1/s1'
  );
});

test('resolvePushAudioPath：云端副本决策（sig 一致）→ 共享路径', () => {
  const decisions = { s1: { sig: SIG, choice: 'cloud', path: 'Songs/other/song-x' } };
  assert.equal(resolvePushAudioPath({ sig: SIG, uid: 'u1', id: 's1', decisions, sigs: {} }), 'Songs/other/song-x');
});

test('resolvePushAudioPath：自己上传决策（sig 一致）→ 自己的路径', () => {
  const decisions = { s1: { sig: SIG, choice: 'own' } };
  assert.equal(resolvePushAudioPath({ sig: SIG, uid: 'u1', id: 's1', decisions, sigs: {} }), 'Songs/u1/s1');
});

test('resolvePushAudioPath：决策 sig 过期（文件更换）→ 重新走首传流程', () => {
  const decisions = { s1: { sig: SIG, choice: 'cloud', path: 'Songs/other/song-x' } };
  // 新 sig 与决策不符、与已上传签名也不符 → null（触发查重/上传流程）
  assert.equal(resolvePushAudioPath({ sig: SIG2, uid: 'u1', id: 's1', decisions, sigs: { s1: SIG } }), null);
});

test('resolvePushAudioPath：无音频 / 缺 uid / 缺 id → null', () => {
  assert.equal(resolvePushAudioPath({ sig: null, uid: 'u1', id: 's1', decisions: {}, sigs: {} }), null);
  assert.equal(resolvePushAudioPath({ sig: SIG, uid: null, id: 's1', decisions: {}, sigs: {} }), null);
  assert.equal(resolvePushAudioPath({ sig: SIG, uid: 'u1', id: null, decisions: {}, sigs: {} }), null);
  assert.equal(resolvePushAudioPath({}), null);
});

test('resolvePushAudioPath：cloud 决策缺 path（脏数据）→ 不发共享路径', () => {
  const decisions = { s1: { sig: SIG, choice: 'cloud' } };
  assert.equal(resolvePushAudioPath({ sig: SIG, uid: 'u1', id: 's1', decisions, sigs: {} }), null);
});
