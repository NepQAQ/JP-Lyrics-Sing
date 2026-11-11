const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
const source = fs.readFileSync(path.join(root, 'ncm-worker.js'), 'utf8');
const aesjs = require(path.join(root, 'lib', 'aes-js-3.1.2.js'));
const context = vm.createContext({ aesjs, self: {}, importScripts() {}, Uint8Array, ArrayBuffer, DataView });
vm.runInContext(source, context);

function u32(number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(number);
  return buffer;
}

function makeNcm(audio) {
  const streamKey = Buffer.from('synthetic-stream-key');
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('hzHRAmso5kInbaxW'), null);
  const key = Buffer.concat([cipher.update(Buffer.concat([Buffer.from('neteasecloudmusic'), streamKey])), cipher.final()]);
  for (let i = 0; i < key.length; i++) key[i] ^= 0x64;
  const box = Uint8Array.from({ length: 256 }, (_, i) => i);
  let last = 0;
  for (let i = 0; i < 256; i++) {
    const swap = box[i];
    last = (swap + last + streamKey[i % streamKey.length]) & 255;
    box[i] = box[last];
    box[last] = swap;
  }
  const encrypted = Buffer.from(audio);
  for (let i = 0; i < encrypted.length; i++) {
    const j = (i + 1) & 255;
    encrypted[i] ^= box[(box[j] + box[(box[j] + j) & 255]) & 255];
  }
  return Buffer.concat([Buffer.from('CTENFDAM'), Buffer.alloc(2), u32(key.length), key,
    u32(0), Buffer.alloc(5), u32(0), u32(0), encrypted]);
}

function decode(data) {
  const bytes = Uint8Array.from(data);
  const result = context.decodeNcm(bytes.buffer);
  return { ...result, audio: Buffer.from(bytes.subarray(result.offset)) };
}

test('restores synthetic formats without transcoding', () => {
  for (const [prefix, format, mime] of [
    ['ID3synthetic audio', 'MP3', 'audio/mpeg'],
    ['fLaCsynthetic audio', 'FLAC', 'audio/flac'],
    ['OggSsynthetic audio', 'Ogg', 'audio/ogg'],
    ['RIFFxxxxWAVEdata', 'WAV', 'audio/wav'],
    ['xxxxftypM4A audio', 'MP4/M4A', 'audio/mp4'],
  ]) {
    const audio = Buffer.from(prefix);
    const result = decode(makeNcm(audio));
    assert.equal(result.format, format);
    assert.equal(result.mime, mime);
    assert.deepEqual(result.audio, audio);
  }
});

test('rejects invalid headers, keys, truncated segments and unknown audio', () => {
  const valid = makeNcm(Buffer.from('ID3synthetic audio'));
  assert.throws(() => decode(Buffer.from('not an ncm file')), /NCM/);
  assert.throws(() => decode(valid.subarray(0, 20)), /NCM/);
  const badKeyLength = Buffer.from(valid);
  badKeyLength.writeUInt32LE(0xffffffff, 10);
  assert.throws(() => decode(badKeyLength), /密钥/);
  const badKey = Buffer.from(valid);
  badKey[16] ^= 7;
  assert.throws(() => decode(badKey), /密钥/);
  const badCover = Buffer.from(valid);
  badCover.writeUInt32LE(0xffffffff, 14 + valid.readUInt32LE(10) + 4 + 5);
  assert.throws(() => decode(badCover), /损坏|不完整/);
  assert.throws(() => decode(makeNcm(Buffer.from('unknown data'))), /格式/);
});
