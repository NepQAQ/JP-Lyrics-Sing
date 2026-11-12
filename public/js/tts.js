// 日语朗读（移植自原项目）：中国区优先（百度/有道）→ VOICEVOX → Google → 浏览器 ja-JP 语音兜底
import { state } from './state.js';
import { setStatus } from './util.js';

const AUDIO_RATE = 0.9;
const BROWSER_RATE = 0.8;

export const VOICES = {
  'cn-default': { label: '中国区优先（百度/有道，失败后自动兜底）', preferChina: true, voicevoxSpeaker: '13' },
  'voicevox-13': { label: '低沉男声（VOICEVOX 青山龍星）', voicevoxSpeaker: '13' },
  'voicevox-11': { label: '男声（VOICEVOX 玄野武宏）', voicevoxSpeaker: '11' },
  'voicevox-8': { label: '清亮女声（VOICEVOX 春日部つむぎ）', voicevoxSpeaker: '8' },
  'voicevox-2': { label: '女声（VOICEVOX 四国めたん）', voicevoxSpeaker: '2' },
  'voicevox-3': { label: '可爱声线（VOICEVOX ずんだもん）', voicevoxSpeaker: '3' },
  'browser-ja': { label: '系统日语语音（ja-JP）', browserOnly: true },
};

let runId = 0;
let currentAudio = null;
const cache = new Map();

const choice = () => VOICES[state.settings.voice] || VOICES['cn-default'];

export function splitSentences(text) {
  return String(text || '')
    .split(/\r?\n+/)
    .flatMap(line => (line.trim().match(/[^。！？!?]+[。！？!?]?/g) || [line]))
    .map(s => s.trim())
    .filter(Boolean);
}

function chunks(text, max = 120) {
  const out = [];
  let cur = '';
  for (const part of splitSentences(text)) {
    if ((cur + part).length > max && cur) { out.push(cur); cur = ''; }
    if (part.length > max) {
      for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
      continue;
    }
    cur += (cur && !/[。！？!?]$/.test(cur) ? '。' : '') + part;
  }
  if (cur) out.push(cur);
  return out;
}

async function voicevox(text, speaker) {
  const key = `${speaker}:${text}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const url = new URL('https://api.tts.quest/v3/voicevox/synthesis');
    url.searchParams.set('speaker', speaker);
    url.searchParams.set('text', text);
    const r = await fetch(url, { credentials: 'omit' });
    const d = await r.json();
    const audioUrl = d?.mp3StreamingUrl || d?.mp3DownloadUrl || d?.wavDownloadUrl;
    if (!d?.success || !audioUrl) return null;
    const p = { name: 'VOICEVOX', url: audioUrl };
    cache.set(key, p);
    return p;
  } catch {
    return null;
  }
}

async function providers(text) {
  const c = choice();
  if (c.browserOnly) return [];
  const q = encodeURIComponent(text);
  const china = [
    { name: '百度', url: `https://fanyi.baidu.com/gettts?lan=jp&text=${q}&spd=4&source=web` },
    { name: '有道', url: `https://dict.youdao.com/dictvoice?audio=${q}&le=jap` },
  ];
  const list = [];
  if (c.preferChina) list.push(...china);
  if (c.voicevoxSpeaker) {
    const v = await voicevox(text, c.voicevoxSpeaker);
    if (v) list.push(v);
  }
  if (!c.preferChina) list.push(...china);
  list.push({ name: 'Google', url: `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=${q}` });
  return list;
}

function playUrl(url, id) {
  return new Promise((resolve, reject) => {
    if (id !== runId) { reject(new Error('cancel')); return; }
    const a = new Audio(url);
    currentAudio = a;
    a.playbackRate = AUDIO_RATE;
    a.onended = resolve;
    a.onerror = () => reject(new Error('unavailable'));
    a.play().catch(reject);
  });
}

function speakBrowser(text, id) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) { reject(new Error('浏览器不支持朗读')); return; }
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => /^ja[-_]/i.test(v.lang)) || voices.find(v => /japanese|日本/i.test(v.name));
    if (id !== runId) { reject(new Error('cancel')); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = BROWSER_RATE;
    if (voice) u.voice = voice;
    u.onend = resolve;
    u.onerror = () => reject(new Error('浏览器朗读失败'));
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

export function stopSpeech() {
  runId++;
  window.speechSynthesis?.cancel?.();
  if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
}

export async function speak(text, { onStatus = (m, e) => setStatus(m, { error: e }) } = {}) {
  const src = String(text || '').trim();
  if (!src) return;
  stopSpeech();
  const id = runId;
  for (const chunk of chunks(src)) {
    if (id !== runId) return;
    let ok = false;
    for (const p of await providers(chunk)) {
      try {
        onStatus(`朗读中：${p.name}`);
        await playUrl(p.url, id);
        ok = true;
        break;
      } catch {
        if (id !== runId) return;
      }
    }
    if (!ok) {
      try { await speakBrowser(chunk, id); } catch (e) {
        if (id !== runId) return;
        onStatus('朗读失败：在线语音与浏览器日语语音都不可用', true);
        return;
      }
    }
  }
  if (id === runId) onStatus('');
}
