// Microsoft Graph → SharePoint 文档库音频存储（Sites.Selected 场景）。
// 未配置 SHAREPOINT_* 环境变量时优雅降级：音频仅本地，歌词/配置仍同步。

import { ApiError } from './http.js';
import { getDataverseToken } from './dataverse.js';

const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB 上限，防止滥用

// Graph token 独立于 Dataverse token 缓存（scope 不同）
let cachedGraphToken = null; // { token, expiresAt }

export function sharepointConfig(env) {
  return {
    tenantId: env?.DATAVERSE_TENANT_ID,
    clientId: env?.DATAVERSE_CLIENT_ID,
    clientSecret: env?.DATAVERSE_CLIENT_SECRET,
    siteId: env?.SHAREPOINT_SITE_ID,
    driveId: env?.SHAREPOINT_DRIVE_ID,
  };
}

export function isSharePointConfigured(env) {
  const config = sharepointConfig(env);
  return Boolean(config.tenantId && config.clientId && config.clientSecret && config.siteId && config.driveId);
}

export function assertSharePointConfigured(env) {
  if (!isSharePointConfigured(env)) {
    throw new ApiError(501, 'AUDIO_NOT_CONFIGURED', '音频云同步未配置：缺少 SHAREPOINT_* 环境变量（歌词/配置同步不受影响）');
  }
}

async function getGraphToken(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const config = sharepointConfig(env);
  if (!config.tenantId || !config.clientId || !config.clientSecret) {
    throw new ApiError(503, 'CLOUD_NOT_CONFIGURED', '云同步未配置：缺少 Dataverse 环境变量');
  }

  if (cachedGraphToken && cachedGraphToken.expiresAt > now() + TOKEN_EXPIRY_MARGIN_MS) {
    return cachedGraphToken.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new ApiError(502, 'CLOUD_AUTH_FAILED', `Graph 服务主体认证失败（${response.status}）`, { 'Retry-After': '5' });
  }

  const data = await response.json();
  cachedGraphToken = { token: data.access_token, expiresAt: now() + Number(data.expires_in || 3600) * 1000 };
  return data.access_token;
}

export function resetGraphTokenCache() {
  cachedGraphToken = null;
}

function itemPath(env, userId, songId) {
  const config = sharepointConfig(env);
  return `https://graph.microsoft.com/v1.0/sites/${config.siteId}/drives/${config.driveId}/root:/Songs/${encodeURIComponent(userId)}/${encodeURIComponent(songId)}:/content`;
}

async function graphRequest(env, method, url, { body, contentType, fetchImpl = fetch } = {}) {
  const token = await getGraphToken(env, { fetchImpl });
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && contentType ? { 'Content-Type': contentType } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  return response;
}

// 上传音频：body 为 ArrayBuffer / string（base64 已在 cloud.js 解码）或流式 Body
export async function putAudio(env, userId, songId, body, contentType, { fetchImpl = fetch } = {}) {
  assertSharePointConfigured(env);
  if (!contentType) throw new ApiError(400, 'BAD_REQUEST', '缺少音频 Content-Type');

  const size = body instanceof ArrayBuffer ? body.byteLength : typeof body === 'string' ? body.length : body?.size;
  if (typeof size === 'number' && size > MAX_AUDIO_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `音频过大（${size} 字节，上限 ${MAX_AUDIO_BYTES}）`);
  }

  const response = await graphRequest(env, 'PUT', itemPath(env, userId, songId), { body, contentType, fetchImpl });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(502, 'CLOUD_REQUEST_FAILED', `音频上传失败（${response.status}）：${text.slice(0, 300)}`);
  }
  return response.json().catch(() => null);
}

// 下载音频：返回 Response（流式透传给客户端）
export async function getAudio(env, userId, songId, { fetchImpl = fetch } = {}) {
  assertSharePointConfigured(env);
  const response = await graphRequest(env, 'GET', itemPath(env, userId, songId), { fetchImpl });
  if (response.status === 404) {
    throw new ApiError(404, 'AUDIO_NOT_FOUND', '云端不存在该音频文件');
  }
  if (!response.ok) {
    throw new ApiError(502, 'CLOUD_REQUEST_FAILED', `音频下载失败（${response.status}）`);
  }
  return response;
}

export async function deleteAudio(env, userId, songId, { fetchImpl = fetch } = {}) {
  assertSharePointConfigured(env);
  const response = await graphRequest(env, 'DELETE', itemPath(env, userId, songId), { fetchImpl });
  if (response.status === 404) return false; // 已不存在视为成功
  if (!response.ok) {
    throw new ApiError(502, 'CLOUD_REQUEST_FAILED', `音频删除失败（${response.status}）`);
  }
  return true;
}
