// Worker 内共享的 HTTP / CORS / 错误处理工具。
// 代理路由与云同步路由（auth / cloud）共用，行为与原先 index.js 内联版本一致；
// 云同步路由通过 opts 放宽方法与请求头（POST / PUT / DELETE + Authorization）。

export class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

// 代理路由的 CORS（只读 GET）与云同步路由的 CORS（含写方法与 Authorization）
export const PROXY_CORS = {
  methods: 'GET, OPTIONS',
  allowHeaders: 'Content-Type',
  exposeHeaders: 'X-Cache',
};

export const CLOUD_CORS = {
  methods: 'GET, POST, PUT, DELETE, OPTIONS',
  allowHeaders: 'Content-Type, Authorization',
};

export function errorResponse(error, request, env, { cors = PROXY_CORS, internalMessage = '歌词服务暂时不可用' } = {}) {
  if (error instanceof ApiError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      { status: error.status, request, env, headers: error.headers, cors }
    );
  }

  console.error('[jp-lyrics-proxy]', error);
  return jsonResponse(
    { error: { code: 'INTERNAL_ERROR', message: internalMessage } },
    { status: 500, request, env, cors }
  );
}

export function jsonResponse(data, { status = 200, request, env, cacheControl = 'no-store', headers = {}, cors = PROXY_CORS } = {}) {
  const responseHeaders = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(request, env, cors),
  });

  for (const [key, value] of Object.entries(headers)) {
    responseHeaders.set(key, value);
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

export function corsHeaders(request, env, opts = PROXY_CORS) {
  const origin = request?.headers?.get('Origin');
  if (!origin || !isAllowedOrigin(origin, env)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': opts.methods,
    'Access-Control-Allow-Headers': opts.allowHeaders,
    'Access-Control-Max-Age': '86400',
    ...(opts.exposeHeaders ? { 'Access-Control-Expose-Headers': opts.exposeHeaders } : {}),
    'Vary': 'Origin',
  };
}

export function isAllowedOrigin(origin, env) {
  if (typeof origin !== 'string' || !origin) return false;
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) return true;

  const allowed = String(env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return allowed.includes(origin);
}

export function normalizePath(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '');
  return path || '/';
}
