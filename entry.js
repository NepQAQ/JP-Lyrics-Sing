/**
 * Cloudflare Workers 部署入口（静态资产 + 歌词代理）
 *
 * - /api/* 交给 worker/src/index.js（与独立 Worker 版同一套逻辑）
 * - 其余请求由静态资产服务（public/，见 wrangler.jsonc 的 assets 配置，
 *   run_worker_first 只对 /api/* 生效，正常情况下不会走到这里的 ASSETS 回落）
 */
import proxy from './worker/src/index.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return proxy.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
