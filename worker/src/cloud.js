// 云同步路由：自建账号（注册/登录/会话）+ 用户数据/歌词/音频的云端读写。
// 在 index.js 的代理逻辑之前分流，独立处理 CORS、方法与鉴权；
// 云端未配置时返回结构化错误，游客模式零影响。

import { ApiError, jsonResponse, errorResponse, corsHeaders, isAllowedOrigin, CLOUD_CORS } from './http.js';
import {
  createLoginLimiter,
  requireUser,
  clientIp,
  createPasswordRecord,
  verifyPassword,
  issueUserToken,
  assertJwtSecret,
} from './auth.js';
import {
  assertDataverseConfigured,
  assertLyricSize,
  dvQueryAll,
  dvQueryOne,
  dvCreate,
  dvUpdate,
  dvDelete,
  odataQuote,
} from './dataverse.js';
import { isSharePointConfigured, putAudio, getAudio, deleteAudio } from './graph.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024; // 歌词/配置 JSON（Dataverse 多行文本列上限 1MB + 余量）
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 原始二进制音频
const MAX_AUDIO_JSON_BYTES = 16 * 1024 * 1024; // base64 JSON 路径（解码后约 12MB，大文件请走二进制）

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 登录失败限速：用户名|IP，10 次 / 15 分钟（Worker 实例级内存 Map，尽力而为）
const loginLimiter = createLoginLimiter();
// 注册限速：仅按 IP，防止刷注册消耗 PBKDF2 CPU
const registerLimiter = createLoginLimiter();

// ---------------------------------------------------------------------------
// Dataverse 表结构命名（前缀默认 jls，可用 DATAVERSE_PREFIX 覆盖）
// ---------------------------------------------------------------------------

function schema(env) {
  const prefix = String(env?.DATAVERSE_PREFIX || 'jls').replace(/[^a-z0-9_]/gi, '') || 'jls';
  return {
    user: {
      table: `${prefix}_user`,
      set: `${prefix}_users`,
      id: `${prefix}_userid`,
      username: `${prefix}_username`,
      email: `${prefix}_email`,
      passwordHash: `${prefix}_password_hash`,
      salt: `${prefix}_salt`,
      iterations: `${prefix}_iterations`,
    },
    userData: {
      table: `${prefix}_user_data`,
      set: `${prefix}_user_datas`,
      id: `${prefix}_user_dataid`,
      // OData 导航属性名保留 Lookup SchemaName 的大小写（jls_Owner），
      // 绑定注解大小写敏感；过滤用的结构属性 _jls_owner_value 则是小写。
      ownerBind: `${prefix}_Owner`,
      ownerValue: `_${prefix}_owner_value`,
      configJson: `${prefix}_config_json`,
      dictionaryJson: `${prefix}_dictionary_json`,
      updatedAt: `${prefix}_updated_at`,
    },
    song: {
      table: `${prefix}_song`,
      set: `${prefix}_songs`,
      id: `${prefix}_songid`,
      songId: `${prefix}_song_id`,
      ownerBind: `${prefix}_Owner`,
      ownerValue: `_${prefix}_owner_value`,
      title: `${prefix}_title`,
      artist: `${prefix}_artist`,
      badges: `${prefix}_badges`,
      lyricJson: `${prefix}_lyric_json`,
      audioPath: `${prefix}_audio_path`,
      updatedAt: `${prefix}_updated_at`,
    },
  };
}

// ---------------------------------------------------------------------------
// 入口：判断与分发
// ---------------------------------------------------------------------------

export function isCloudPath(path) {
  return (
    path === '/api/auth/register' ||
    path === '/api/auth/login' ||
    path === '/api/auth/me' ||
    path === '/api/cloud' ||
    path.startsWith('/api/cloud/')
  );
}

export async function handleCloudApi(request, url, env, ctx) {
  const path = normalizePathLocal(url.pathname);

  // 云同步路由的来源策略：允许列表 + 同源（托管在同一 Worker 的前端 POST 会带同源 Origin）
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin, env) && !isSameOrigin(origin, url)) {
    return jsonResponse(
      { error: { code: 'ORIGIN_NOT_ALLOWED', message: '该来源未被允许访问云同步接口' } },
      { status: 403, request, env, cors: CLOUD_CORS }
    );
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env, CLOUD_CORS) });
  }

  try {
    return await route(request, url, env, ctx, path);
  } catch (error) {
    return errorResponse(error, request, env, { cors: CLOUD_CORS, internalMessage: '云同步服务暂时不可用' });
  }
}

