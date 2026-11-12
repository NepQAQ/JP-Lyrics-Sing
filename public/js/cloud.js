// 云同步引擎：登录后拉取合并（逐曲 LWW）、防抖推送（约 3 秒）、
// 音频上传一次 / 下载缓存进 IndexedDB、同步状态指示。
// 在 api.js 本地层之上包装；未登录 / 未配置时完全静默。
// UI 刷新经 bus 事件交给 main.js（cloud:songs-applied / cloud:config-applied / cloud:dict-applied）。
import { $, bus, toast } from './util.js';
import { api, proxyBase } from './api.js';
import { authFetch, authToken, authUser, isLoggedIn } from './auth.js';

const PUSH_DEBOUNCE_MS = 3000;
const RETRY_DELAY_MS = 30000;
const AUDIO_SIG_PREFIX = 'jls-cloud-audio-sig';
const BACKLOG_DECLINED_PREFIX = 'jls-cloud-backlog-declined';

let cloudStatus = null; // { dataverse, auth, sharepoint } | null
let statusPromise = null;
let pulling = false;
let pushing = false;
let applyingRemote = false; // 拉取应用期间吞掉 local:dirty，避免推送回环
let lastError = null;
let pushTimer = null;
let retryTimer = null;
const pushQueue = new Map(); // key → { type, id? }

// =============================================================== 纯函数（node --test 可测）

/**
 * 逐曲双向 LWW：
 * - toPull：远端较新或本地不存在的歌曲（需拉取写入本地）
 * - toPush：本地较新或云端不存在的歌曲 id（需上传云端）
 */
export function mergeSongs(localSongs, remoteSongs) {
  const toPull = [];
  const toPush = [];
  const remoteById = new Map();
  for (const r of remoteSongs || []) {
    if (r?.songId) remoteById.set(r.songId, r);
  }
  const localById = new Map();
  for (const l of localSongs || []) {
    if (l?.id) localById.set(l.id, l);
  }
  for (const [id, remote] of remoteById) {
    const local = localById.get(id);
    if (!local) {
      toPull.push(remote);
      continue;
    }
    const rTs = Number(remote.updatedAt) || 0;
    const lTs = Number(local.updatedAt) || 0;
    if (rTs > lTs) toPull.push(remote);
    else if (lTs > rTs) toPush.push(id);
  }
  for (const id of localById.keys()) {
    if (!remoteById.has(id)) toPush.push(id);
  }
  return { toPull, toPush };
}

/** 词典逐条 LWW 合并（按 updatedAt 取较新；本地独有条目保留）。 */
export function mergeDictionary(localDict, remoteDict) {
  const out = { ...(localDict || {}) };
  for (const [surface, remote] of Object.entries(remoteDict || {})) {
    if (!remote || typeof remote !== 'object') continue;
    const local = out[surface];
    if (!local) {
      out[surface] = remote;
      continue;
    }
    const rTs = Number(remote.updatedAt) || 0;
    const lTs = Number(local.updatedAt) || 0;
    if (rTs > lTs) out[surface] = remote;
  }
  return out;
}

/**
 * 配置合并：云端值覆盖本地同名键（登录拉取语义）。
 * cloudSync 是设备级开关，不参与云端合并。
 */
export function mergeConfig(localConfig, remoteConfig) {
  const out = { ...(localConfig || {}) };
  for (const [k, v] of Object.entries(remoteConfig || {})) {
    if (k === 'cloudSync') continue;
    out[k] = v;
  }
  return out;
}

