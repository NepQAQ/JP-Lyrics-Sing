// Dataverse Web API 客户端：client credentials 换 token（缓存至过期）+ OData CRUD。
// Worker 以服务主体直连 Dataverse，最终用户无需微软账号。

import { ApiError } from './http.js';

const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000; // 提前 60 秒刷新
const LYRIC_JSON_MAX_CHARS = 1048576; // Dataverse 多行文本列上限

// 模块级 token 缓存（每个 Worker 实例一份，直至过期）
let cachedToken = null; // { token, expiresAt }

export function dataverseConfig(env) {
  return {
    tenantId: env?.DATAVERSE_TENANT_ID,
    envUrl: env?.DATAVERSE_ENV_URL, // API 根，如 https://org.api.crm.dynamics.com
    clientId: env?.DATAVERSE_CLIENT_ID,
    clientSecret: env?.DATAVERSE_CLIENT_SECRET,
    prefix: env?.DATAVERSE_PREFIX || 'jls',
  };
}

export function isDataverseConfigured(env) {
  const config = dataverseConfig(env);
  return Boolean(config.tenantId && config.envUrl && config.clientId && config.clientSecret);
}

export function assertDataverseConfigured(env) {
  if (!isDataverseConfigured(env)) {
    throw new ApiError(503, 'CLOUD_NOT_CONFIGURED', '云同步未配置：缺少 Dataverse 环境变量');
  }
}

export function assertLyricSize(text) {
  if (typeof text === 'string' && text.length > LYRIC_JSON_MAX_CHARS) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `歌词数据过大（${text.length} 字符，上限 ${LYRIC_JSON_MAX_CHARS}）`);
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.0 client credentials
// ---------------------------------------------------------------------------

export async function getDataverseToken(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const config = dataverseConfig(env);
  assertDataverseConfigured(env);

  if (cachedToken && cachedToken.expiresAt > now() + TOKEN_EXPIRY_MARGIN_MS) {
    return cachedToken.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const scope = `${config.envUrl.replace(/\/+$/, '')}/.default`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope,
  });

  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(502, 'CLOUD_AUTH_FAILED', `Dataverse 服务主体认证失败（${response.status}）`, { 'Retry-After': '5' });
  }

  const data = await response.json();
  const expiresInMs = Number(data.expires_in || 3600) * 1000;
  cachedToken = { token: data.access_token, expiresAt: now() + expiresInMs };
  return data.access_token;
}

// 测试辅助：清空模块级 token 缓存
export function resetDataverseTokenCache() {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Web API 请求封装
// ---------------------------------------------------------------------------

function odataQuote(value) {
  return String(value).replace(/'/g, "''");
}

function apiRoot(env) {
  return `${dataverseConfig(env).envUrl.replace(/\/+$/, '')}/api/data/v9.2`;
}

function logicalName(env, table) {
  const prefix = dataverseConfig(env).prefix;
  return table.startsWith(prefix + '_') ? table : `${prefix}_${table}`;
}

function setName(env, table) {
  return `${logicalName(env, table)}s`;
}

async function dvRequest(env, method, path, { body, contentType = 'application/json', fetchImpl = fetch, retryOn401 = true } = {}) {
  assertDataverseConfigured(env);
  const token = await getDataverseToken(env, { fetchImpl });
  const url = path.startsWith('http') ? path : `${apiRoot(env)}${path}`;

  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...(body !== undefined ? { 'Content-Type': contentType } : {}),
      ...(method === 'POST' ? { Prefer: 'return=representation' } : {}),
    },
    ...(body !== undefined ? { body: body instanceof ArrayBuffer || typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

  // token 过期兜底：强制刷新一次
  if (response.status === 401 && retryOn401) {
    resetDataverseTokenCache();
    return dvRequest(env, method, path, { body, contentType, fetchImpl, retryOn401: false });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || detail;
    } catch {
      // 保留原始文本
    }
    throw new ApiError(502, 'CLOUD_REQUEST_FAILED', `Dataverse 请求失败（${response.status}）：${detail}`);
  }

  if (response.status === 204 || response.headers.get('Content-Length') === '0') return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 查询列表（自动分页）
export async function dvQueryAll(env, table, { filter, select, orderBy, top, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams();
  if (filter) params.set('$filter', filter);
  if (select?.length) params.set('$select', select.join(','));
  if (orderBy) params.set('$orderby', orderBy);
  if (top) params.set('$top', String(top));

  const results = [];
  let nextUrl = `${apiRoot(env)}/${setName(env, table)}?${params.toString()}`;
  let guard = 0;

  while (nextUrl && guard < 20) {
    const page = await dvRequest(env, 'GET', nextUrl, { fetchImpl });
    if (Array.isArray(page?.value)) results.push(...page.value);
    nextUrl = page?.['@odata.nextLink'] || null;
    guard += 1;
  }

  return results;
}

export async function dvQueryOne(env, table, { filter, select, fetchImpl = fetch }) {
  const rows = await dvQueryAll(env, table, { filter, select, top: 2, fetchImpl });
  return rows.length ? rows[0] : null;
}

export async function dvCreate(env, table, data, { fetchImpl = fetch } = {}) {
  return dvRequest(env, 'POST', `/${setName(env, table)}`, { body: data, fetchImpl });
}

export async function dvUpdate(env, table, id, data, { fetchImpl = fetch } = {}) {
  return dvRequest(env, 'PATCH', `/${setName(env, table)}(${id})`, { body: data, fetchImpl });
}

export async function dvDelete(env, table, id, { fetchImpl = fetch } = {}) {
  return dvRequest(env, 'DELETE', `/${setName(env, table)}(${id})`, { fetchImpl });
}

// 供脚本/测试使用的底层请求
export { dvRequest, logicalName, setName, odataQuote, apiRoot };
