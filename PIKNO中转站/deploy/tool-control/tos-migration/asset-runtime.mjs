import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { isAssetPath } from '../protocol.mjs';

export const ASSET_RELEASE_SHA256 = 'd9727a639745c53050c85ac9fdaa85298360d4613a652b4496c9d66b0c09b63f';
export const ASSET_RELEASE_PATH = new URL('../worker-candidate.mjs', import.meta.url);

export function createUploadLimiter({ maximumUsers = 10000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maximumUsers) || maximumUsers < 1 || maximumUsers > 100000 || typeof now !== 'function') throw Error('Invalid upload limiter configuration');
  const counts = new Map();
  let currentWindow = -1;
  return {
    limit({ key } = {}) {
      const time = now();
      if (typeof key !== 'string' || !/^[1-9]\d{0,15}$/.test(key) || !Number.isSafeInteger(Number(key)) || !Number.isSafeInteger(time) || time < 0) return { success: false };
      const window = Math.floor(time / 60000);
      // A clock rollback must not reset an active account's quota.
      if (window < currentWindow) return { success: false };
      if (window > currentWindow) { counts.clear(); currentWindow = window; }
      const count = counts.get(key);
      // Refuse a new account if full; never evict a live quota to admit it.
      if (count === undefined && counts.size >= maximumUsers || count >= 60) return { success: false };
      counts.set(key, (count || 0) + 1);
      return { success: true };
    },
  };
}

export async function loadAssetRuntime({ releasePath = ASSET_RELEASE_PATH } = {}) {
  const source = await readFile(releasePath);
  if (createHash('sha256').update(source).digest('hex') !== ASSET_RELEASE_SHA256) throw Error('Pinned asset release digest mismatch');
  const code = source.toString('utf8');
  const exportPattern = /export\s*\{\s*worker_default as default\s*\};/;
  if (!exportPattern.test(code)) throw Error('Pinned asset release export mismatch');
  // Compatibility context for trusted pinned code, not an untrusted-code sandbox.
  // Assets require no upstream calls. Control routes and their secrets stay absent.
  const context = vm.createContext({ URL, Request, Response, Headers, TextEncoder, TextDecoder,
    Uint8Array, ArrayBuffer, ReadableStream, TransformStream, crypto: webcrypto, AbortSignal, atob, btoa,
    fetch() { throw Error('Asset upstream calls rejected'); } });
  new vm.Script(code.replace(exportPattern, 'globalThis.pinnedAssetWorker = worker_default;'), { filename: 'pinned-asset-release.js' }).runInContext(context);
  return {
    fetch(request, env) {
      if (!isAssetPath(new URL(request.url).pathname)) return Promise.resolve(new Response(null, { status: 404 }));
      return context.pinnedAssetWorker.fetch(request, { MEDIA: env.MEDIA, TICKET_KEY: env.TICKET_KEY, UPLOAD_LIMITER: env.UPLOAD_LIMITER });
    },
  };
}
