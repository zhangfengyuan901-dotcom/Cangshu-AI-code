import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, open, unlink, rmdir, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyLimit, validateOptions } from '../protocol.mjs';

// Native TOS PutObject documents If-Match / If-None-Match and 412 conflicts:
// https://docs.volcengine.com/docs/TorchObjectStorage/PutObject?lang=en
// TOS4 signing (not AWS4):
// https://docs.volcengine.com/docs/6349/74839?lang=en
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const fail = () => { throw Error('TOS storage response uncertain'); };
const validEtag = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const etagValue = (value) => {
  const plain = value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!validEtag(plain)) fail();
  return plain;
};

export function signTosRequest({ method, url, region, accessKeyId, secretAccessKey, headers = {}, body = new Uint8Array(), payloadHash, now = Date.now() }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.search || target.hash ||
      !/^[a-z0-9-]+$/.test(region) || !/^[A-Za-z0-9_-]{1,128}$/.test(accessKeyId) ||
      typeof secretAccessKey !== 'string' || !secretAccessKey || !['GET', 'HEAD', 'PUT', 'DELETE'].includes(method)) throw Error('Invalid TOS signing input');
  const signed = new Headers(headers);
  if (signed.has('authorization')) throw Error('Invalid TOS signing input');
  const date = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  if (payloadHash !== undefined && !/^[a-f0-9]{64}$/.test(payloadHash)) throw Error('Invalid TOS signing input');
  const digest = payloadHash || hash(body);
  signed.set('host', target.host);
  signed.set('x-tos-date', date);
  signed.set('x-tos-content-sha256', digest);
  const entries = [...signed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const names = entries.map(([key]) => key).join(';');
  const canonicalHeaders = entries.map(([key, value]) => `${key}:${value.trim()}\n`).join('');
  const canonical = `${method}\n${target.pathname}\n\n${canonicalHeaders}\n${names}\n${digest}`;
  const scope = `${date.slice(0, 8)}/${region}/tos/request`;
  const stringToSign = `TOS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`;
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, date.slice(0, 8)), region), 'tos'), 'request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  signed.set('authorization', `TOS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names},Signature=${signature}`);
  return signed;
}

async function bodyBytes(body, maximum) {
  let data;
  if (typeof body === 'string') data = Buffer.from(body);
  else if (ArrayBuffer.isView(body)) data = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else if (body instanceof ArrayBuffer) data = Buffer.from(body);
  else if (body && typeof body.getReader === 'function') {
    const reader = body.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!ArrayBuffer.isView(item.value)) throw Error('Invalid TOS upload body');
        length += item.value.byteLength;
        if (length > maximum) throw Error('TOS upload exceeds bound');
        chunks.push(Buffer.from(item.value.buffer, item.value.byteOffset, item.value.byteLength));
      }
      data = Buffer.concat(chunks, length);
    } catch {
      try { await reader.cancel(); } catch {}
      throw Error('TOS upload stream rejected');
    } finally { reader.releaseLock(); }
  } else throw Error('Invalid TOS upload body');
  if (data.byteLength < 1 || data.byteLength > maximum) throw Error('TOS upload exceeds bound');
  // Detach from caller-owned storage before hashing and sending.
  return Buffer.from(data);
}

