import released from '../release/worker-release.js';
import { isControlPath, isAssetPath } from '../control-migration/protocol.mjs';
import { createRemoteStorage } from '../../../deploy/tool-control/tos-migration/proxy.mjs';

const unavailable = () => Response.json({ error: 'CONTROL_UNAVAILABLE' }, {
  status: 503, headers: { 'Cache-Control': 'no-store' },
});

export function createTosMigrationWorker(assetWorker, { fetchImpl = fetch, storageFactory = createRemoteStorage } = {}) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      // The retired R2 storage bridge is never reachable in this candidate.
      if (url.pathname.startsWith('/__control-store/v1/')) return new Response(null, { status: 404 });
      if (isControlPath(url.pathname)) {
        // ECS remains the only control executor; there is no Cloudflare fallback.
        if (env.CONTROL_OWNER !== 'ecs') return unavailable();
        let target;
        try {
          target = new URL(env.CONTROL_ORIGIN);
          if (target.protocol !== 'https:' || target.username || target.password || target.port || target.pathname !== '/' || target.search || target.hash || !env.CONTROL_ORIGIN_HOST || target.hostname !== env.CONTROL_ORIGIN_HOST || ['www.piknoai.com', 'media.piknoai.com'].includes(target.hostname)) return unavailable();
        } catch { return unavailable(); }
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
      if (!isAssetPath(url.pathname)) return new Response(null, { status: 404 });
      const media = storageFactory({ origin: env.TOS_STORAGE_PROXY_ORIGIN, namespace: 'pikno-relay-inputs', secret: env.TOS_STORAGE_PROXY_SECRET });
      const bindings = { ...env, MEDIA: env.TOS_STORAGE_READ_ONLY === 'true' ? readOnly(media) : media };
      return assetWorker.fetch(request, bindings, context);
    },
  };
}

function readOnly(storage) {
  const reject = () => { throw Error('Storage writes blocked for migration'); };
  return { ...storage, put: reject, delete: reject };
}

export default createTosMigrationWorker(released);
