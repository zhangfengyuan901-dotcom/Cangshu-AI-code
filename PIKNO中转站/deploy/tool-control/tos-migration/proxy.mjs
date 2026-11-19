export const STORAGE_PATH = '/media/v1/storage-tos/';
const namespaces = new Set(['pikno-relay-inputs', 'hamster-ai-media', 'hamster-billing-results']);
const methods = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'POST']);
const tokenValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keyValid = key => typeof key === 'string' && key.length <= 256 && key.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part));
const optionHeader = 'x-pikno-storage-options';
const metadataHeader = 'x-pikno-storage-metadata';
const conditionHeaders = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];
const httpHeaders = { contentType: 'content-type', contentDisposition: 'content-disposition', cacheControl: 'cache-control' };
const encode = value => encodeURIComponent(JSON.stringify(value));
function decode(value) {
  if (!value || value.length > 8192) throw Error('Storage envelope rejected');
  return JSON.parse(decodeURIComponent(value));
}

function objectResult(meta, response) {
  if (!meta || !Number.isSafeInteger(meta.size) || meta.size < 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(meta.etag) ||
      !meta.httpMetadata || !meta.customMetadata) throw Error('Storage metadata rejected');
  return {
    ...meta,
    httpEtag: `"${meta.etag}"`,
    writeHttpMetadata(headers) {
      for (const [field, value] of Object.entries(meta.httpMetadata)) {
        if (Object.hasOwn(httpHeaders, field)) headers.set(httpHeaders[field], value);
      }
    },
    ...(response ? { body: response.body, arrayBuffer: () => response.arrayBuffer(),
      text: () => response.text(), json: () => response.json() } : {}),
  };
}

export function createRemoteStorage({ origin, namespace, secret, fetchImpl = fetch }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' ||
      base.search || base.hash || !namespaces.has(namespace) || !tokenValid(secret)) throw Error('Storage proxy configuration rejected');
  async function operation(method, key, body, options) {
    if (method !== 'POST' && !keyValid(key)) throw Error('Storage key rejected');
    const headers = new Headers({ authorization: 'Bearer ' + secret });
    if (method === 'PUT') headers.set(optionHeader, encode(options ?? {}));
    if (method === 'GET' && options !== undefined) {
      if (!options || Object.keys(options).some(name => !['range', 'onlyIf'].includes(name))) throw Error('Storage read options rejected');
      if (options.range instanceof Headers) {
        if (options.range.has('range')) headers.set('range', options.range.get('range'));
      } else if (options.range !== undefined) headers.set(optionHeader, encode({ range: options.range }));
      if (options.onlyIf !== undefined) {
        if (!(options.onlyIf instanceof Headers)) throw Error('Storage condition rejected');
        for (const name of conditionHeaders) if (options.onlyIf.has(name)) headers.set(name, options.onlyIf.get(name));
      }
    }
    if (method === 'POST') headers.set('content-type', 'application/json');
    const url = new URL(`${STORAGE_PATH}${namespace}/${key}`, base);
    const response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(180000),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
    if (response.status === 404 && (method === 'GET' || method === 'HEAD') || response.status === 412 && method === 'PUT') {
      await response.body?.cancel();
      return null;
    }
    if ((method === 'POST' || method === 'DELETE') && response.status === 204) return;
    if (response.status !== 200 && !(method === 'GET' && response.status === 304)) {
      await response.body?.cancel();
      throw Error('Storage response uncertain');
    }
    try {
      return objectResult(decode(response.headers.get(metadataHeader)), method === 'GET' && response.status === 200 ? response : null);
    } catch {
      await response.body?.cancel();
      throw Error('Storage response uncertain');
    }
  }
  return {
    get: (key, options) => operation('GET', key, undefined, options),
    head: key => operation('HEAD', key),
    put: (key, body, options) => operation('PUT', key, body, options),
    delete(key) {
      if (!Array.isArray(key)) return operation('DELETE', key);
      if (namespace === 'pikno-relay-inputs' || key.length > (namespace === 'hamster-ai-media' ? 1000 : 100) || !key.every(keyValid)) throw Error('Storage delete batch rejected');
      return operation('POST', '', JSON.stringify(key));
    },
  };
}

