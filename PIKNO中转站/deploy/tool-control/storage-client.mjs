import { STORE_PREFIX, META_HEADER, OPTIONS_HEADER, keyLimit, encodeHeader, decodeHeader, validateOptions } from './protocol.mjs';

export function createStorageClient({ origin, secret, fetchImpl = fetch, allowLoopback = false }) {
  const base = new URL(origin);
  const local = allowLoopback && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!local && (base.protocol !== 'https:' || base.port)) || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !/^[A-Za-z0-9_-]{32,128}$/.test(secret || '')) throw Error('Invalid storage endpoint');
  async function operation(method, key, body, options) {
    if (!keyLimit(key)) throw Error('Storage key rejected');
    const headers = new Headers({ authorization: 'Bearer ' + secret });
    if (method === 'PUT') {
      validateOptions(options || {});
      headers.set(OPTIONS_HEADER, encodeHeader(options || {}));
      body = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      if (!(body instanceof Uint8Array) || !body.byteLength || body.byteLength > keyLimit(key)) throw Error('Storage body rejected');
      headers.set('content-length', String(body.byteLength));
    }
    if (method === 'GET' && options?.range) {
      const { offset, length } = options.range;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > keyLimit(key)) throw Error('Storage range rejected');
      headers.set('range', `bytes=${offset}-${offset + length - 1}`);
    }
    // Deliberately one network attempt, including writes whose response is lost.
    const response = await fetchImpl(new URL(STORE_PREFIX + key, base), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(180000) });
    if (response.status === 404 && ['GET', 'HEAD'].includes(method) || response.status === 412 && method === 'PUT') { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw Error('Storage response uncertain'); }
    if (method === 'DELETE') { await response.body?.cancel(); return; }
    const meta = decodeHeader(response.headers.get(META_HEADER));
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > keyLimit(key) || typeof meta.etag !== 'string' || !meta.etag) { await response.body?.cancel(); throw Error('Invalid storage response'); }
    return { ...meta, body: response.body, arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: () => response.json() };
  }
  return { head: (key) => operation('HEAD', key), get: (key, options) => operation('GET', key, undefined, options), put: (key, body, options) => operation('PUT', key, body, options), delete: (key) => operation('DELETE', key) };
}
