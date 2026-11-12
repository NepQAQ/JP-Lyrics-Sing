// 音频去重（跨用户云端副本复用）路由测试：
// - GET /api/cloud/audio/lookup：规范化 title+artist 匹配、排除请求者自己的行
// - GET/DELETE /api/cloud/audio、DELETE /api/cloud/songs/{id}：行驱动路径 +
//   Songs/ 白名单（unsafe audio_path 回退构造路径）+ 引用计数（他人引用时保留 blob）
// - PUT /api/cloud/songs/{id}：unsafe audioPath 清空为 ''
// 走 handleCloudApi 全链路（真实形状 env + mock fetch 拦 Dataverse/Graph）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { issueUserToken } from '../worker/src/auth.js';
import { handleCloudApi, normalizeLookupKey } from '../worker/src/cloud.js';
import { isSafeAudioPath } from '../worker/src/graph.js';
import { resetDataverseTokenCache } from '../worker/src/dataverse.js';

const SECRET = 'dedup-test-secret-0123456789abcdef0123456789';
const USER_GUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_GUID = '11111111-2222-4333-8444-555555555555';
const SONG_ROW_ID = '99999999-8888-4777-8666-555555555555';

const ENV = {
  JWT_SECRET: SECRET,
  DATAVERSE_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  DATAVERSE_ENV_URL: 'https://dedup-test.api.crm.dynamics.com',
  DATAVERSE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
  DATAVERSE_CLIENT_SECRET: 'dedup-test-secret',
  PBKDF2_ITERATIONS: '1000',
  SHAREPOINT_SITE_ID: 'site.host,1e59acd3-b927-4d9b-8458-8af151af5230,7d5b26e6-06a2-4ccb-a79f-d3c5ad8dd98e',
  SHAREPOINT_DRIVE_ID: 'b!testdrive000000000000000000000000000000000000',
};

const TOKEN = await issueUserToken({ id: USER_GUID, username: 'alice' }, ENV);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 解码 URLSearchParams 序列化的 $filter（`$` 编码为 %24、空格编码为 +）。 */
function decodeFilter(url) {
  const match = /(?:%24|\$)filter=([^&]+)/.exec(url);
  if (!match) return '';
  return decodeURIComponent(match[1]).replace(/\+/g, ' ');
}

/**
 * 安装 fetch mock：
 * - token 端点（Dataverse/Graph 共用）发令牌
 * - Dataverse jls_songs GET 按 $filter 分流：ne null → lookupRows（查重）、
 *   jls_audio_path eq → refRows（引用计数）、其余（song_id+owner）→ songs（请求者的行）
 * - Graph 调用全部记录，PUT/GET/DELETE 返回成功
 */