// Namespace is selected by the authenticated server, never by an object key.
// Policies reproduce the three current Worker contracts and are not arbitrary
// S3 bucket access. Legacy files retain their original relative keys.
const legacyMediaKey = /^(?:tmp|result|media)\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.(?:png|jpg|webp|mp4|webm|mov|mp3|wav|m4a|aac)$/;
const policies = {
  'pikno-relay-inputs': { limit: keyLimit, custom: ['uid', 'expires', 'lease'], http: ['contentType'], batch: 0 },
  'hamster-ai-media': { limit: key => legacyMediaKey.test(key) ? (/\.(?:png|jpg|webp)$/.test(key) ? 30 : 50) * 1024 * 1024 : 0,
    custom: ['expiresAt', 'retention'], http: ['contentType', 'contentDisposition', 'cacheControl'], batch: 1000 },
  'hamster-billing-results': { limit: key => /^input\/user_[a-f0-9]{32}\/asset_[a-f0-9]{32}\.(?:png|jpg|webp|mp4|webm|mov|mp3|wav|m4a|aac)$/.test(key) ? 50 << 20 :
    /^result\/user_[a-f0-9]{32}\/task_[a-f0-9]{32}\.(?:png|mp4)$/.test(key) ? 1024 * 1024 * 1024 : 0,
    custom: ['user_id', 'created_at'], http: ['contentType'], batch: 100 },
};
const httpHeaders = { contentType: 'content-type', contentDisposition: 'content-disposition', cacheControl: 'cache-control' };
export function storagePolicyLimit(namespace, key) { return policies[namespace]?.limit(key) || 0; }

function policyOptions(options, policy) {
  if (policy === policies['pikno-relay-inputs']) return validateOptions(options);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(name => !['httpMetadata', 'customMetadata'].includes(name))) throw Error('Invalid TOS legacy storage options');
  for (const [field, allowed] of [['httpMetadata', policy.http], ['customMetadata', policy.custom]]) {
    const value = options[field];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.entries(value).some(([key, item]) => !allowed.includes(key) || typeof item !== 'string' || item.length > 128 || /[^\x20-\x7E]/.test(item)))) throw Error('Invalid TOS legacy metadata');
  }
  return options;
}

async function uploadBody(body, maximum, expectedLength, spoolDirectory) {
  if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > maximum)) throw Error('TOS upload length rejected');
  if (!body || typeof body.getReader !== 'function') {
    const bytes = await bodyBytes(body, maximum);
    if (expectedLength !== undefined && bytes.length !== expectedLength) throw Error('TOS upload length mismatch');
    return { body: bytes, length: bytes.length, digest: hash(bytes), cleanup: async () => {} };
  }
  const directory = await mkdtemp(join(spoolDirectory, 'pikno-tos-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'body');
  let file, stream, reader;
  const cleanup = async () => {
    if (stream) {
      stream.destroy();
      if (!stream.closed) await new Promise(resolve => stream.once('close', resolve));
    }
    if (file) { await file.close(); file = undefined; }
    try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rmdir(directory);
  };
  let length = 0;
  const digest = createHash('sha256');
  try {
    file = await open(path, 'wx', 0o600);
    reader = body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!ArrayBuffer.isView(item.value)) throw Error('Invalid stream');
      const bytes = Buffer.from(item.value.buffer, item.value.byteOffset, item.value.byteLength);
      length += bytes.length;
      if (length > maximum || expectedLength !== undefined && length > expectedLength) throw Error('Stream too large');
      digest.update(bytes);
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written);
        if (!result.bytesWritten) throw Error('Spool write failed');
        written += result.bytesWritten;
      }
    }
    if (!length || expectedLength !== undefined && length !== expectedLength) throw Error('Stream length mismatch');
    reader.releaseLock(); reader = undefined;
    await file.close(); file = undefined;
    stream = createReadStream(path);
    return { body: stream, length, digest: digest.digest('hex'), cleanup, streaming: true };
  } catch {
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    await cleanup();
    throw Error('TOS upload stream rejected');
  }
}

function numericHeader(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
  return Number(value);
}

