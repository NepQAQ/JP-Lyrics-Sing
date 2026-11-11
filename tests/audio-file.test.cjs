const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = source.indexOf('/* ---------------- File inputs ---------------- */');
const end = source.indexOf("$('#lrc-file').addEventListener", start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) {
      const el = new EventTarget();
      Object.assign(el, { value: '', textContent: '', files: [], removeAttribute() {} });
      elements.set(selector, el);
    }
    return elements.get(selector);
  };
  const audio = {
    src: '', pause() {}, load() {}, removeAttribute() { this.src = ''; },
    canPlayType: () => 'probably',
  };
  const urls = [];
  const revoked = [];
  const workers = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(file) { this.file = file; }
    terminate() { this.terminated = true; }
  }
  const songPractice = {
    enabled: false, audioReady: true, audioError: '', audioLoading: '', audioFormat: '',
    objectURL: 'blob:old', offset: 2,
  };
  const context = vm.createContext({
    $, audio, songPractice, Worker, Blob, Uint8Array,
    URL: {
      createObjectURL(blob) { const url = `blob:${urls.length}`; urls.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    stopSongPractice() {}, stopStudySpeech() {}, switchToAudioMode() {},
    setPlayerVisible() {}, setStatus() {}, updateSongPracticeUI() {},
    audioFileRequestId: 0, ncmWorker: null,
  });
  vm.runInContext(source.slice(start, end), context);
  function choose(name) {
    const input = $('#audio-file');
    input.files = [{ name }];
    input.dispatchEvent(new Event('change'));
    return input;
  }
  return { context, songPractice, audio, urls, revoked, workers, choose };
}

test('replacement cancels worker, ignores stale results and releases old URLs', () => {
  const f = fixture();
  assert.equal(f.choose('first.ncm').value, '');
  const first = f.workers[0];
  assert.deepEqual(f.revoked, ['blob:old']);
  f.choose('second.mp3');
  assert.equal(first.terminated, true);
  assert.equal(f.songPractice.objectURL, 'blob:0');
  first.onmessage({ data: { buffer: new ArrayBuffer(4), offset: 0, mime: 'audio/mpeg', format: 'MP3' } });
  assert.equal(f.songPractice.objectURL, 'blob:0');
  assert.equal(f.urls.length, 1);
  f.choose('third.ncm');
  assert.deepEqual(f.revoked, ['blob:old', 'blob:0']);
  f.workers[1].onmessage({ data: { buffer: new ArrayBuffer(4), offset: 0, mime: 'audio/flac', format: 'FLAC' } });
  assert.equal(f.songPractice.audioFormat, 'FLAC');
  assert.equal(f.urls[1].blob.type, 'audio/flac');
  assert.equal(f.songPractice.offset, 0);
});

test('conversion errors and unsupported formats are visible without creating an object URL', () => {
  const f = fixture();
  f.choose('broken.ncm');
  f.workers[0].onmessage({ data: { error: 'bad file' } });
  assert.match(f.songPractice.audioError, /bad file/);
  assert.equal(f.songPractice.objectURL, null);
  f.choose('unsupported.ncm');
  f.audio.canPlayType = () => '';
  f.workers[1].onmessage({ data: { buffer: new ArrayBuffer(1), offset: 0, mime: 'audio/ogg', format: 'Ogg' } });
  assert.match(f.songPractice.audioError, /不支持/);
  assert.equal(f.urls.length, 0);
});

test('worker failure is surfaced and cancels conversion', () => {
  const f = fixture();
  f.choose('file.ncm');
  f.workers[0].onerror();
  assert.match(f.songPractice.audioError, /无法运行/);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.context.ncmWorker, null);
});