function installFetchMock({ songs = [], lookupRows = [], refRows = [] } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body });

    if (url.includes('login.microsoftonline.com')) {
      return jsonResponse({ access_token: 'dedup-test-token', expires_in: 3600 });
    }

    if (url.includes('graph.microsoft.com')) {
      if (method === 'PUT') return jsonResponse({});
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('fake-audio-bytes', {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }

    if (url.includes('/api/data/') && url.includes('/jls_songs')) {
      if (method === 'GET') {
        const filter = decodeFilter(url);
        if (filter.includes('jls_audio_path ne null')) return jsonResponse({ value: lookupRows });
        if (filter.includes("jls_audio_path eq '")) return jsonResponse({ value: refRows });
        return jsonResponse({ value: songs });
      }
      if (method === 'PATCH') return new Response(null, { status: 204 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({ jls_songid: SONG_ROW_ID }, 201);
    }

    return jsonResponse({});
  };
  return {
    calls,
    graphCalls: () => calls.filter((c) => c.url.includes('graph.microsoft.com')),
    restore() {
      globalThis.fetch = original;
    },
  };
}

function authedRequest(path, { method = 'GET', body } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(req) {
  const res = await handleCloudApi(req, new URL(req.url), ENV, {});
  return res;
}

// ---------------------------------------------------------------- 纯函数

test('isSafeAudioPath：Songs/{uid}/{songId} 三段合法', () => {
  assert.equal(isSafeAudioPath(`Songs/${USER_GUID}/song-1`), true);
  assert.equal(isSafeAudioPath('Songs/abc/def'), true);
});

test('isSafeAudioPath：越界路径全部拒绝', () => {
  assert.equal(isSafeAudioPath('../../Documents/secret'), false); // 目录穿越
  assert.equal(isSafeAudioPath('/Songs/a/b'), false); // 前导斜杠
  assert.equal(isSafeAudioPath('Songs/a'), false); // 两段
  assert.equal(isSafeAudioPath('Songs/a/b/c'), false); // 四段
  assert.equal(isSafeAudioPath('Songs//b'), false); // 空段
  assert.equal(isSafeAudioPath('Other/a/b'), false); // 非 Songs 前缀
  assert.equal(isSafeAudioPath('Songs/a/b\x00'), false); // 控制字符
  assert.equal(isSafeAudioPath(''), false);
  assert.equal(isSafeAudioPath(null), false);
  assert.equal(isSafeAudioPath(123), false);
  assert.equal(isSafeAudioPath(`Songs/${'x'.repeat(200)}/${'y'.repeat(200)}`), false); // 超长（>400）
});

test('normalizeLookupKey：trim、小写、压缩空白', () => {
  assert.equal(normalizeLookupKey('  Hello   World  '), 'hello world');
  assert.equal(normalizeLookupKey('ＦＵＬＬ　ＷＩＤＴＨ'), 'ｆｕｌｌ ｗｉｄｔｈ'); // 全角 + 全角空格压缩
  assert.equal(normalizeLookupKey(null), '');
  assert.equal(normalizeLookupKey(undefined), '');
});

// ---------------------------------------------------------------- lookup 路由

test('GET /api/cloud/audio/lookup：规范化匹配其他用户的行并返回共享路径', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    lookupRows: [
      // 自己的行（同歌名）——应被排除
      {
        jls_song_id: 'own-song',
        jls_title: 'Lemon',
        jls_artist: '  Kenshi   Yonezu ',
        jls_audio_path: `Songs/${USER_GUID}/own-song`,
        _jls_owner_value: USER_GUID,
      },
      // 其他用户的行——大小写/空白差异应命中
      {
        jls_song_id: 'other-song',
        jls_title: '  lemon ',
        jls_artist: 'Kenshi Yonezu',
        jls_audio_path: `Songs/${OTHER_GUID}/other-song`,
        _jls_owner_value: OTHER_GUID,
      },
    ],
  });
  try {
    const req = authedRequest('/api/cloud/audio/lookup?title=LEMON&artist=kenshi%20yonezu');
    const res = await call(req);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.found, true);
    assert.equal(payload.audioPath, `Songs/${OTHER_GUID}/other-song`);
    assert.equal(payload.title, '  lemon ');
    assert.equal(payload.artist, 'Kenshi Yonezu');
    // 不暴露其他用户的用户名/ID
    assert.equal(payload.username, undefined);
    assert.equal(payload.owner, undefined);
  } finally {
    mock.restore();
  }
});

test('GET /api/cloud/audio/lookup：仅自己上传过 → found:false（不提示自己）', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    lookupRows: [
      {
        jls_song_id: 'own-song',
        jls_title: 'Lemon',
        jls_artist: 'Kenshi Yonezu',
        jls_audio_path: `Songs/${USER_GUID}/own-song`,
        _jls_owner_value: USER_GUID,
      },
    ],
  });
  try {
    const req = authedRequest('/api/cloud/audio/lookup?title=Lemon&artist=Kenshi%20Yonezu');
    const res = await call(req);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).found, false);
  } finally {
    mock.restore();
  }
});

test('GET /api/cloud/audio/lookup：无匹配 → found:false', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    lookupRows: [
      {
        jls_song_id: 'other-song',
        jls_title: '打上花火',
        jls_artist: 'DAOKO',
        jls_audio_path: `Songs/${OTHER_GUID}/other-song`,
        _jls_owner_value: OTHER_GUID,
      },
    ],
  });
  try {
    const req = authedRequest('/api/cloud/audio/lookup?title=Lemon&artist=Kenshi%20Yonezu');
    const res = await call(req);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).found, false);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- GET audio 行驱动路径