async function route(request, url, env, ctx, path) {
  const method = request.method;

  if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, url, env);
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, url, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, url, env);

  if (path === '/api/cloud/status' && method === 'GET') return handleStatus(request, url, env);

  if (path === '/api/cloud/user-data') {
    if (method === 'GET') return handleGetUserData(request, url, env);
    if (method === 'PUT') return handlePutUserData(request, url, env);
  }

  if (path === '/api/cloud/songs') {
    if (method === 'GET') return handleListSongs(request, url, env);
  }

  const songMatch = /^\/api\/cloud\/songs\/(.+)$/.exec(path);
  if (songMatch) {
    const songId = decodeURIComponentSafe(songMatch[1]);
    if (method === 'GET') return handleGetSong(request, url, env, songId);
    if (method === 'PUT') return handlePutSong(request, url, env, songId);
    if (method === 'DELETE') return handleDeleteSong(request, url, env, songId);
  }

  if (path === '/api/cloud/audio') {
    if (method === 'PUT') return handlePutAudio(request, url, env);
    if (method === 'GET') return handleGetAudio(request, url, env);
    if (method === 'DELETE') return handleDeleteAudio(request, url, env);
  }

  throw new ApiError(404, 'NOT_FOUND', '云同步接口不存在');
}

// ---------------------------------------------------------------------------
// 认证：注册 / 登录 / 会话
// ---------------------------------------------------------------------------

async function handleRegister(request, url, env) {
  assertDataverseConfigured(env);
  assertJwtSecret(env?.JWT_SECRET);

  const ip = clientIp(request);
  const limit = registerLimiter.check(`register|${ip}`);
  if (!limit.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', '注册尝试过于频繁，请稍后再试', {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  const body = await readJsonBody(request, MAX_JSON_BYTES);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const email = body?.email ? String(body.email).trim() : '';

  if (!USERNAME_RE.test(username)) {
    throw new ApiError(400, 'BAD_REQUEST', '用户名需为 3-32 个字符（字母/数字/下划线/点/连字符）');
  }
  if (password.length < 8 || password.length > 128) {
    throw new ApiError(400, 'BAD_REQUEST', '密码长度需在 8-128 个字符之间');
  }
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) {
    throw new ApiError(400, 'BAD_REQUEST', '邮箱格式不正确');
  }

  const s = schema(env);
  const existing = await findUserByUsername(env, username);
  if (existing) {
    throw new ApiError(409, 'USERNAME_TAKEN', '用户名已被占用');
  }

  const record = await createPasswordRecord(password, env);
  const created = await dvCreate(env, s.user.table, {
    [s.user.username]: username,
    ...(email ? { [s.user.email]: email } : {}),
    [s.user.passwordHash]: record.hash,
    [s.user.salt]: record.salt,
    [s.user.iterations]: record.iterations,
  });

  const id = created?.[s.user.id];
  if (!id) throw new ApiError(502, 'CLOUD_REQUEST_FAILED', '创建账号失败');

  registerLimiter.reset(`register|${ip}`);
  const token = await issueUserToken({ id, username }, env);
  return jsonResponse({ token, user: { id, username, email: email || null } }, { request, env, cors: CLOUD_CORS });
}

