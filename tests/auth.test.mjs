// 云同步后端单元测试：JWT 签发/验证/过期、PBKDF2 哈希与恒时比较、登录限速。
// 运行：node --test tests/auth.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  signJwt,
  verifyJwt,
  assertJwtSecret,
  pbkdf2Iterations,
  createPasswordRecord,
  verifyPassword,
  hashPassword,
  timingSafeEqual,
  createLoginLimiter,
} from '../worker/src/auth.js';

const SECRET = 'unit-test-secret-0123456789-abcdefghij'; // ≥32 字符
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------- JWT

test('JWT 签发后可验证，载荷保留 uid/username', async () => {
  const token = await signJwt({ uid: '11111111-1111-1111-1111-111111111111', username: 'alice' }, SECRET, { now: NOW });
  assert.equal(typeof token, 'string');
  assert.equal(token.split('.').length, 3);

  const payload = await verifyJwt(token, SECRET, { now: NOW + 1000 });
  assert.equal(payload.uid, '11111111-1111-1111-1111-111111111111');
  assert.equal(payload.username, 'alice');
  assert.equal(payload.iat, Math.floor(NOW / 1000));
  // 默认 30 天
  assert.equal(payload.exp, Math.floor(NOW / 1000) + 30 * 24 * 60 * 60);
});

test('JWT 过期后验证失败', async () => {
  const token = await signJwt({ uid: 'u1', username: 'bob' }, SECRET, { now: NOW, ttl: 60 });
  // 59 秒时仍有效
  assert.ok(await verifyJwt(token, SECRET, { now: NOW + 59_000 }));
  assert.equal(await verifyJwt(token, SECRET, { now: NOW + 61_000 }), null);
  // 恰好在 exp 时刻视为过期（<=）
  assert.equal(await verifyJwt(token, SECRET, { now: (Math.floor(NOW / 1000) + 60) * 1000 }), null);
});

test('JWT 密钥不匹配 / 篡改载荷 / 篡改签名 均验证失败', async () => {
  const token = await signJwt({ uid: 'u1', username: 'bob' }, SECRET, { now: NOW });

  assert.equal(await verifyJwt(token, 'another-secret-0123456789-abcdefghij', { now: NOW }), null);

  const [h, p, s] = token.split('.');
  const tamperedPayload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  tamperedPayload.username = 'mallory';
  const tamperedP = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
  assert.equal(await verifyJwt(`${h}.${tamperedP}.${s}`, SECRET, { now: NOW }), null);

  const tamperedSig = s.slice(0, -2) + (s.endsWith('aa') ? 'bb' : 'aa');
  assert.equal(await verifyJwt(`${h}.${p}.${tamperedSig}`, SECRET, { now: NOW }), null);
});

test('JWT 拒绝畸形令牌与非 HS256 算法', async () => {
  assert.equal(await verifyJwt('', SECRET), null);
  assert.equal(await verifyJwt('not-a-jwt', SECRET), null);
  assert.equal(await verifyJwt('a.b', SECRET), null);
  assert.equal(await verifyJwt('a.b.c.d', SECRET), null);

  // alg: none
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ uid: 'u', username: 'x', exp: Math.floor(NOW / 1000) + 999 })).toString('base64url');
  assert.equal(await verifyJwt(`${header}.${payload}.`, SECRET, { now: NOW }), null);
});

test('verifyJwt 要求载荷含 uid 与 username', async () => {
  const token = await signJwt({ uid: 'u1' }, SECRET, { now: NOW });
  assert.equal(await verifyJwt(token, SECRET, { now: NOW }), null);
});

test('assertJwtSecret：缺失或过短抛 503', () => {
  assert.throws(() => assertJwtSecret(undefined), (e) => e.status === 503 && e.code === 'AUTH_NOT_CONFIGURED');
  assert.throws(() => assertJwtSecret('short'), (e) => e.status === 503);
  assert.throws(() => assertJwtSecret('a'.repeat(31)), (e) => e.status === 503);
  assert.doesNotThrow(() => assertJwtSecret('a'.repeat(32)));
});

// ---------------------------------------------------------------- PBKDF2

