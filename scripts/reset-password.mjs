#!/usr/bin/env node
/**
 * 管理员重置云同步账号密码：生成新的 PBKDF2 哈希并更新 {prefix}_user 行。
 * 哈希格式与 Worker（worker/src/auth.js）完全一致：PBKDF2-SHA256、盐为 16 字节 hex、
 * 盐以 UTF-8 字节参与派生、输出 256 位 hex。
 *
 * 用法：
 *   node scripts/reset-password.mjs <用户名> [新密码] [--prefix jls] [--iterations 100000]
 *
 * 新密码省略时随机生成并打印（≥ 12 位）。密码不落盘、不回显。
 *
 * 环境变量（必填）：DATAVERSE_TENANT_ID / DATAVERSE_ENV_URL / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET
 */

import { pbkdf2Sync, randomBytes } from 'node:crypto';

const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flagArgs = process.argv.slice(2).filter((a) => a.startsWith('--'));
function flagValue(name, fallback) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = flagArgs.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return fallback;
}

const PREFIX = String(flagValue('prefix', process.env.DATAVERSE_PREFIX || 'jls')).toLowerCase();
const ITERATIONS = Math.max(1000, Number(flagValue('iterations', process.env.PBKDF2_ITERATIONS || '100000')) || 100000);
const TENANT = process.env.DATAVERSE_TENANT_ID;
const ENV_URL = String(process.env.DATAVERSE_ENV_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.DATAVERSE_CLIENT_ID;
const CLIENT_SECRET = process.env.DATAVERSE_CLIENT_SECRET;

const username = rawArgs[0];
let password = rawArgs[1];

if (!username) {
  console.error('用法：node scripts/reset-password.mjs <用户名> [新密码] [--prefix jls] [--iterations 100000]');
  process.exit(1);
}
if (!TENANT || !ENV_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('缺少环境变量：DATAVERSE_TENANT_ID / DATAVERSE_ENV_URL / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET');
  process.exit(1);
}
if (!password) {
  password = randomBytes(9).toString('base64url'); // 12 位随机密码
  console.log('未提供新密码，已随机生成（见下方，请立即保存）：');
}

const API = `${ENV_URL}/api/data/v9.2`;
const P = PREFIX;

// ---------------------------------------------------------------- Dataverse 访问

async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: `${ENV_URL}/.default`,
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`获取访问令牌失败：${data.error_description || res.status}`);
  return data.access_token;
}

function odataQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function main() {
  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };

  // 查找账号行
  const filter = `${P}_username eq '${odataQuote(username)}'`;
  const query = `/${P}_users?$filter=${encodeURIComponent(filter)}&$select=${P}_userid,${P}_username`;
  const res = await fetch(`${API}${query}`, { headers });
  if (!res.ok) throw new Error(`查询用户失败（${res.status}）：${(await res.text()).slice(0, 300)}`);
  const rows = (await res.json()).value || [];
  if (rows.length === 0) {
    console.error(`用户「${username}」不存在。`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`用户名「${username}」匹配到 ${rows.length} 行（数据异常），请人工处理。`);
    process.exit(1);
  }
  const userId = rows[0][`${P}_userid`];

  // 生成新哈希（与 worker/src/auth.js 格式一致）
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('hex');

  // 更新行
  const patch = await fetch(`${API}/${P}_users(${userId})`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      [`${P}_password_hash`]: hash,
      [`${P}_salt`]: salt,
      [`${P}_iterations`]: ITERATIONS,
    }),
  });
  if (!patch.ok) throw new Error(`更新密码失败（${patch.status}）：${(await patch.text()).slice(0, 300)}`);

  console.log(`已重置用户「${username}」的密码（PBKDF2 迭代 ${ITERATIONS} 次）。`);
  if (rawArgs.length < 2) {
    console.log(`新密码：${password}`);
  }
  console.log('旧令牌在过期前仍然有效；如需立即踢下线，请更换 Worker 的 JWT_SECRET。');
}

main().catch((err) => {
  console.error(`执行失败：${err.message}`);
  process.exit(1);
});