async function handleLogin(request, url, env) {
  assertDataverseConfigured(env);
  assertJwtSecret(env?.JWT_SECRET);

  const body = await readJsonBody(request, MAX_JSON_BYTES);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');

  const key = `${username.toLowerCase()}|${clientIp(request)}`;
  const limit = loginLimiter.check(key);
  if (!limit.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', '登录尝试次数过多，请 15 分钟后再试', {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  const s = schema(env);
  const user = username ? await findUserByUsername(env, username) : null;
  const ok =
    user &&
    (await verifyPassword(
      password,
      user[s.user.salt],
      Number(user[s.user.iterations]),
      user[s.user.passwordHash]
    ));

  if (!ok) {
    loginLimiter.record(key);
    throw new ApiError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }

  loginLimiter.reset(key);
  const id = user[s.user.id];
  const token = await issueUserToken({ id, username: user[s.user.username] }, env);
  return jsonResponse(
    { token, user: { id, username: user[s.user.username], email: user[s.user.email] || null } },
    { request, env, cors: CLOUD_CORS }
  );
}

async function handleMe(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const s = schema(env);
  const rows = await dvQueryAll(env, s.user.table, {
    filter: `${s.user.id} eq ${uid}`,
    select: [s.user.id, s.user.username, s.user.email],
  });
  const user = rows[0];
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', '账号不存在或已被删除');

  return jsonResponse(
    { user: { id: user[s.user.id], username: user[s.user.username], email: user[s.user.email] || null } },
    { request, env, cors: CLOUD_CORS }
  );
}

// ---------------------------------------------------------------------------
// 云端状态（无需登录）
// ---------------------------------------------------------------------------

async function handleStatus(request, url, env) {
  const secret = env?.JWT_SECRET;
  return jsonResponse(
    {
      cloud: {
        dataverse: isDataverseConfiguredLocal(env),
        auth: Boolean(secret && String(secret).length >= 32),
        sharepoint: isSharePointConfigured(env),
      },
    },
    { request, env, cors: CLOUD_CORS }
  );
}

// ---------------------------------------------------------------------------
// 用户数据（config_json + dictionary_json，每用户一行）
// ---------------------------------------------------------------------------

async function handleGetUserData(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const s = schema(env);
  const row = await dvQueryOne(env, s.userData.table, {
    filter: `${s.userData.ownerValue} eq ${uid}`,
    select: [s.userData.configJson, s.userData.dictionaryJson, s.userData.updatedAt],
  });

  return jsonResponse(
    {
      configJson: row?.[s.userData.configJson] || null,
      dictionaryJson: row?.[s.userData.dictionaryJson] || null,
      updatedAt: row?.[s.userData.updatedAt] || null,
    },
    { request, env, cors: CLOUD_CORS }
  );
}

async function handlePutUserData(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const body = await readJsonBody(request, MAX_JSON_BYTES);
  const configJson = stringifyField(body?.configJson);
  const dictionaryJson = stringifyField(body?.dictionaryJson);
  assertLyricSize(configJson);
  assertLyricSize(dictionaryJson);

  const s = schema(env);
  const updatedAt = String(Date.now());
  const data = {
    [s.userData.configJson]: configJson,
    [s.userData.dictionaryJson]: dictionaryJson,
    [s.userData.updatedAt]: updatedAt,
  };

  const existing = await dvQueryOne(env, s.userData.table, {
    filter: `${s.userData.ownerValue} eq ${uid}`,
    select: [s.userData.id],
  });

  if (existing) {
    await dvUpdate(env, s.userData.table, existing[s.userData.id], data);
  } else {
    await dvCreate(env, s.userData.table, {
      ...data,
      [`${s.userData.ownerBind}@odata.bind`]: `/${s.user.set}(${uid})`,
    });
  }

  return jsonResponse({ ok: true, updatedAt }, { request, env, cors: CLOUD_CORS });
}

// ---------------------------------------------------------------------------
// 歌曲
// ---------------------------------------------------------------------------

async function handleListSongs(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const s = schema(env);
  const rows = await dvQueryAll(env, s.song.table, {
    filter: `${s.song.ownerValue} eq ${uid}`,
    select: [s.song.songId, s.song.title, s.song.artist, s.song.badges, s.song.audioPath, s.song.updatedAt],
    orderBy: `${s.song.updatedAt} desc`,
  });

  // 同一 song_id 理论上只有一行；若出现重复行，保留 updated_at 最新的一条
  const byId = new Map();
  for (const row of rows) {
    const songId = row[s.song.songId];
    if (!songId) continue;
    const ts = Number(row[s.song.updatedAt]) || 0;
    const prev = byId.get(songId);
    if (!prev || ts > prev.ts) {
      byId.set(songId, { ts, song: mapSongSummary(s, row) });
    }
  }

  return jsonResponse({ songs: [...byId.values()].map((entry) => entry.song) }, { request, env, cors: CLOUD_CORS });
}

async function handleGetSong(request, url, env, songId) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);
  assertSongId(songId);

  const s = schema(env);
  const row = await dvQueryOne(env, s.song.table, {
    filter: songFilter(s, songId, uid),
    select: [s.song.songId, s.song.title, s.song.artist, s.song.badges, s.song.lyricJson, s.song.audioPath, s.song.updatedAt],
  });

  if (!row) throw new ApiError(404, 'SONG_NOT_FOUND', '云端不存在该歌曲');

  return jsonResponse(
    {
      songId: row[s.song.songId],
      title: row[s.song.title] || '',
      artist: row[s.song.artist] || '',
      badges: parseJsonSafe(row[s.song.badges]),
      lyricJson: row[s.song.lyricJson] || null,
      audioPath: row[s.song.audioPath] || null,
      updatedAt: row[s.song.updatedAt] || null,
    },
    { request, env, cors: CLOUD_CORS }
  );
}