test('PBKDF2：哈希可验证、错误密码失败、盐随机', async () => {
  const env = { PBKDF2_ITERATIONS: '1000' }; // 测试提速
  const rec1 = await createPasswordRecord('correct horse', env);
  const rec2 = await createPasswordRecord('correct horse', env);

  assert.match(rec1.salt, /^[0-9a-f]{32}$/);
  assert.match(rec1.hash, /^[0-9a-f]{64}$/);
  assert.equal(rec1.iterations, 1000);
  // 同密码不同盐 → 不同哈希
  assert.notEqual(rec1.salt, rec2.salt);
  assert.notEqual(rec1.hash, rec2.hash);

  assert.equal(await verifyPassword('correct horse', rec1.salt, rec1.iterations, rec1.hash), true);
  assert.equal(await verifyPassword('wrong horse', rec1.salt, rec1.iterations, rec1.hash), false);
  // 哈希不匹配时恒时比较返回 false 而非抛错
  assert.equal(await verifyPassword('correct horse', rec1.salt, rec1.iterations, rec2.hash), false);
});

test('pbkdf2Iterations：环境变量可配，非法值回退默认', () => {
  assert.equal(pbkdf2Iterations({ PBKDF2_ITERATIONS: '5000' }), 5000);
  assert.equal(pbkdf2Iterations({ PBKDF2_ITERATIONS: 5000 }), 5000);
  assert.equal(pbkdf2Iterations({}), 100000);
  assert.equal(pbkdf2Iterations(undefined), 100000);
  assert.equal(pbkdf2Iterations({ PBKDF2_ITERATIONS: 'abc' }), 100000);
  assert.equal(pbkdf2Iterations({ PBKDF2_ITERATIONS: '999' }), 100000); // 低于下限
  assert.equal(pbkdf2Iterations({ PBKDF2_ITERATIONS: '-5' }), 100000);
});

test('hashPassword 与 Node crypto pbkdf2 结果一致（跨实现兼容）', async () => {
  const { pbkdf2Sync } = await import('node:crypto');
  const salt = 'deadbeef'.repeat(4);
  const iterations = 1000;
  const expected = pbkdf2Sync('pw', salt, iterations, 32, 'sha256').toString('hex');
  assert.equal(await hashPassword('pw', salt, iterations), expected);
});

// ---------------------------------------------------------------- 恒时比较

test('timingSafeEqual：相等/不等/长度不同', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

// ---------------------------------------------------------------- 登录限速

test('登录限速：窗口内 10 次失败后封锁，窗口过期自动解封', () => {
  let clock = NOW;
  const limiter = createLoginLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10, now: () => clock });
  const key = 'alice|1.2.3.4';

  for (let i = 0; i < 10; i++) {
    const { allowed } = limiter.check(key);
    assert.equal(allowed, true, `第 ${i + 1} 次应允许`);
    limiter.record(key);
  }

  const blocked = limiter.check(key);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 900);

  // 时间前进 15 分钟 → 解封
  clock += 15 * 60 * 1000 + 1;
  const after = limiter.check(key);
  assert.equal(after.allowed, true);
  assert.equal(after.remaining, 10);
});

test('登录限速：不同键互不影响；reset 立即清除', () => {
  let clock = NOW;
  const limiter = createLoginLimiter({ windowMs: 60_000, maxAttempts: 2, now: () => clock });
  const a = 'alice|1.1.1.1';
  const b = 'bob|1.1.1.1';

  limiter.record(a);
  limiter.record(a);
  assert.equal(limiter.check(a).allowed, false);
  assert.equal(limiter.check(b).allowed, true);

  limiter.reset(a);
  assert.equal(limiter.check(a).allowed, true);
});

test('登录限速：成功登录后计数应重置（reset 语义）', () => {
  let clock = NOW;
  const limiter = createLoginLimiter({ windowMs: 60_000, maxAttempts: 3, now: () => clock });
  const key = 'carol|2.2.2.2';

  limiter.record(key);
  limiter.record(key);
  assert.equal(limiter.check(key).remaining, 1);
  limiter.reset(key); // 登录成功路径调用
  assert.equal(limiter.check(key).remaining, 3);
});