test('GET /api/cloud/audio：行内共享路径（安全）→ Graph 用行驱动路径', async () => {
  resetDataverseTokenCache();
  const sharedPath = `Songs/${OTHER_GUID}/shared-song`;
  const mock = installFetchMock({
    songs: [
      {
        jls_songid: SONG_ROW_ID,
        jls_song_id: 'my-song',
        jls_badges: JSON.stringify({ audio: { mime: 'audio/mp4', size: 100, name: 'a.m4a' } }),
        jls_audio_path: sharedPath,
      },
    ],
  });
  try {
    const req = authedRequest('/api/cloud/audio?songId=my-song');
    const res = await call(req);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/mp4'); // badges 兜底 MIME

    const graphGet = mock.graphCalls().find((c) => c.method === 'GET');
    assert.ok(graphGet, '应调用 Graph GET');
    assert.ok(
      graphGet.url.includes(`/root:/Songs/${OTHER_GUID}/shared-song:/content`),
      `Graph URL 应使用行内共享路径，实际 ${graphGet.url}`
    );
  } finally {
    mock.restore();
  }
});

test('GET /api/cloud/audio：行内 unsafe 路径 → 回退构造路径 Songs/{uid}/{songId}', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    songs: [
      {
        jls_songid: SONG_ROW_ID,
        jls_song_id: 'my-song',
        jls_badges: null,
        jls_audio_path: '../../Documents/secret.txt',
      },
    ],
  });
  try {
    const req = authedRequest('/api/cloud/audio?songId=my-song&mime=audio/mpeg');
    const res = await call(req);
    assert.equal(res.status, 200);

    const graphGet = mock.graphCalls().find((c) => c.method === 'GET');
    assert.ok(graphGet, '应调用 Graph GET');
    assert.ok(
      graphGet.url.includes(`/root:/Songs/${USER_GUID}/my-song:/content`),
      `unsafe 路径应回退构造路径，实际 ${graphGet.url}`
    );
    assert.ok(!graphGet.url.includes('Documents'), '绝不能读 Songs/ 之外的文件');
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 引用计数删除

test('DELETE /api/cloud/audio：其他用户仍引用共享路径 → 保留 blob，只清本行字段', async () => {
  resetDataverseTokenCache();
  const sharedPath = `Songs/${OTHER_GUID}/shared-song`;
  const mock = installFetchMock({
    songs: [
      { jls_songid: SONG_ROW_ID, jls_song_id: 'my-song', jls_audio_path: sharedPath },
    ],
    refRows: [
      { _jls_owner_value: OTHER_GUID }, // 其他用户仍引用
    ],
  });
  try {
    const req = authedRequest('/api/cloud/audio?songId=my-song', { method: 'DELETE' });
    const res = await call(req);
    assert.equal(res.status, 200);

    assert.equal(mock.graphCalls().length, 0, '他人引用时不应调用 Graph 删除');

    const patch = mock.calls.find((c) => c.method === 'PATCH' && c.url.includes('/jls_songs('));
    assert.ok(patch, '应 PATCH 清空本行 audio_path');
    const row = JSON.parse(patch.body);
    assert.equal(row.jls_audio_path, null);
  } finally {
    mock.restore();
  }
});

test('DELETE /api/cloud/audio：零引用 → 调用 Graph 删除 blob', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    songs: [
      { jls_songid: SONG_ROW_ID, jls_song_id: 'my-song', jls_audio_path: `Songs/${USER_GUID}/my-song` },
    ],
    refRows: [],
  });
  try {
    const req = authedRequest('/api/cloud/audio?songId=my-song', { method: 'DELETE' });
    const res = await call(req);
    assert.equal(res.status, 200);

    const graphDelete = mock.graphCalls().find((c) => c.method === 'DELETE');
    assert.ok(graphDelete, '零引用时应调用 Graph 删除');
    assert.ok(graphDelete.url.includes(`/root:/Songs/${USER_GUID}/my-song:/content`));
  } finally {
    mock.restore();
  }
});

test('DELETE /api/cloud/songs/{id}：他人引用共享音频 → 删行但保留 blob', async () => {
  resetDataverseTokenCache();
  const sharedPath = `Songs/${OTHER_GUID}/shared-song`;
  const mock = installFetchMock({
    songs: [
      { jls_songid: SONG_ROW_ID, jls_song_id: 'my-song', jls_audio_path: sharedPath },
    ],
    refRows: [{ _jls_owner_value: OTHER_GUID }],
  });
  try {
    const req = authedRequest('/api/cloud/songs/my-song', { method: 'DELETE' });
    const res = await call(req);
    assert.equal(res.status, 200);

    // 歌曲行应被删除
    const rowDelete = mock.calls.find((c) => c.method === 'DELETE' && c.url.includes(`/jls_songs(${SONG_ROW_ID})`));
    assert.ok(rowDelete, '应删除 Dataverse 歌曲行');

    // blob 保留
    assert.equal(mock.graphCalls().length, 0, '他人引用时不应调用 Graph 删除');
  } finally {
    mock.restore();
  }
});

