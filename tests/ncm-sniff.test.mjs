// 任务 1 回归：accept 取消后，无扩展名 NCM 文件靠魔数识别（Android 场景）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNcmFile } from '../public/js/library.js';

const fakeFile = (name, bytes) => ({
  name,
  slice: () => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer }),
});

const NCM_MAGIC = [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d]; // 'CTENFDAM'
const MP3_HEAD = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]; // 'ID3'

test('isNcmFile：.ncm 扩展名 → true（不读文件头）', async () => {
  assert.equal(await isNcmFile(fakeFile('song.ncm', MP3_HEAD)), true);
});

test('isNcmFile：无扩展名但魔数 CTENFDAM → true（Android 返回无扩展名文件名）', async () => {
  assert.equal(await isNcmFile(fakeFile('song', NCM_MAGIC)), true);
  assert.equal(await isNcmFile(fakeFile('content://media/123', NCM_MAGIC)), true);
});

test('isNcmFile：普通音频（ID3 头、无扩展名）→ false', async () => {
  assert.equal(await isNcmFile(fakeFile('song', MP3_HEAD)), false);
  assert.equal(await isNcmFile(fakeFile('song.mp3', MP3_HEAD)), false);
});

test('isNcmFile：slice 抛错（不可读）→ 按扩展名回退', async () => {
  const bad = { name: 'x.ncm', slice: () => { throw new Error('unreadable'); } };
  assert.equal(await isNcmFile(bad), true);
  const bad2 = { name: 'x.mp3', slice: () => { throw new Error('unreadable'); } };
  assert.equal(await isNcmFile(bad2), false);
});
