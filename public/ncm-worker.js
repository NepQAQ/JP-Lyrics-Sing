/* NCM parsing adapted from ncmdump-js; license and source: lib/NCM-LICENSES.txt. */
importScripts('lib/aes-js-3.1.2.js');

const CORE_KEY = Uint8Array.from([
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f,
  0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57,
]);
const MAGIC = 'CTENFDAM';
const KEY_PREFIX = 'neteasecloudmusic';
// 元数据（歌名/歌手）解密密钥：用于导入 NCM 时自动填写标题，失败不影响音频还原
const META_KEY = Uint8Array.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21,
  0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28,
]);

function decodeMeta(raw) {
  try {
    const bytes = raw.map(b => b ^ 0x63);
    const b64 = new TextDecoder().decode(bytes.subarray(22)); // 去掉 "163 key(Don't modify):"
    const bin = atob(b64);
    const enc = Uint8Array.from(bin, c => c.charCodeAt(0));
    const dec = new aesjs.ModeOfOperation.ecb(META_KEY).decrypt(enc);
    const pad = dec[dec.length - 1];
    const text = new TextDecoder().decode(dec.subarray(0, dec.length - pad));
    const json = JSON.parse(text.replace(/^music:/, ''));
    return {
      title: json.musicName || '',
      artist: (json.artist || []).map(a => a[0]).join(' / '),
      album: json.album || '',
    };
  } catch {
    return null;
  }
}

function identifyAudio(bytes) {
  const starts = text => Array.from(text).every((char, i) => bytes[i] === char.charCodeAt(0));
  if (starts('fLaC')) return { format: 'FLAC', mime: 'audio/flac' };
  if (starts('OggS')) return { format: 'Ogg', mime: 'audio/ogg' };
  if (starts('RIFF') && bytes.length >= 12 &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE') return { format: 'WAV', mime: 'audio/wav' };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return { format: 'MP4/M4A', mime: 'audio/mp4' };
  if (starts('ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) {
    return { format: 'MP3', mime: 'audio/mpeg' };
  }
  throw new Error('不支持或无法识别还原后的音频格式。');
}

function decodeNcm(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;
  const requireBytes = count => {
    if (!Number.isSafeInteger(count) || count < 0 || count > data.length - offset) {
      throw new Error('NCM 文件损坏或不完整。');
    }
  };
  const readLength = () => {
    requireBytes(4);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const skip = count => { requireBytes(count); offset += count; };
  requireBytes(10);
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i)) throw new Error('不是有效的 NCM 文件。');
  }
  offset = 10;
  const keyLength = readLength();
  if (keyLength < 16 || keyLength > 4096 || keyLength % 16) throw new Error('NCM 密钥数据无效。');
  requireBytes(keyLength);
  const encryptedKey = data.slice(offset, offset + keyLength);
  offset += keyLength;
  for (let i = 0; i < encryptedKey.length; i++) encryptedKey[i] ^= 0x64;
  const decrypted = new aesjs.ModeOfOperation.ecb(CORE_KEY).decrypt(encryptedKey);
  const pad = decrypted[decrypted.length - 1];
  if (pad < 1 || pad > 16 || decrypted.length - pad <= KEY_PREFIX.length ||
      !decrypted.slice(decrypted.length - pad).every(byte => byte === pad) ||
      !Array.from(KEY_PREFIX).every((char, i) => decrypted[i] === char.charCodeAt(0))) {
    throw new Error('NCM 密钥无效或版本不受支持。');
  }
  const key = decrypted.subarray(KEY_PREFIX.length, decrypted.length - pad);
  const box = Uint8Array.from({ length: 256 }, (_, i) => i);
  let last = 0;
  for (let i = 0; i < 256; i++) {
    const swap = box[i];
    last = (swap + last + key[i % key.length]) & 255;
    box[i] = box[last];
    box[last] = swap;
  }
  const metaLength = readLength();
  requireBytes(metaLength);
  const meta = metaLength ? decodeMeta(data.slice(offset, offset + metaLength)) : null;
  offset += metaLength;
  skip(5);
  const coverLength = readLength();
  const imageLength = readLength();
  if (imageLength > coverLength) throw new Error('NCM 封面数据损坏。');
  skip(coverLength);
  if (offset >= data.length) throw new Error('NCM 文件没有音频数据。');
  const audio = data.subarray(offset);
  for (let i = 0; i < audio.length; i++) {
    const j = (i + 1) & 255;
    audio[i] ^= box[(box[j] + box[(box[j] + j) & 255]) & 255];
  }
  return { ...identifyAudio(audio), offset, meta };
}

self.onmessage = async event => {
  try {
    const buffer = await event.data.arrayBuffer();
    const result = decodeNcm(buffer);
    self.postMessage({ ...result, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || 'NCM 文件读取或转换失败。' });
  }
};