export function parseJsonSafe(text) {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 音频签名（size:mime:name）——「上传一次」语义的指纹；无音频返回 null。 */
export function audioSig(song) {
  const a = song?.audio;
  return a ? `${a.size}:${a.mime}:${a.name}` : null;
}

/**
 * 需要补传音频的歌曲 id：有音频元数据且签名缺失或变化。
 * sharepoint 未配置期间 syncAudioForSong 不记录签名，因此配置翻转后
 * 全部本地音频都会出现在这里——「立即同步」/登录自动补传，无需清缓存。
 */
export function songsNeedingAudioUpload(songs, sigs) {
  const out = [];
  for (const song of songs || []) {
    if (!song?.id) continue;
    const sig = audioSig(song);
    if (sig && sigs?.[song.id] !== sig) out.push(song.id);
  }
  return out;
}

// =============================================================== 初始化

export function init() {
  fetchStatus();

  bus.on('auth:changed', ({ user }) => {
    pushQueue.clear();
    lastError = null;
    if (user) {
      // 登录时刷新云端状态（捕获会话期间 sharepoint 配置翻转），拉取合并后补传本地音频
      fetchStatus()
        .then(() => pullAndMerge())
        .then(() => uploadMissingAudio())
        .catch(() => {});
    } else {
      updateStatusUI();
    }
  });

  bus.on('local:dirty', (event) => {
    if (applyingRemote) return;
    schedulePush(event);
  });

  bus.on('cloud:sync-now', () => {
    if (!isLoggedIn()) return;
    (async () => {
      // 先刷新云端状态：部署后 sharepoint 翻转在此生效（失败保留已知状态）
      await fetchStatus();
      await flushPushes().catch(() => {});
      await pullAndMerge().catch(() => {});
      const downloaded = await downloadMissingAudio().catch(() => 0);
      const uploaded = await uploadMissingAudio().catch(() => 0);
      if (downloaded || uploaded) {
        const parts = [];
        if (downloaded) parts.push(`下载 ${downloaded} 个音频`);
        if (uploaded) parts.push(`上传 ${uploaded} 个音频`);
        toast(`云同步完成：${parts.join('、')}`);
      }
    })();
  });

  // 页面隐藏 / 卸载前冲刷待推送内容
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pushQueue.size) flushPushes().catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    if (pushQueue.size) flushPushes().catch(() => {});
  });
}

function fetchStatus() {
  statusPromise = fetch(proxyBase() + '/api/cloud/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      // 仅成功响应覆盖已知状态；失败/无效响应保留旧值（首次加载失败则保持 null = 未配置），
      // 避免离线时把已知配置清空导致「立即同步」静默无动作
      if (data?.cloud) cloudStatus = data.cloud;
      return cloudStatus;
    })
    .catch(() => cloudStatus)
    .then((status) => {
      bus.emit('cloud:status', status);
      updateStatusUI();
      return status;
    });
  return statusPromise;
}

async function ensureStatus() {
  if (!statusPromise) fetchStatus();
  try {
    await statusPromise;
  } catch {
    // 状态获取失败按未配置处理
  }
  return cloudStatus;
}

// =============================================================== 拉取合并

async function pullAndMerge() {
  if (pulling || !isLoggedIn()) return;
  pulling = true;
  updateStatusUI();
  try {
    const status = await ensureStatus();
    if (!status?.dataverse) return;

    const [userData, list, localSongs] = await Promise.all([
      authFetch('/api/cloud/user-data'),
      authFetch('/api/cloud/songs'),
      api.rawSongs(),
    ]);
    const remoteSongs = list.songs || [];
    const remoteConfig = parseJsonSafe(userData.configJson);
    const remoteDict = parseJsonSafe(userData.dictionaryJson);
    const cloudEmpty = !remoteSongs.length && remoteConfig === null && remoteDict === null;

    const { toPull, toPush } = mergeSongs(localSongs, remoteSongs);

    if (cloudEmpty && toPush.length) {
      // 首次登录且云端为空：提供「上传本地数据到云端」流程
      const declinedKey = `${BACKLOG_DECLINED_PREFIX}:${authUser()?.id}`;
      let declined = false;
      try {
        declined = localStorage.getItem(declinedKey) === '1';
      } catch {}
      if (!declined && (await confirmUploadBacklog(toPush.length))) {
        await pushUserData();
        for (const id of toPush) await pushSong(id);
        toast(`已上传 ${toPush.length} 首歌曲到云端`);
      } else {
        try {
          localStorage.setItem(declinedKey, '1');
        } catch {}
      }
    } else {
      await applyRemoteUserData(remoteConfig, remoteDict);
      const appliedIds = await applyRemoteSongs(toPull);
      for (const id of toPush) await pushSong(id);
      if (appliedIds.length) {
        bus.emit('cloud:songs-applied', { ids: appliedIds });
        toast(`已从云端同步 ${appliedIds.length} 首歌曲`);
      }
    }
    lastError = null;
  } catch (err) {
    lastError = err;
    toast(`云同步拉取失败：${err.message || err}`, { error: true });
  } finally {
    pulling = false;
    updateStatusUI();
  }
}

