// 认证路由回归测试：register/login 必须把 env.JWT_SECRET（字符串）传给 assertJwtSecret，
// 而不是整个 env 对象——线上曾因 assertJwtSecret(env) 把对象当 secret 抛 503 AUTH_NOT_CONFIGURED，
// 而 /api/cloud/status 仍显示 auth:true（status 用的是 env?.JWT_SECRET），导致注册登录全挂。
// 走 handleCloudApi 全链路（真实形状 env + mock fetch 拦 Dataverse），防止传参路径再回归。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasswordRecord } from '../worker/src/auth.js';
import { handleCloudApi } from '../worker/src/cloud.js';
import { resetDataverseTokenCache } from '../worker/src/dataverse.js';

const SECRET = 'route-test-secret-0123456789abcdef0123456789';
const USER_GUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// 真实形状的 env：字符串机密 + Dataverse 连接 vars + 低迭代数（测试提速）
const ENV = {
  JWT_SECRET: SECRET,
  DATAVERSE_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  DATAVERSE_ENV_URL: 'https://route-test.api.crm.dynamics.com',
  DATAVERSE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
  DATAVERSE_CLIENT_SECRET: 'route-test-secret',
  PBKDF2_ITERATIONS: '1000',
};

/**
 * 安装 fetch mock：token 端点发令牌；Dataverse GET 查询 users 返回 rows；
 * POST 创建 users 返回 201 + 带 jls_userid 的表示。记录调用供断言。
 */
function installFetchMock({ users = [] } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    const record = { url, method: init.method || 'GET', body: init.body };
    calls.push(record);
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'route-test-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/data/') && url.includes('/jls_users')) {
      if (record.method === 'GET') {
        return new Response(JSON.stringify({ value: users }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ jls_userid: USER_GUID }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
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

function jsonRequest(path, body) {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/auth/register：env 配置齐全时不再误报 AUTH_NOT_CONFIGURED', async () => {
  resetDataverseTokenCache();
  const mock = installFetchMock();
  try {
    const req = jsonRequest('/api/auth/register', { username: 'alice', password: 'password123' });
    const res = await handleCloudApi(req, new URL(req.url), ENV, {});
    assert.equal(res.status, 200, `注册应成功，实际 ${res.status}：${await res.clone().text()}`);

    const payload = await res.json();
    assert.ok(payload.token, '应签发 JWT');
    assert.equal(payload.user.id, USER_GUID);
    assert.equal(payload.user.username, 'alice');

    const create = mock.calls.find((c) => c.method === 'POST' && c.url.includes('/jls_users'));
    assert.ok(create, '应向 jls_users 发起 POST 创建');
    const row = JSON.parse(create.body);
    assert.equal(row.jls_username, 'alice');
    assert.equal(row.jls_iterations, 1000);
    assert.ok(row.jls_password_hash && row.jls_salt, '应写入 PBKDF2 哈希与盐');
  } finally {
    mock.restore();
  }
});

test('POST /api/auth/login：env 配置齐全时不再误报 AUTH_NOT_CONFIGURED', async () => {
  resetDataverseTokenCache();
  const record = await createPasswordRecord('password123', ENV);
  const mock = installFetchMock({
    users: [
      {
        jls_userid: USER_GUID,
        jls_username: 'alice',
        jls_email: null,
        jls_password_hash: record.hash,
        jls_salt: record.salt,
        jls_iterations: record.iterations,
      },
    ],
  });
  try {
    const req = jsonRequest('/api/auth/login', { username: 'alice', password: 'password123' });
    const res = await handleCloudApi(req, new URL(req.url), ENV, {});
    assert.equal(res.status, 200, `登录应成功，实际 ${res.status}：${await res.clone().text()}`);

    const payload = await res.json();
    assert.ok(payload.token, '应签发 JWT');
    assert.equal(payload.user.id, USER_GUID);
    assert.equal(payload.user.username, 'alice');
  } finally {
    mock.restore();
  }
});
