import { STORE_PREFIX, META_HEADER, OPTIONS_HEADER, keyLimit, encodeHeader, decodeHeader, validateOptions, sameSecret, storageSecretValid } from './protocol.mjs';

const reply = (status, code) => Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
const metadata = (object) => ({ size: object.size, etag: object.etag, httpMetadata: object.httpMetadata || {}, customMetadata: object.customMetadata || {} });

export async function storage(request, env) {
  // State storage remains R2; no scheduling, provider calls, or credential decryption.
  // Remains enabled while control ingress is blocked so already accepted work can drain.
  if (env.CONTROL_STORAGE_ENABLED !== 'true' || !storageSecretValid(env)) return reply(503, 'STORE_UNAVAILABLE');
  const url = new URL(request.url);
  if (request.headers.has('origin') || url.search || !await sameSecret(request.headers.get('authorization') || '', 'Bearer ' + env.TOOL_STORE_SECRET)) return reply(403, 'STORE_FORBIDDEN');
  const key = url.pathname.slice(STORE_PREFIX.length), limit = keyLimit(key);
  if (!url.pathname.startsWith(STORE_PREFIX) || !limit) return reply(404, 'STORE_NOT_FOUND');
  if (!['GET', 'HEAD', 'PUT', 'DELETE'].includes(request.method)) return reply(405, 'STORE_METHOD_REJECTED');
  try {
    if (request.method === 'DELETE') {
      if (!key.startsWith('tool-polls/') && !/^tool-config\/versions\/[a-f0-9]{32}$/.test(key)) return reply(405, 'STORE_METHOD_REJECTED');
      await env.MEDIA.delete(key);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    let object;
    if (request.method === 'PUT') {
      const rawLength = request.headers.get('content-length');
      const length = Number(rawLength);
      if (!rawLength || !/^\d+$/.test(rawLength) || !Number.isSafeInteger(length) || length < 1 || length > limit || request.headers.has('content-encoding') || !request.body) return reply(413, 'STORE_SIZE_REJECTED');
      const options = validateOptions(decodeHeader(request.headers.get(OPTIONS_HEADER)));
      // Keep the original R2 CAS atomic. Never retry an uncertain PUT or DELETE.
      object = await env.MEDIA.put(key, request.body, options);
      if (!object) return reply(412, 'STORE_CONDITION_FAILED');
    } else {
      let options;
      const rawRange = request.headers.get('range');
      if (rawRange) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(rawRange);
        const first = Number(match?.[1]), last = Number(match?.[2]);
        if (!match || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last >= limit || request.method !== 'GET') return reply(416, 'STORE_RANGE_REJECTED');
        options = { range: { offset: first, length: last - first + 1 } };
      }
      object = await env.MEDIA[request.method === 'HEAD' ? 'head' : 'get'](key, options);
      if (!object) return reply(404, 'STORE_NOT_FOUND');
    }
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', [META_HEADER]: encodeHeader(metadata(object)) };
    return new Response(request.method === 'GET' ? object.body : null, { headers });
  } catch {
    return reply(502, 'STORE_UNCERTAIN');
  }
}