/** 应用云端配置与词典（写本地不触发推送回环）。 */
async function applyRemoteUserData(remoteConfig, remoteDict) {
  if (remoteConfig && typeof remoteConfig === 'object' && Object.keys(remoteConfig).length) {
    const local = await api.settings();
    const merged = mergeConfig(local, remoteConfig);
    applyingRemote = true;
    try {
      await api.saveSettings(merged); // local:dirty 被吞掉
    } finally {
      applyingRemote = false;
    }
    bus.emit('cloud:config-applied', { config: merged });
  }
  if (remoteDict && typeof remoteDict === 'object' && Object.keys(remoteDict).length) {
    const local = await api.dictionary();
    const merged = mergeDictionary(local, remoteDict);
    applyingRemote = true;
    try {
      await api.putDictionaryRaw(merged);
    } finally {
      applyingRemote = false;
    }
    bus.emit('cloud:dict-applied', { dict: merged });
  }
}

/** 拉取整曲（含 lyric_json）写入本地；返回实际应用的 id 列表。 */
async function applyRemoteSongs(remoteSongs) {
  const applied = [];
  for (const remote of remoteSongs) {
    let full;
    try {
      full = await authFetch(`/api/cloud/songs/${encodeURIComponent(remote.songId)}`);
    } catch (err) {
      if (err.status === 404) continue; // 云端行已被删除
      throw err;
    }
    const record = parseJsonSafe(full.lyricJson);
    if (!record || typeof record !== 'object') continue;
    const song = { ...record, id: remote.songId };
    song.updatedAt = Number(full.updatedAt) || Number(record.updatedAt) || Date.now();
    await api.putSongRaw(song);
    applied.push(remote.songId);

    // 音频：本地缺失且云端有 → 下载缓存（失败不阻断歌词同步）
    if (song.audio && cloudStatus?.sharepoint) {
      const existing = await api.getAudioBlob(remote.songId);
      if (!existing) {
        try {
          const blob = await downloadAudio(remote.songId, song.audio.mime);
          if (blob) {
            await api.putAudioRaw(remote.songId, blob, song.audio.mime, song.audio.size, song.audio.name);
          }
        } catch {
          // 音频下载失败，下次「立即同步」会重试
        }
      }
    }
  }
  return applied;
}

/** 补齐本地缺失的音频缓存（「立即同步」时调用）。 */
async function downloadMissingAudio() {
  if (!isLoggedIn() || !cloudStatus?.sharepoint) return 0;
  const songs = await api.rawSongs();
  let count = 0;
  for (const song of songs) {
    if (!song.audio) continue;
    const existing = await api.getAudioBlob(song.id);
    if (existing) continue;
    try {
      const blob = await downloadAudio(song.id, song.audio.mime);
      if (blob) {
        await api.putAudioRaw(song.id, blob, song.audio.mime, song.audio.size, song.audio.name);
        count++;
      }
    } catch {
      // 单曲失败跳过
    }
  }
  return count;
}

/**
 * 补传本地音频：sharepoint 配置后（含会话期间状态翻转）扫描签名缺失/变化的
 * 歌曲自动上传。未配置期间不记录签名，翻转后此处把全部本地音频补传一遍；
 * 已上传的（签名一致）自动跳过，维持「上传一次」语义。
 */
async function uploadMissingAudio() {
  if (!isLoggedIn() || !cloudStatus?.sharepoint) return 0;
  const songs = await api.rawSongs();
  const ids = songsNeedingAudioUpload(songs, loadAudioSigs());
  const byId = new Map((songs || []).filter((s) => s?.id).map((s) => [s.id, s]));
  let count = 0;
  for (const id of ids) {
    const song = byId.get(id);
    const record = await api.getAudioBlob(id);
    if (!record?.blob) continue; // 本地无音频数据（仅元数据），跳过
    try {
      await putCloudAudio(id, record.blob, song.audio.mime);
      const sigs = loadAudioSigs();
      sigs[id] = audioSig(song);
      saveAudioSigs(sigs);
      count++;
    } catch {
      // 单曲失败跳过，下次「立即同步」重试
    }
  }
  return count;
}

// =============================================================== 推送

