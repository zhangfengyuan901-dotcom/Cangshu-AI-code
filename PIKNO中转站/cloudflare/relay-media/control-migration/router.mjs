import { STORE_PREFIX, isControlPath, isAssetPath } from './protocol.mjs';
import { storage } from './storage.mjs';

const unavailable = () => Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });

export function createMigrationWorker(released, { fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname.startsWith(STORE_PREFIX)) return storage(request, env);
      if (isControlPath(url.pathname)) {
        // Fail closed by default. Never execute the old control runtime in ECS mode.
        if (env.CONTROL_OWNER === 'cloudflare') return released.fetch(request, env, context);
        if (env.CONTROL_OWNER !== 'ecs') return unavailable();
        let target;
        try {
          target = new URL(env.CONTROL_ORIGIN);
          if (target.protocol !== 'https:' || target.username || target.password || target.port || target.pathname !== '/' || target.search || target.hash || !env.CONTROL_ORIGIN_HOST || target.hostname !== env.CONTROL_ORIGIN_HOST || ['www.piknoai.com', 'media.piknoai.com'].includes(target.hostname)) return unavailable();
        } catch { return unavailable(); }
        // Only the configured private ingress receives these original credentials.
        const headers = new Headers();
        for (const name of ['authorization', 'content-type', 'content-length', 'origin', 'range', 'x-pikno-edge-ticket']) {
          if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        }
        target.pathname = url.pathname;
        target.search = url.search;
        try {
          const response = await fetchImpl(target.href, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
          if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unavailable(); }
          return response;
        } catch { return unavailable(); }
      }
      if (isAssetPath(url.pathname)) return released.fetch(request, env, context);
      return new Response(null, { status: 404 });
    },
  };
}