const reply = (status, headers = {}) => new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
const encoder = new TextEncoder();
async function authorized(request, secret) {
  const supplied = request.headers.get('authorization') ?? '';
  if (!/^Bearer [a-f0-9]{64}$/.test(supplied)) return false;
  const [actual, expected] = await Promise.all([supplied, 'Bearer ' + secret].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

async function batchKeys(request, namespace) {
  const count = namespace === 'hamster-ai-media' ? 1000 : namespace === 'hamster-billing-results' ? 100 : 0;
  if (!count || !request.body) throw Error('Storage batch rejected');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let raw = '', size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > count * 260 + 2) throw Error('Storage batch too large');
      raw += decoder.decode(item.value, { stream: true });
    }
    const keys = JSON.parse(raw + decoder.decode());
    if (!Array.isArray(keys) || keys.length > count || !keys.every(keyValid)) throw Error('Storage batch rejected');
    return keys;
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally { reader.releaseLock(); }
}

export function createStorageHandler({ stores, readOnly = false }) {
  const names = Object.keys(stores);
  if (names.some(name => !namespaces.has(name) || !tokenValid(stores[name].secret)) ||
      new Set(names.map(name => stores[name].secret)).size !== names.length) throw Error('Storage proxy configuration rejected');
  return async function storage(request) {
    const url = new URL(request.url);
    if (url.search || !url.pathname.startsWith(STORAGE_PATH) || request.headers.has('origin')) return reply(404);
    const [namespace, ...parts] = url.pathname.slice(STORAGE_PATH.length).split('/');
    if (!Object.hasOwn(stores, namespace)) return reply(404);
    const { secret, storage } = stores[namespace];
    if (!await authorized(request, secret)) return reply(403);
    const method = request.method, key = parts.join('/');
    if (!methods.has(method) || (method === 'POST' ? key !== '' : !keyValid(key))) return reply(400);
    if (request.headers.has('content-encoding')) return reply(400);
    try {
      if (['PUT', 'POST', 'DELETE'].includes(method) && (typeof readOnly === 'function' ? await readOnly() : readOnly)) return reply(503);
      let object;
      if (method === 'POST' || method === 'DELETE') {
        await storage.delete(method === 'POST' ? await batchKeys(request, namespace) : key);
        return reply(204);
      }
      const encoded = request.headers.get(optionHeader);
      if (method === 'PUT') {
        if (!request.body) return reply(400);
        const rawLength = request.headers.get('content-length');
        if (rawLength !== null && !/^\d+$/.test(rawLength)) return reply(400);
        object = await storage.put(key, request.body, encoded ? decode(encoded) : {},
          rawLength === null ? undefined : { expectedLength: Number(rawLength) });
      } else if (method === 'GET') {
        const options = encoded ? decode(encoded) : {};
        if (!options || Array.isArray(options) || Object.keys(options).some(field => field !== 'range')) return reply(400);
        if (request.headers.has('range')) {
          if (options.range !== undefined) return reply(400);
          options.range = request.headers;
        }
        if (conditionHeaders.some(name => request.headers.has(name))) options.onlyIf = request.headers;
        object = await storage.get(key, Object.keys(options).length ? options : undefined);
      } else object = await storage.head(key);
      if (!object) return reply(method === 'PUT' ? 412 : 404);
      const { size, etag, httpMetadata, customMetadata, range } = object;
      const headers = { 'cache-control': 'no-store', [metadataHeader]: encode({ size, etag, httpMetadata, customMetadata, range }) };
      if (method !== 'GET') return reply(200, headers);
      if (!('body' in object)) return reply(304, headers);
      return new Response(object.body, { status: 200, headers });
    } catch { return reply(502); }
  };
}
