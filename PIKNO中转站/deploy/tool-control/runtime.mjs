import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { isControlPath } from './protocol.mjs';

export const RELEASE_SHA256 = 'd9727a639745c53050c85ac9fdaa85298360d4613a652b4496c9d66b0c09b63f';
export const RELEASE_PATH = new URL('./worker-candidate.mjs', import.meta.url);
const lengths = new WeakMap();

class FixedLengthStream extends TransformStream {
  constructor(length) {
    if (!Number.isSafeInteger(length) || length < 0) throw Error('Invalid stream length');
    let count = 0;
    super({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > length) throw Error('Stream length mismatch');
        controller.enqueue(chunk);
      },
      flush() { if (count !== length) throw Error('Stream length mismatch'); },
    });
    lengths.set(this.readable, length);
  }
}

export function allowedUpstream(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const host = url.hostname.replace(/\.$/, '');
  if (host === 'www.runninghub.cn') return ['/uc/openapi/accountStatus', '/openapi/v2/query', '/openapi/v2/media/upload/binary', '/openapi/v2/run/ai-app/2087890031699648513', '/openapi/v2/run/ai-app/2089021172049596418'].includes(url.pathname) && !url.search;
  if (host === 'cf.api.fan') return ['/v1/images/generations', '/v1/images/edits'].includes(url.pathname) && !url.search;
  if (host === 'external-resources.packyapi.ai') return /^\/file_download\/[A-Za-z0-9_-]+$/.test(url.pathname);
  return ['rh-images-1252422369.cos.ap-beijing.myqcloud.com', 'rh-comfyui01.tos-cn-beijing.volces.com'].includes(host);
}

export async function loadRuntime({ releasePath = RELEASE_PATH, fetchImpl = fetch } = {}) {
  const source = await readFile(releasePath);
  if (createHash('sha256').update(source).digest('hex') !== RELEASE_SHA256) throw Error('Pinned release digest mismatch');
  const code = source.toString('utf8');
  const exportPattern = /export\s*\{\s*worker_default as default\s*\};/;
  if (!exportPattern.test(code)) throw Error('Pinned release export mismatch');
  const safeFetch = (input, options = {}) => {
    if (!allowedUpstream(String(input))) throw Error('Upstream rejected');
    const headers = new Headers(options.headers);
    const length = lengths.get(options.body);
    if (length !== undefined) headers.set('content-length', String(length));
    return fetchImpl(input, { ...options, headers, redirect: 'manual', ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}) });
  };
  // This is a compatibility context for trusted pinned code, not an untrusted-code sandbox.
  const context = vm.createContext({ URL, Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, ReadableStream, TransformStream, FixedLengthStream, crypto: webcrypto, AbortSignal, atob, btoa, fetch: safeFetch });
  new vm.Script(code.replace(exportPattern, 'globalThis.pinnedWorker = worker_default;'), { filename: 'pinned-worker-release.js' }).runInContext(context);
  return {
    fetch(request, env) {
      if (!isControlPath(new URL(request.url).pathname)) return Promise.resolve(new Response(null, { status: 404 }));
      return context.pinnedWorker.fetch(request, env);
    },
  };
}
