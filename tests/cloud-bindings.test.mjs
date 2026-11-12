// 云同步 Worker 路由与 Dataverse 的集成契约测试（mock fetch，不访问真实环境）。
// 重点防回归：owner 查找列的 OData 导航属性名保留 Lookup SchemaName 大小写（jls_Owner），
// 绑定注解 jls_Owner@odata.bind 大小写敏感；过滤用结构属性 _jls_owner_value（小写）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { signJwt } from '../worker/src/auth.js';
import { handleCloudApi } from '../worker/src/cloud.js';
import { resetDataverseTokenCache } from '../worker/src/dataverse.js';

const SECRET = 'unit-test-secret-0123456789abcdef0123456789';
const USER_GUID = '11111111-2222-4333-8444-555555555555';
const ENV = {
  JWT_SECRET: SECRET,
  DATAVERSE_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  DATAVERSE_ENV_URL: 'https://unit-test.api.crm.dynamics.com',
  DATAVERSE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
  DATAVERSE_CLIENT_SECRET: 'unit-test-secret',
};

/**
 * 安装 fetch mock：token 端点发令牌；Dataverse GET 查询返回空集（走创建分支）；
 * POST 创建返回 201。记录全部调用供断言。
 */
function installFetchMock() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    const record = { url, method: init.method || 'GET', body: init.body };
    calls.push(record);
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'unit-test-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/data/')) {
      if (record.method === 'GET') {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function authedRequest(path, { method, body } = {}) {
  const token = await signJwt({ uid: USER_GUID, username: 'bob' }, SECRET);
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('PUT /api/cloud/user-data 创建行用 jls_Owner@odata.bind（帕斯卡大小写）', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock();
  try {
    const req = await authedRequest('/api/cloud/user-data', {
      method: 'PUT',
      body: { configJson: '{"theme":"dark"}', dictionaryJson: null },
    });
    const res = await handleCloudApi(req, new URL(req.url), ENV, {});
    assert.equal(res.status, 200);

    const create = mock.calls.find((c) => c.method === 'POST' && c.url.includes('/jls_user_datas'));
    assert.ok(create, '应向 jls_user_datas 发起 POST 创建');
    const payload = JSON.parse(create.body);
    assert.ok(
      'jls_Owner@odata.bind' in payload,
      `绑定键必须是 jls_Owner@odata.bind（大小写敏感），实际键：${Object.keys(payload).join(', ')}`
    );
    assert.equal(payload['jls_Owner@odata.bind'], `/jls_users(${USER_GUID})`);
    assert.equal(payload.jls_config_json, '{"theme":"dark"}');

    // 查询过滤必须用小写结构属性 _jls_owner_value
    const query = mock.calls.find((c) => c.method === 'GET' && c.url.includes('/jls_user_datas'));
    assert.ok(query, '应查询 jls_user_datas');
    assert.ok(query.url.includes('_jls_owner_value'));
    assert.ok(!query.url.includes('_jls_Owner_value'));
  } finally {
    mock.restore();
  }
});

test('PUT /api/cloud/songs/{id} 创建行用 jls_Owner@odata.bind（帕斯卡大小写）', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock();
  try {
    const songId = '20261112-abc123';
    const req = await authedRequest(`/api/cloud/songs/${encodeURIComponent(songId)}`, {
      method: 'PUT',
      body: {
        title: '测试歌曲',
        artist: '测试歌手',
        badges: '{"duration":180}',
        lyricJson: '{"lines":[]}',
        updatedAt: 1760000000000,
      },
    });
    const res = await handleCloudApi(req, new URL(req.url), ENV, {});
    assert.equal(res.status, 200);

    const create = mock.calls.find((c) => c.method === 'POST' && c.url.includes('/jls_songs'));
    assert.ok(create, '应向 jls_songs 发起 POST 创建');
    const payload = JSON.parse(create.body);
    assert.ok(
      'jls_Owner@odata.bind' in payload,
      `绑定键必须是 jls_Owner@odata.bind（大小写敏感），实际键：${Object.keys(payload).join(', ')}`
    );
    assert.equal(payload['jls_Owner@odata.bind'], `/jls_users(${USER_GUID})`);
    assert.equal(payload.jls_song_id, songId);
    assert.equal(payload.jls_lyric_json, '{"lines":[]}');

    const query = mock.calls.find((c) => c.method === 'GET' && c.url.includes('/jls_songs'));
    assert.ok(query, '应查询 jls_songs');
    const decodedQuery = decodeURIComponent(query.url.replace(/\+/g, ' '));
    assert.ok(decodedQuery.includes('_jls_owner_value'));
    assert.ok(decodedQuery.includes(`jls_song_id eq '${songId}'`));
  } finally {
    mock.restore();
  }
});