function objectMetadata(response, maximum, range, policy) {
  const sizeOfResponse = numericHeader(response.headers.get('content-length'));
  let size = sizeOfResponse;
  if (range) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!match || response.status !== 206) fail();
    const [first, last, total] = match.slice(1).map(Number);
    const expectedFirst = range.suffix ? Math.max(0, total - range.suffix) : range.offset;
    const expectedLast = range.suffix || range.length === undefined ? total - 1 : Math.min(total - 1, range.offset + range.length - 1);
    if (![first, last, total].every(Number.isSafeInteger) || first !== expectedFirst || last < first ||
        last >= total || last !== expectedLast || last - first + 1 !== sizeOfResponse) fail();
    size = total;
  } else if (response.headers.has('content-range')) fail();
  if (size < 1 || size > maximum) fail();
  const customMetadata = {};
  for (const [name, value] of response.headers) {
    if (name.startsWith('x-tos-meta-')) {
      const field = policy.custom.find(item => item.toLowerCase() === name.slice(11));
      if (!field) fail();
      customMetadata[field] = value;
    }
  }
  const httpMetadata = {};
  for (const field of policy.http) if (response.headers.has(httpHeaders[field])) httpMetadata[field] = response.headers.get(httpHeaders[field]);
  // Existing media objects only use these fixed metadata names. Fail closed on
  // a new shape instead of silently dropping account, expiry or lease metadata.
  policyOptions({ customMetadata, httpMetadata }, policy);
  const returnedRange = range ? /^bytes (\d+)-(\d+)\//.exec(response.headers.get('content-range')).slice(1).map(Number) : null;
  return { size, etag: etagValue(response.headers.get('etag')), customMetadata, httpMetadata,
    ...(returnedRange ? { range: { offset: returnedRange[0], length: returnedRange[1] - returnedRange[0] + 1 } } : {}) };
}

function objectResult(meta, response) {
  return {
    ...meta, httpEtag: `"${meta.etag}"`,
    writeHttpMetadata(headers) {
      for (const [field, value] of Object.entries(meta.httpMetadata)) headers.set(httpHeaders[field], value);
    },
    ...(response ? {
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: () => response.json(),
    } : {}),
  };
}