async function handlePutSong(request, url, env, songId) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);
  assertSongId(songId);

  const body = await readJsonBody(request, MAX_JSON_BYTES);
  const lyricJson = stringifyField(body?.lyricJson);
  assertLyricSize(lyricJson);

  const s = schema(env);
  const badges = stringifyField(body?.badges);
  if (badges.length > 4000) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '歌曲元数据过大（上限 4000 字符）');
  }

  // LWW 依据：客户端 updated_at（epoch ms 字符串）
  const clientUpdatedAt = Number(body?.updatedAt);
  const updatedAt = String(Number.isFinite(clientUpdatedAt) && clientUpdatedAt > 0 ? clientUpdatedAt : Date.now());

  const data = {
    [s.song.songId]: songId,
    [s.song.title]: clampStr(body?.title, 200),
    [s.song.artist]: clampStr(body?.artist, 200),
    [s.song.badges]: badges,
    [s.song.lyricJson]: lyricJson,
    [s.song.audioPath]: clampStr(body?.audioPath, 400),
    [s.song.updatedAt]: updatedAt,
  };

  const rows = await dvQueryAll(env, s.song.table, {
    filter: songFilter(s, songId, uid),
    select: [s.song.id],
  });

  if (rows.length) {
    await dvUpdate(env, s.song.table, rows[0][s.song.id], data);
    // 清理历史重复行
    for (const dup of rows.slice(1)) {
      await dvDelete(env, s.song.table, dup[s.song.id]);
    }
  } else {
    await dvCreate(env, s.song.table, {
      ...data,
      [`${s.song.ownerBind}@odata.bind`]: `/${s.user.set}(${uid})`,
    });
  }

  return jsonResponse({ ok: true, updatedAt }, { request, env, cors: CLOUD_CORS });
}

async function handleDeleteSong(request, url, env, songId) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);
  assertSongId(songId);

  const s = schema(env);
  const rows = await dvQueryAll(env, s.song.table, {
    filter: songFilter(s, songId, uid),
    select: [s.song.id],
  });

  if (!rows.length) throw new ApiError(404, 'SONG_NOT_FOUND', '云端不存在该歌曲');

  for (const row of rows) {
    await dvDelete(env, s.song.table, row[s.song.id]);
  }

  // 尽力清理 SharePoint 上的音频（未配置或失败不影响删除结果）
  if (isSharePointConfigured(env)) {
    try {
      await deleteAudio(env, uid, songId);
    } catch (error) {
      console.warn('[cloud] audio cleanup skipped:', error?.message || error);
    }
  }

  return jsonResponse({ ok: true }, { request, env, cors: CLOUD_CORS });
}

// ---------------------------------------------------------------------------
// 音频（Graph → SharePoint）
// ---------------------------------------------------------------------------

async function handlePutAudio(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  let songId;
  let mime;
  let data;

  if (contentType.includes('application/json')) {
    // 规格路径：JSON body 内 base64
    const body = await readJsonBody(request, MAX_AUDIO_JSON_BYTES);
    songId = body?.songId;
    mime = String(body?.mime || '');
    data = base64ToBytes(body?.data);
  } else {
    // 高效路径：原始二进制 + 查询参数（前端默认，避免 base64 膨胀 33%）
    songId = url.searchParams.get('songId');
    mime = url.searchParams.get('mime') || contentType || 'audio/mpeg';
    data = await readBytesBody(request, MAX_AUDIO_BYTES);
  }

  assertSongId(songId);
  if (!mime) throw new ApiError(400, 'BAD_REQUEST', '缺少音频 MIME 类型');
  if (!data || data.byteLength === 0) throw new ApiError(400, 'BAD_REQUEST', '缺少音频数据');

  await putAudio(env, uid, songId, data, mime);

  const path = `Songs/${uid}/${songId}`;
  // 尽力更新歌曲行的 audio_path（歌曲行可能尚未创建）
  try {
    const s = schema(env);
    const rows = await dvQueryAll(env, s.song.table, {
      filter: songFilter(s, songId, uid),
      select: [s.song.id],
    });
    if (rows.length) {
      await dvUpdate(env, s.song.table, rows[0][s.song.id], { [s.song.audioPath]: path });
    }
  } catch (error) {
    console.warn('[cloud] audio_path update skipped:', error?.message || error);
  }

  return jsonResponse({ ok: true, path }, { request, env, cors: CLOUD_CORS });
}

