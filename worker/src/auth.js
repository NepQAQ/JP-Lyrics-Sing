// 自建账号认证：JWT（HS256，Web Crypto）+ PBKDF2 密码哈希 + 登录失败限速。
// 最终用户不需要任何微软账号；Worker 是唯一后端入口。

import { ApiError } from './http.js';

const JWT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const PBKDF2_ITERATIONS_DEFAULT = 100000; // 免费版 Worker 10ms CPU 限制可能需调低（见 docs/cloud-setup.md）
const PBKDF2_KEY_LENGTH = 256; // bits
const SALT_BYTES = 16;
const JWT_SECRET_MIN_LENGTH = 32;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// 恒时比较（避免时序侧信道）
// ---------------------------------------------------------------------------

export function timingSafeEqual(a, b) {
  const bufA = typeof a === 'string' ? encoder.encode(a) : new Uint8Array(a);
  const bufB = typeof b === 'string' ? encoder.encode(b) : new Uint8Array(b);
  if (bufA.length !== bufB.length) {
    // 长度不同也走一遍比较，避免长度信息泄露
    let mismatch = 1;
    for (let i = 0; i < Math.max(bufA.length, bufB.length); i++) {
      mismatch |= (bufA[i] || 0) ^ (bufB[i] || 0);
    }
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < bufA.length; i++) {
    mismatch |= bufA[i] ^ bufB[i];
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// JWT（HS256）
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Encode(text) {
  return encoder.encode(text);
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', utf8Encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signJwt(payload, secret, { now = Date.now(), ttl = JWT_TTL_SECONDS } = {}) {
  if (!secret || typeof secret !== 'string') throw new Error('JWT secret is required');
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttl };
  const encodedHeader = base64UrlEncode(utf8Encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(utf8Encode(JSON.stringify(body)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8Encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyJwt(token, secret, { now = Date.now() } = {}) {
  if (!secret || typeof secret !== 'string') return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  let header;
  try {
    header = JSON.parse(utf8Decode(base64UrlDecode(encodedHeader)));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256') return null;

  const expected = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8Encode(`${encodedHeader}.${encodedPayload}`));
  if (!timingSafeEqual(new Uint8Array(expected), base64UrlDecode(signature))) return null;

  let payload;
  try {
    payload = JSON.parse(utf8Decode(base64UrlDecode(encodedPayload)));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  if (typeof payload.uid !== 'string' || typeof payload.username !== 'string') return null;

  return payload;
}

export function assertJwtSecret(secret) {
  if (!secret || typeof secret !== 'string' || secret.length < JWT_SECRET_MIN_LENGTH) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '云同步未配置：JWT_SECRET 缺失或过短（至少 32 字符）');
  }
}

// ---------------------------------------------------------------------------
// PBKDF2 密码哈希（随机盐，迭代次数可配）
// ---------------------------------------------------------------------------

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function pbkdf2Iterations(env) {
  const raw = Number(env?.PBKDF2_ITERATIONS);
  if (!Number.isFinite(raw) || raw < 1000) return PBKDF2_ITERATIONS_DEFAULT;
  return Math.floor(raw);
}

export async function hashPassword(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8Encode(saltHex), iterations },
    key,
    PBKDF2_KEY_LENGTH
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createPasswordRecord(password, env) {
  const salt = randomHex(SALT_BYTES);
  const iterations = pbkdf2Iterations(env);
  const hash = await hashPassword(password, salt, iterations);
  return { salt, iterations, hash };
}

export async function verifyPassword(password, saltHex, iterations, expectedHash) {
  const actual = await hashPassword(password, saltHex, iterations);
  return timingSafeEqual(actual, expectedHash);
}

// ---------------------------------------------------------------------------
// 登录失败限速（内存 Map，按 用户名|IP；Worker 实例级，尽力而为）
// ---------------------------------------------------------------------------

export function createLoginLimiter({ windowMs = 15 * 60 * 1000, maxAttempts = 10, now = () => Date.now() } = {}) {
  const attempts = new Map(); // key -> { count, resetAt }

  function prune() {
    const timestamp = now();
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= timestamp) attempts.delete(key);
    }
  }

  return {
    check(key) {
      prune();
      const entry = attempts.get(key);
      if (!entry) return { allowed: true, remaining: maxAttempts, retryAfterSeconds: 0 };
      if (entry.resetAt <= now()) {
        attempts.delete(key);
        return { allowed: true, remaining: maxAttempts, retryAfterSeconds: 0 };
      }
      if (entry.count >= maxAttempts) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)),
        };
      }
      return { allowed: true, remaining: maxAttempts - entry.count, retryAfterSeconds: 0 };
    },
    record(key) {
      const timestamp = now();
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= timestamp) {
        attempts.set(key, { count: 1, resetAt: timestamp + windowMs });
      } else {
        entry.count += 1;
      }
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// 请求侧辅助
// ---------------------------------------------------------------------------

export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export async function requireUser(request, env) {
  assertJwtSecret(env?.JWT_SECRET);
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, 'UNAUTHORIZED', '缺少访问令牌');
  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload) throw new ApiError(401, 'UNAUTHORIZED', '访问令牌无效或已过期');
  return payload;
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export function issueUserToken(user, env) {
  assertJwtSecret(env?.JWT_SECRET);
  return signJwt({ uid: user.id, username: user.username }, env.JWT_SECRET);
}
