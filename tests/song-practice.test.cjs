const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return source.slice(first, last);
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: value => values.has(value),
    toggle(value, enabled) {
      if (enabled === undefined) enabled = !values.has(value);
      if (enabled) values.add(value);
      else values.delete(value);
    },
  };
}

class Element extends EventTarget {
  constructor() {
    super();
    this.classList = classList();
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.attributes = {};
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() {}
}

function fixture() {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const body = { classList: classList(['mode-read']) };
  const audio = Object.assign(new EventTarget(), {
    duration: 20, currentTime: 0, playbackRate: 1, loop: false,
    paused: true, ended: false, seeking: false, error: null, readyState: 4, src: 'blob:test',
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  const songPractice = {
    initialized: true, enabled: true, timeline: 'synced', audioReady: true,
    audioError: '', objectURL: 'blob:test', offset: 0,
    active: null, raf: null, endTimer: null, notice: null,
  };
  const timers = new Map();
  const frames = new Map();
  let nextId = 0;
  const context = vm.createContext({
    $, audio, songPractice, document: { body }, window: new EventTarget(),
    URL: { revokeObjectURL() {} }, player: { mode: 'audio' },
    lrcLines: [], lyricLoadRequestId: 0, marumaruSearchRequestId: 0, renderGeneration: 0,
    lyricTextTimeline: null,
    stopStudySpeech() { context.speechStops++; },
    speechStops: 0, setStatus() {},
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  $('#song-practice-rate').value = '1';
  vm.runInContext(section('function parseLRC(', '/* ---------------- Translation'), context);
  vm.runInContext(section('/* ---------------- Optional reading-mode song practice', '/* Audio element timeupdate'), context);
  function setLines(text) {
    context.lrcLines = context.parseLRC(text).map(line => {
      const button = new Element();
      return { ...line, el: { classList: classList(), querySelector: () => button }, button };
    });
    context.updateSongPracticeUI();
  }
  setLines('[00:02]first\n[00:05]second\n[00:09]last');
  return { context, $, audio, songPractice, setLines, timers, frames, body };
}

const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

test('off by default in HTML and no row space/buttons when disabled', () => {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html.match(/<input[^>]*id="enable-song-practice"[^>]*>/)[0], /checked/);
  const f = fixture();
  f.songPractice.enabled = false;
  f.context.updateSongPracticeUI();
  assert.equal(f.$('#song-practice').hidden, true);
  for (const line of f.context.lrcLines) {
    assert.equal(line.button.hidden, true);
    assert.equal(line.el.classList.contains('has-song-practice'), false);
  }
});

test('enabling requires decoded audio, synced timeline, reading mode and local source', () => {
  for (const change of [
    f => { f.songPractice.audioReady = false; },
    f => { f.songPractice.timeline = 'synthetic'; },
    f => { f.songPractice.timeline = 'unknown'; },
    f => { f.context.player.mode = 'timer'; },
    f => { f.context.player.mode = 'yt'; },
    f => { f.body.classList.toggle('mode-read', false); },
    f => { f.body.classList.toggle('app-study', true); },
    f => { f.audio.error = new Error('decode'); },
  ]) {
    const f = fixture();
    change(f);
    f.context.updateSongPracticeUI();
    assert.equal(f.context.isSongPracticeReady(), false);
    assert.ok(f.context.lrcLines.every(line => line.button.hidden));
  }
});

test('duplicate stamps share original interval and blank tags delimit interludes', () => {
  const f = fixture();
  f.setLines('[00:02]first\n[00:02]duplicate\n[00:04]\n[00:08]last\n[00:12]');
  assert.equal(f.context.lrcLines.length, 3);
  assert.equal(f.context.lrcLines[1].time, 2.05);
  assert.deepEqual(plain(f.context.getSongPracticeRange(f.context.lrcLines, 0, 20, 0)), { start: 2, end: 4 });
  assert.deepEqual(plain(f.context.getSongPracticeRange(f.context.lrcLines, 1, 20, 0)), { start: 2, end: 4 });
  assert.deepEqual(plain(f.context.getSongPracticeRange(f.context.lrcLines, 2, 20, 0)), { start: 8, end: 12 });
});

test('last line, provider end, positive/negative offset, clipping and invalid ranges', () => {
  const { context: c } = fixture();
  const range = (lines, index = 0, duration = 20, offset = 0) => plain(c.getSongPracticeRange(lines, index, duration, offset));
  assert.deepEqual(range([{ time: 12, text: 'last' }]), { start: 12, end: 20 });
  assert.deepEqual(range([{ time: 12, text: 'last' }], 0, 20, 1), { start: 13, end: 20 });
  assert.deepEqual(range([{ time: 2, practiceEnd: 5, text: 'line' }], 0, 20, -3), { start: 0, end: 2 });
  assert.deepEqual(range([{ time: 2, practiceEnd: 30, text: 'line' }]), { start: 2, end: 20 });
  for (const lines of [
    [{ time: 20, text: 'out' }], [{ time: -1, text: 'bad' }],
    [{ time: NaN, text: 'bad' }], [{ time: 2, text: '' }],
  ]) assert.equal(range(lines), null);
  assert.equal(range([{ time: 2, practiceEnd: 5, text: 'early' }], 0, 20, -10), null);
  assert.equal(range([{ time: 2, text: 'bad duration' }], 0, Infinity), null);
  assert.equal(range([{ time: 2, text: 'bad offset' }], 0, 20, NaN), null);
});

test('single sentence stops at boundary and restores original rate/loop', async () => {
  const f = fixture();
  f.audio.playbackRate = 1.1;
  f.audio.loop = true;
  f.$('#song-practice-rate').value = '0.75';
  f.context.startSongPractice(0);
  await flush();
  assert.equal(f.audio.currentTime, 2);
  assert.equal(f.audio.playbackRate, 0.75);
  assert.equal(f.audio.loop, false);
  assert.equal(f.audio.paused, false);
  assert.equal(f.context.speechStops, 1);
  f.audio.currentTime = 5;
  f.audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(f.songPractice.active, null);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.playbackRate, 1.1);
  assert.equal(f.audio.loop, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
});

test('loop seeks the same sentence; last-line ended loops or stops', async () => {
  const f = fixture();
  f.$('#song-practice-loop').checked = true;
  f.context.startSongPractice(2);
  await flush();
  const active = f.songPractice.active;
  f.audio.currentTime = 20;
  f.audio.ended = true;
  f.audio.dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(f.audio.currentTime, 9);
  assert.equal(f.songPractice.active, active);
  f.$('#song-practice-loop').checked = false;
  f.audio.currentTime = 20;
  f.audio.dispatchEvent(new Event('ended'));
  assert.equal(f.songPractice.active, null);
  assert.equal(f.audio.paused, true);
});

test('speed reschedules sentence deadline and offset edits cancel the old loop', async () => {
  const f = fixture();
  f.context.startSongPractice(0);
  await flush();
  f.$('#song-practice-rate').value = '0.5';
  f.$('#song-practice-rate').dispatchEvent(new Event('change'));
  assert.equal(f.audio.playbackRate, 0.5);
  assert.equal([...f.timers.values()][0].delay, 6000);
  f.$('#song-practice-offset').valueAsNumber = 1;
  f.$('#song-practice-offset').dispatchEvent(new Event('input'));
  assert.equal(f.songPractice.active, null);
  assert.equal(f.songPractice.offset, 1);
  f.context.startSongPractice(0);
  assert.equal(f.audio.currentTime, 3);
  assert.equal(f.songPractice.active.end, 6);
  f.$('#song-practice-offset').valueAsNumber = NaN;
  f.$('#song-practice-offset').dispatchEvent(new Event('input'));
  assert.equal(f.songPractice.active, null);
  assert.equal(f.$('#song-practice-status').classList.contains('error'), true);
});

test('deadline fallback stops a sentence without animation frames', async () => {
  const f = fixture();
  f.context.startSongPractice(0);
  await flush();
  const deadline = [...f.timers.values()][0];
  assert.equal(deadline.delay, 3000);
  f.audio.currentTime = 5.01;
  deadline.callback();
  assert.equal(f.songPractice.active, null);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.currentTime, 5);
});

test('internal seeks survive, native seeks cancel without pausing regular playback', async () => {
  const f = fixture();
  f.context.startSongPractice(0);
  await flush();
  f.audio.dispatchEvent(new Event('seeking'));
  assert.ok(f.songPractice.active);
  f.audio.dispatchEvent(new Event('seeked'));
  f.audio.currentTime = 3;
  f.audio.dispatchEvent(new Event('seeking'));
  assert.equal(f.songPractice.active, null);
  assert.equal(f.audio.paused, false);
  assert.equal(f.timers.size, 0);
});

test('native pause, lyric changes, decode errors, hiding and toggle-off cancel practice', async () => {
  for (const action of [
    f => { f.audio.paused = true; f.audio.dispatchEvent(new Event('pause')); },
    f => f.context.beginLyricLoad(),
    f => { f.audio.error = new Error('decode'); f.audio.dispatchEvent(new Event('error')); },
    f => f.$('#song-practice-hide').dispatchEvent(new Event('click')),
    f => { f.$('#enable-song-practice').checked = false; f.$('#enable-song-practice').dispatchEvent(new Event('change')); },
  ]) {
    const f = fixture();
    f.context.startSongPractice(0);
    await flush();
    action(f);
    assert.equal(f.songPractice.active, null);
    assert.equal(f.audio.paused, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.frames.size, 0);
  }
});

test('play failure is visible; stale failures cannot stop a newer sentence', async () => {
  const f = fixture();
  let rejectOld;
  f.audio.play = () => new Promise((resolve, reject) => { rejectOld = reject; });
  f.context.startSongPractice(0);
  f.audio.play = () => { f.audio.paused = false; return Promise.resolve(); };
  f.context.startSongPractice(1);
  rejectOld(new Error('old rejection'));
  await flush();
  assert.equal(f.songPractice.active.index, 1);
  assert.equal(f.songPractice.notice, null);
  f.context.stopSongPractice();
  f.audio.play = () => Promise.reject(new Error('NotAllowedError'));
  f.context.startSongPractice(0);
  await flush();
  assert.equal(f.songPractice.active, null);
  assert.match(f.$('#song-practice-status').textContent, /NotAllowedError/);
  assert.equal(f.$('#song-practice-status').classList.contains('error'), true);
});

test('TTS cancels practice and obsolete providers cannot interrupt the next song sentence', async () => {
  const f = fixture();
  const c = f.context;
  let finishProviders;
  Object.assign(c, {
    studySpeechRunId: 0, studySpeechAudio: null,
    buildJapaneseTtsChunks: text => [text],
    getJapaneseTtsProviders: () => new Promise(resolve => { finishProviders = resolve; }),
    playStudyAudio: async () => { throw new Error('Obsolete TTS must not start'); },
    setStudyStatus() {},
  });
  vm.runInContext(section('function stopStudySpeech(', 'function buildJapaneseTtsChunks('), c);
  vm.runInContext(section('async function speakJapanese(text)', 'initStudyVoiceSelect();'), c);
  c.startSongPractice(0);
  await flush();
  const oldSpeech = c.speakJapanese('test');
  assert.equal(f.songPractice.active, null);
  assert.equal(f.audio.paused, true);
  c.startSongPractice(1);
  finishProviders([{ url: 'old', name: 'old' }]);
  await oldSpeech;
  assert.equal(f.songPractice.active.index, 1);
  c.stopSongPractice();
  f.songPractice.enabled = false;
  f.audio.paused = false;
  const ordinarySpeech = c.speakJapanese('original behavior');
  assert.equal(f.audio.paused, false);
  c.stopStudySpeech();
  finishProviders([]);
  await ordinarySpeech;
});

function loaderFixture() {
  const f = fixture();
  const c = f.context;
  Object.assign(c, {
    searchResults: {}, searchInput: { value: '' }, lyricsCache: {}, LYRICS_CACHE_MAX: 30,
    lyricsCacheKey: () => 'test', persistLyricsCache() {}, setSearchHistoryOpen() {},
    setPanelCollapsed() {}, resetAssistActions() {}, startAssistActionsForLyric() {},
    prefetchMarumaruCandidatesForLyric: async () => {}, fetchPetitLyricsWordTiming: async () => null,
    switchToTimerMode() { c.player.mode = 'timer'; c.stopSongPractice(); },
    async renderLyrics(parsed, options) {
      c.rendered = { parsed, ...options };
      c.songPractice.timeline = options.timeline;
      c.lrcLines = parsed.map(line => ({
        ...line, el: { classList: classList(), querySelector: () => new Element() },
      }));
    },
  });
  for (const [start, end] of [
    ['async function loadLrcFromText(', '/* ---------------- Online search'],
    ['function saveLyricsToCache(', 'function cacheMatchesQuery('],
    ['async function loadFromCache(', 'function getCacheEntries('],
    ['function buildLrcFromParsed(', 'let lastSearch ='],
    ['function buildFakeLrcFromPlainText(', '/* ---------------- PetitLyrics'],
    ['async function loadFromLrclib(', '/* ---------------- YouTube'],
  ]) vm.runInContext(section(start, end), c);
  return f;
}

test('all LRC/LRCLIB/cache entrances retain genuine versus synthetic provenance', async () => {
  const f = loaderFixture();
  const c = f.context;
  const synced = '[00:02]first\n[00:05]last';
  await c.loadLrcFromText(synced);
  assert.equal(c.rendered.timeline, 'synced');
  await c.loadFromLrclib({ trackName: 'plain', plainLyrics: 'first\nlast' });
  await flush();
  assert.equal(c.rendered.timeline, 'synthetic');
  assert.equal(c.lyricsCache.test.timeline, 'synthetic');
  const generated = f.$('#lrc-text').value;
  await c.loadLrcFromText(generated);
  assert.equal(c.rendered.timeline, 'synthetic');
  await c.loadLrcFromText(generated + '\n');
  assert.equal(c.rendered.timeline, 'synthetic');
  await c.loadFromCache(c.lyricsCache.test);
  assert.equal(c.rendered.timeline, 'synthetic');
  await c.loadFromCache({ lrc: synced, lines: [{ time: 2, text: 'first' }] });
  assert.equal(c.rendered.timeline, 'unknown');
  await c.loadLrcFromText(synced);
  assert.equal(c.rendered.timeline, 'unknown');
  await c.loadFromLrclib({ trackName: 'sync', syncedLyrics: synced });
  await flush();
  assert.equal(c.rendered.timeline, 'synced');
  assert.equal(c.lyricsCache.test.timeline, 'synced');
  await c.loadFromCache(c.lyricsCache.test);
  assert.equal(c.rendered.timeline, 'synced');
  assert.equal(c.rendered.parsed[0].practiceTime, 2);
  assert.equal(c.rendered.parsed[0].practiceEnd, 5);
});

test('NetEase uses supplied timestamps/ends and ignores an obsolete fetch response', async () => {
  const f = loaderFixture();
  const c = f.context;
  c.fetchProxyJson = async () => ({ lines: [{ time: 2, duration: 2, text: 'first' }] });
  await c.loadFromNetease({ id: 1, title: 'sync' });
  assert.equal(c.rendered.timeline, 'synced');
  assert.equal(c.rendered.parsed[0].practiceEnd, 4);
  let finish;
  c.fetchProxyJson = () => new Promise(resolve => { finish = resolve; });
  const obsolete = c.loadFromNetease({ id: 2, title: 'old' });
  await c.loadLrcFromText('[00:03]new', 'synced');
  finish({ lines: [{ time: 1, text: 'old' }] });
  await obsolete;
  assert.equal(c.rendered.parsed[0].text, 'new');
});

test('standalone Marumaru is synthetic and preserves that status on reload', async () => {
  const f = loaderFixture();
  const c = f.context;
  c.lrcLines = [];
  Object.assign(c, {
    fetchMarumaruLyric: async () => ({}),
    marumaruParseLyricData: () => ({ lines: [{ text: 'first', jpHTML: 'first' }], pairs: {} }),
    mergeOverridesFromPairs: () => 0,
  });
  vm.runInContext(section('function buildTimedLinesFromMarumaru(', 'async function applyMarumaruToCurrentLyrics('), c);
  vm.runInContext(section('async function loadFromMarumaru(', '/* ---------------- Init:'), c);
  await c.loadFromMarumaru({ title: 'plain' });
  assert.equal(c.rendered.timeline, 'synthetic');
  await c.loadLrcFromText(f.$('#lrc-text').value);
  assert.equal(c.rendered.timeline, 'synthetic');
});