export function createTosStorage({ bucket, region, endpoint, accessKeyId, secretAccessKey, namespace, fetchImpl = fetch, now = Date.now, spoolDirectory = tmpdir() }) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '') || !/^[a-z0-9-]+$/.test(region || '')) throw Error('Invalid TOS bucket configuration');
  const base = new URL(endpoint);
  if (base.href !== `https://tos-${region}.volces.com/`) throw Error('Invalid TOS endpoint');
  const objectOrigin = `https://${bucket}.${base.hostname}`;
  if (namespace !== undefined && !Object.hasOwn(policies, namespace)) throw Error('Invalid TOS namespace');
  const policy = policies[namespace || 'pikno-relay-inputs'];
  // Validate credentials locally before accepting requests; no configuration is logged.
  signTosRequest({ method: 'HEAD', url: objectOrigin, region, accessKeyId, secretAccessKey, now: now() });

  async function operation(method, key, body, options, transfer = {}) {
    const maximum = typeof key === 'string' ? policy.limit(key) : 0;
    if (!maximum) throw Error('TOS storage key rejected');
    const headers = new Headers();
    let upload, range, conditional = false;
    if (method === 'PUT') {
      options = policyOptions(options || {}, policy);
      if (!transfer || Object.keys(transfer).some(key => key !== 'expectedLength')) throw Error('Invalid TOS transfer options');
      for (const [field, value] of Object.entries(options.httpMetadata || {})) headers.set(httpHeaders[field], value);
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      for (const [name, value] of Object.entries(options.customMetadata || {})) headers.set('x-tos-meta-' + name, value);
      if (options.onlyIf?.etagMatches) headers.set('if-match', options.onlyIf.etagMatches);
      if (options.onlyIf?.etagDoesNotMatch) headers.set('if-none-match', options.onlyIf.etagDoesNotMatch);
      upload = await uploadBody(body, maximum, transfer.expectedLength, spoolDirectory);
      headers.set('content-length', String(upload.length));
    } else if (method === 'GET' && options !== undefined) {
      if (!options || Object.keys(options).some(key => !['range', 'onlyIf'].includes(key))) throw Error('TOS storage read options rejected');
      if (options.onlyIf !== undefined) {
        if (!(options.onlyIf instanceof Headers) || policy === policies['pikno-relay-inputs']) throw Error('TOS read condition rejected');
        for (const name of ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since']) {
          const value = options.onlyIf.get(name);
          if (value !== null) {
            if (value.length > 512 || /[^\x20-\x7E]/.test(value)) throw Error('TOS read condition rejected');
            headers.set(name, value); conditional = true;
          }
        }
      }
      if (options.range instanceof Headers && policy !== policies['pikno-relay-inputs']) {
        const raw = options.range.get('range');
        if (raw !== null) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
          if (!match || !match[1] && !match[2]) throw Error('TOS storage range rejected');
          range = match[1] ? { offset: Number(match[1]), ...(match[2] ? { length: Number(match[2]) - Number(match[1]) + 1 } : {}) } : { suffix: Number(match[2]) };
        }
      } else if (options.range !== undefined) {
        range = options.range;
        if (!range || Object.keys(range).some(key => !['offset', 'length'].includes(key))) throw Error('TOS storage range rejected');
      }
      if (range) {
        if (range.suffix !== undefined) {
          if (!Number.isSafeInteger(range.suffix) || range.suffix < 1 || range.suffix > maximum) throw Error('TOS storage range rejected');
          headers.set('range', `bytes=-${range.suffix}`);
        } else {
          if (!Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset >= maximum ||
            range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 1 || range.offset + range.length > maximum)) throw Error('TOS storage range rejected');
          if (range.length === undefined && policy === policies['pikno-relay-inputs']) throw Error('TOS storage range rejected');
          headers.set('range', `bytes=${range.offset}-${range.length === undefined ? '' : range.offset + range.length - 1}`);
        }
      }
    }
    const url = objectOrigin + '/' + (namespace ? namespace + '/' : '') + key;
    let response;
    try {
      const signed = signTosRequest({ method, url, region, accessKeyId, secretAccessKey, headers, payloadHash: upload?.digest, now: now() });
      // A timed out conditional write may have committed. Never replay it, and
      // never follow a redirect carrying credentials or an object request body.
      response = await fetchImpl(url, { method, headers: signed, body: upload?.body, ...(upload?.streaming ? { duplex: 'half' } : {}), redirect: 'manual', signal: AbortSignal.timeout(180000) });
    } catch { fail(); }
    finally { await upload?.cleanup(); }
    if (response.status === 404 && ['GET', 'HEAD'].includes(method) || response.status === 412 && method === 'PUT' && options.onlyIf) {
      await response.body?.cancel();
      return null;
    }
    if (method === 'GET' && conditional && [304, 412].includes(response.status)) {
      const expected = response.headers.has('etag') ? etagValue(response.headers.get('etag')) : null;
      await response.body?.cancel();
      const meta = await operation('HEAD', key);
      if (expected && meta?.etag !== expected) fail();
      return meta;
    }
    const accepted = method === 'DELETE' ? response.status === 204 : range ? response.status === 206 : response.status === 200;
    if (!accepted) { await response.body?.cancel(); fail(); }
    if (method === 'DELETE') { await response.body?.cancel(); return; }
    try {
      if (method === 'PUT') {
        const result = objectResult({ size: upload.length, etag: etagValue(response.headers.get('etag')),
          httpMetadata: { contentType: headers.get('content-type'), ...options.httpMetadata }, customMetadata: { ...options.customMetadata } });
        await response.body?.cancel();
        return result;
      }
      const result = objectResult(objectMetadata(response, maximum, range, policy), method === 'GET' ? response : undefined);
      if (method === 'HEAD') await response.body?.cancel();
      return result;
    } catch { await response.body?.cancel(); fail(); }
  }
  return {
    head: (key) => operation('HEAD', key),
    get: (key, options) => operation('GET', key, undefined, options),
    put: (key, body, options, transfer) => operation('PUT', key, body, options, transfer),
    async delete(key) {
      if (!Array.isArray(key)) return operation('DELETE', key);
      if (!policy.batch || key.length > policy.batch || key.some(item => typeof item !== 'string' || !policy.limit(item))) throw Error('TOS delete batch rejected');
      // All keys are validated before the first mutation; partial failure is
      // uncertain and is not replayed, matching the existing batch call contract.
      for (const item of new Set(key)) await operation('DELETE', item);
    },
  };
}