test('DELETE /api/cloud/songs/{id}：零引用 → 删行并删除 blob', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    songs: [
      { jls_songid: SONG_ROW_ID, jls_song_id: 'my-song', jls_audio_path: `Songs/${USER_GUID}/my-song` },
    ],
    refRows: [],
  });
  try {
    const req = authedRequest('/api/cloud/songs/my-song', { method: 'DELETE' });
    const res = await call(req);
    assert.equal(res.status, 200);

    const graphDelete = mock.graphCalls().find((c) => c.method === 'DELETE');
    assert.ok(graphDelete, '零引用时应调用 Graph 删除');
    assert.ok(graphDelete.url.includes(`/root:/Songs/${USER_GUID}/my-song:/content`));
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- PUT song audioPath 白名单

test('PUT /api/cloud/songs/{id}：unsafe audioPath → 行内写空串', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({ songs: [] });
  try {
    const req = authedRequest('/api/cloud/songs/my-song', {
      method: 'PUT',
      body: {
        title: 'Lemon',
        artist: 'Kenshi Yonezu',
        badges: '{}',
        lyricJson: '{}',
        updatedAt: 1000,
        audioPath: '../../Documents/evil',
      },
    });
    const res = await call(req);
    assert.equal(res.status, 200, `保存应成功，实际 ${res.status}：${await res.clone().text()}`);

    const create = mock.calls.find((c) => c.method === 'POST' && c.url.includes('/jls_songs'));
    assert.ok(create, '应 POST 创建歌曲行');
    const row = JSON.parse(create.body);
    assert.equal(row.jls_audio_path, '', 'unsafe 路径应清空');
    assert.equal(row['jls_Owner@odata.bind'], `/${'jls_users'}(${USER_GUID})`);
  } finally {
    mock.restore();
  }
});

test('PUT /api/cloud/songs/{id}：合法共享 audioPath → 原样写入行内', async () => {
  resetDataverseTokenCache();
  const sharedPath = `Songs/${OTHER_GUID}/shared-song`;
  const mock = installFetchMock({ songs: [] });
  try {
    const req = authedRequest('/api/cloud/songs/my-song', {
      method: 'PUT',
      body: {
        title: 'Lemon',
        artist: 'Kenshi Yonezu',
        badges: '{}',
        lyricJson: '{}',
        updatedAt: 1000,
        audioPath: sharedPath,
      },
    });
    const res = await call(req);
    assert.equal(res.status, 200);

    const create = mock.calls.find((c) => c.method === 'POST' && c.url.includes('/jls_songs'));
    assert.ok(create);
    const row = JSON.parse(create.body);
    assert.equal(row.jls_audio_path, sharedPath);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- PUT audio 回写行路径

test('PUT /api/cloud/audio：上传到自己的 Songs/{uid}/{songId} 并回写行内路径', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock({
    songs: [{ jls_songid: SONG_ROW_ID, jls_song_id: 'my-song', jls_audio_path: null }],
  });
  try {
    const req = new Request('https://worker.test/api/cloud/audio?songId=my-song&mime=audio/mpeg', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'audio/mpeg' },
      body: 'fake-audio',
    });
    const res = await call(req);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.path, `Songs/${USER_GUID}/my-song`);

    const graphPut = mock.graphCalls().find((c) => c.method === 'PUT');
    assert.ok(graphPut, '应调用 Graph PUT');
    assert.ok(graphPut.url.includes(`/root:/Songs/${USER_GUID}/my-song:/content`));

    const patch = mock.calls.find((c) => c.method === 'PATCH' && c.url.includes('/jls_songs('));
    assert.ok(patch, '应回写行内 audio_path');
    assert.equal(JSON.parse(patch.body).jls_audio_path, `Songs/${USER_GUID}/my-song`);
  } finally {
    mock.restore();
  }
});