function schedulePush(event) {
  if (!isLoggedIn()) return;
  const type = event?.type;
  if (!type) return;
  const key = type === 'song' ? `song:${event.id}` : type === 'song-delete' ? `del:${event.id}` : type;
  if (type === 'song' && pushQueue.has(`del:${event.id}`)) return; // 已删除，跳过过期编辑
  pushQueue.set(key, { type, id: event.id });
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    flushPushes().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
}

async function flushPushes() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (pushing || !pushQueue.size) return;
  if (!isLoggedIn()) {
    pushQueue.clear();
    return;
  }
  const settings = await api.settings();
  if (settings.cloudSync === false) {
    pushQueue.clear();
    return;
  }
  const status = await ensureStatus();
  if (!status?.dataverse) {
    pushQueue.clear();
    return;
  }

  pushing = true;
  updateStatusUI();
  const batch = [...pushQueue.values()];
  pushQueue.clear();
  try {
    // settings / dictionary 共用一行 user-data，合并为一次推送
    if (batch.some((e) => e.type === 'settings' || e.type === 'dictionary')) {
      await pushUserData();
    }
    for (const event of batch) {
      if (event.type === 'song') await pushSong(event.id);
      else if (event.type === 'song-delete') await pushSongDelete(event.id);
    }
    lastError = null;
    updateStatusUI();
  } catch (err) {
    lastError = err;
    updateStatusUI();
    retryLater(batch);
  } finally {
    pushing = false;
    updateStatusUI();
  }
}

function retryLater(batch) {
  for (const event of batch) {
    const key = event.type === 'song' ? `song:${event.id}` : event.type === 'song-delete' ? `del:${event.id}` : event.type;
    if (!pushQueue.has(key)) pushQueue.set(key, event);
  }
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushPushes().catch(() => {});
  }, RETRY_DELAY_MS);
}

async function pushUserData() {
  const [config, dict] = await Promise.all([api.settings(), api.dictionary()]);
  await authFetch('/api/cloud/user-data', {
    method: 'PUT',
    body: {
      configJson: JSON.stringify(config),
      dictionaryJson: JSON.stringify(dict),
    },
  });
}

async function pushSong(id) {
  const song = await api.rawSong(id);
  if (!song) return; // 本地已删除，交给 song-delete 事件
  const uid = authUser()?.id;

  const badges = {
    album: song.album || '',
    source: song.source || '',
    sourceId: song.sourceId || '',
    duration: song.duration || 0,
    timeline: song.timeline || '',
    lyricSource: song.lyricSource || '',
    lineCount: (song.lines || []).length,
    createdAt: song.createdAt || null,
    lastOpenedAt: song.lastOpenedAt || null,
    audio: song.audio ? { mime: song.audio.mime, size: song.audio.size, name: song.audio.name } : null,
  };

  await authFetch(`/api/cloud/songs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: {
      title: song.title || '',
      artist: song.artist || '',
      badges: JSON.stringify(badges),
      lyricJson: JSON.stringify(song),
      updatedAt: song.updatedAt || Date.now(),
      audioPath: song.audio && uid ? `Songs/${uid}/${id}` : null,
    },
  });

  await syncAudioForSong(id, song);
}

/** 音频只上传一次：签名（size:mime:name）变化才重传；删除音频时清理云端。 */
async function syncAudioForSong(id, song) {
  const sigs = loadAudioSigs();
  const sig = audioSig(song);

  if (!sig) {
    // 本地已删除音频：若此前上传过，清理云端文件与签名
    if (sigs[id]) {
      delete sigs[id];
      saveAudioSigs(sigs);
      if (cloudStatus?.sharepoint) {
        try {
          await deleteCloudAudio(id);
        } catch {
          // 清理失败不影响主流程
        }
      }
    }
    return;
  }

  if (sigs[id] === sig || !cloudStatus?.sharepoint) return;
  const record = await api.getAudioBlob(id);
  if (!record?.blob) return; // 本地无音频数据（仅元数据），跳过
  await putCloudAudio(id, record.blob, song.audio.mime);
  sigs[id] = sig;
  saveAudioSigs(sigs);
}

async function pushSongDelete(id) {
  try {
    await authFetch(`/api/cloud/songs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status === 404) return; // 云端本就不存在
    throw err;
  }
  const sigs = loadAudioSigs();
  if (sigs[id]) {
    delete sigs[id];
    saveAudioSigs(sigs);
  }
}