async function handleGetAudio(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const songId = url.searchParams.get('songId');
  assertSongId(songId);

  // MIME 解析优先级：查询参数 → 歌曲行 badges.audio.mime → Graph 响应头 → 兜底
  let mime = url.searchParams.get('mime') || '';
  if (!mime) {
    try {
      const s = schema(env);
      const row = await dvQueryOne(env, s.song.table, {
        filter: songFilter(s, songId, uid),
        select: [s.song.badges],
      });
      const badges = parseJsonSafe(row?.[s.song.badges]);
      mime = badges?.audio?.mime || '';
    } catch {
      // 查询失败不阻断下载
    }
  }

  const upstream = await getAudio(env, uid, songId);
  const headers = new Headers({
    'Content-Type': mime || upstream.headers.get('Content-Type') || 'audio/mpeg',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(request, env, CLOUD_CORS),
  });
  return new Response(upstream.body, { status: 200, headers });
}

async function handleDeleteAudio(request, url, env) {
  assertDataverseConfigured(env);
  const claims = await requireUser(request, env);
  const uid = assertGuid(claims.uid);

  const songId = url.searchParams.get('songId');
  assertSongId(songId);

  await deleteAudio(env, uid, songId);

  // 尽力清空歌曲行的 audio_path
  try {
    const s = schema(env);
    const rows = await dvQueryAll(env, s.song.table, {
      filter: songFilter(s, songId, uid),
      select: [s.song.id],
    });
    if (rows.length) {
      await dvUpdate(env, s.song.table, rows[0][s.song.id], { [s.song.audioPath]: null });
    }
  } catch (error) {
    console.warn('[cloud] audio_path clear skipped:', error?.message || error);
  }

  return jsonResponse({ ok: true }, { request, env, cors: CLOUD_CORS });
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function normalizePathLocal(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '');
  return path || '/';
}

function isSameOrigin(origin, url) {
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

function isDataverseConfiguredLocal(env) {
  // 避免循环依赖：本地判断（与 dataverse.js 逻辑一致）
  return Boolean(
    env?.DATAVERSE_TENANT_ID && env?.DATAVERSE_ENV_URL && env?.DATAVERSE_CLIENT_ID && env?.DATAVERSE_CLIENT_SECRET
  );
}

async function findUserByUsername(env, username) {
  const s = schema(env);
  const rows = await dvQueryAll(env, s.user.table, {
    filter: `${s.user.username} eq '${odataQuote(username)}'`,
    select: [s.user.id, s.user.username, s.user.email, s.user.passwordHash, s.user.salt, s.user.iterations],
  });
  return rows[0] || null;
}

function songFilter(s, songId, uid) {
  return `${s.song.songId} eq '${odataQuote(songId)}' and ${s.song.ownerValue} eq ${uid}`;
}

function mapSongSummary(s, row) {
  return {
    songId: row[s.song.songId],
    title: row[s.song.title] || '',
    artist: row[s.song.artist] || '',
    badges: parseJsonSafe(row[s.song.badges]),
    audioPath: row[s.song.audioPath] || null,
    updatedAt: row[s.song.updatedAt] || null,
  };
}

function assertGuid(value) {
  const text = String(value || '');
  if (!GUID_RE.test(text)) throw new ApiError(401, 'UNAUTHORIZED', '访问令牌无效或已过期');
  return text;
}

function assertSongId(value) {
  const id = String(value || '');
  if (!id || id.length > 64 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new ApiError(400, 'BAD_REQUEST', '无效的歌曲 ID');
  }
  return id;
}

async function readJsonBody(request, maxBytes) {
  const lengthHeader = Number(request.headers.get('Content-Length') || 0);
  if (lengthHeader > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `请求体过大（上限 ${maxBytes} 字节）`);
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `请求体过大（上限 ${maxBytes} 字节）`);
  }
  if (!text.trim()) throw new ApiError(400, 'BAD_REQUEST', '缺少请求体');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
}

async function readBytesBody(request, maxBytes) {
  const lengthHeader = Number(request.headers.get('Content-Length') || 0);
  if (lengthHeader > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `音频过大（上限 ${maxBytes} 字节）`);
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `音频过大（上限 ${maxBytes} 字节）`);
  }
  return buffer;
}

function base64ToBytes(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return null;
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'base64 音频数据解码失败');
  }
}

function stringifyField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseJsonSafe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampStr(value, max) {
  return String(value ?? '').slice(0, max);
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