// =============================================================== 音频传输

async function putCloudAudio(songId, blob, mime) {
  const url = `${proxyBase()}/api/cloud/audio?songId=${encodeURIComponent(songId)}&mime=${encodeURIComponent(mime || 'audio/mpeg')}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${authToken()}`,
      'Content-Type': mime || 'audio/mpeg',
    },
    body: blob,
  });
  await assertOk(response, '音频上传失败');
}

async function downloadAudio(songId, mime) {
  const url = `${proxyBase()}/api/cloud/audio?songId=${encodeURIComponent(songId)}&mime=${encodeURIComponent(mime || '')}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
  if (response.status === 404) return null; // 云端无此音频
  await assertOk(response, '音频下载失败');
  return await response.blob();
}

async function deleteCloudAudio(songId) {
  const url = `${proxyBase()}/api/cloud/audio?songId=${encodeURIComponent(songId)}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken()}` },
  });
  if (response.status === 404) return;
  await assertOk(response, '音频删除失败');
}

async function assertOk(response, fallback) {
  if (response.ok) return;
  const data = await response.json().catch(() => null);
  const err = new Error(data?.error?.message || `${fallback}（${response.status}）`);
  err.code = data?.error?.code || 'UNKNOWN';
  err.status = response.status;
  throw err;
}

// =============================================================== 音频签名（上传一次）

function loadAudioSigs() {
  const uid = authUser()?.id || 'anon';
  try {
    return JSON.parse(localStorage.getItem(`${AUDIO_SIG_PREFIX}:${uid}`) || '{}') || {};
  } catch {
    return {};
  }
}

function saveAudioSigs(map) {
  const uid = authUser()?.id || 'anon';
  try {
    localStorage.setItem(`${AUDIO_SIG_PREFIX}:${uid}`, JSON.stringify(map));
  } catch {
    // 存储失败时退化为每次都重传
  }
}

// =============================================================== 首次登录上传确认

function confirmUploadBacklog(count) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-cloud-upload');
    if (!dlg || typeof dlg.showModal !== 'function') {
      resolve(false);
      return;
    }
    const countEl = $('#cloud-upload-count');
    if (countEl) countEl.textContent = String(count);
    const ok = $('#cloud-upload-ok');
    const cancel = $('#cloud-upload-cancel');
    const cleanup = () => {
      ok?.removeEventListener('click', onOk);
      cancel?.removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
    };
    const done = (val) => {
      cleanup();
      try {
        if (dlg.open) dlg.close();
      } catch {}
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => done(false);
    ok?.addEventListener('click', onOk);
    cancel?.addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// =============================================================== 状态指示

function updateStatusUI() {
  const btn = $('#btn-cloud-status');
  const show = isLoggedIn() && Boolean(cloudStatus?.dataverse);
  if (btn) {
    btn.hidden = !show;
    if (show) {
      btn.classList.toggle('busy', pulling || pushing);
      btn.classList.toggle('error', Boolean(lastError));
      const audioNote = cloudStatus?.sharepoint ? '' : '；音频未配置云端存储，仅本地';
      if (lastError) btn.title = `云同步出错：${lastError.message || lastError}`;
      else if (pulling || pushing) btn.title = '云同步进行中…';
      else btn.title = `云同步已就绪${audioNote}`;
    }
  }
  const stateEl = $('#cloud-sync-state');
  if (stateEl) {
    if (!isLoggedIn()) {
      stateEl.textContent = '未登录，数据仅保存在本地';
    } else if (lastError) {
      stateEl.textContent = `同步出错：${lastError.message || lastError}`;
    } else if (pulling || pushing) {
      stateEl.textContent = '同步中…';
    } else {
      stateEl.textContent = cloudStatus?.sharepoint ? '已同步' : '已同步（音频仅本地）';
    }
  }
}

// =============================================================== 对外（调试 / 测试）

export function cloudState() {
  return {
    status: cloudStatus,
    pulling,
    pushing,
    pending: pushQueue.size,
    lastError: lastError ? String(lastError.message || lastError) : null,
  };
}

export function syncNow() {
  bus.emit('cloud:sync-now');
}
