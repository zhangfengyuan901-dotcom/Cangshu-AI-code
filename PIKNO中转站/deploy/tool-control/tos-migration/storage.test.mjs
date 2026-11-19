import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTosStorage, signTosRequest } from './storage.mjs';

const config = { bucket: 'synthetic-bucket', region: 'cn-guangzhou', endpoint: 'https://tos-cn-guangzhou.volces.com',
  accessKeyId: 'syntheticAK', secretAccessKey: 'syntheticSK', now: () => Date.UTC(2026, 10, 14) };
const asset = 'input/7/' + 'a'.repeat(32);
const claim = 'tool-jobs/synthetic-task';
const digest = (bytes) => createHash('md5').update(bytes).digest('hex');

function fixture(overrides = {}) {
  const rows = new Map(), calls = [];
  const transport = async (url, request) => {
    const key = new URL(url).pathname.slice(1), h = request.headers, prior = rows.get(key);
    calls.push({ key, method: request.method, headers: new Headers(h), redirect: request.redirect });
    assert.equal(new URL(url).hostname, 'synthetic-bucket.tos-cn-guangzhou.volces.com');
    assert.equal(request.redirect, 'manual');
    assert.match(h.get('authorization'), /^TOS4-HMAC-SHA256 /);
    if (request.method === 'PUT') {
      const body = request.body instanceof Uint8Array ? request.body : Buffer.from(await new Response(request.body).arrayBuffer());
      assert.equal(h.get('content-length'), String(body.byteLength));
      assert.equal(h.get('x-tos-content-sha256'), createHash('sha256').update(body).digest('hex'));
      if (h.has('if-none-match') && prior || h.has('if-match') && (!prior || prior.etag !== h.get('if-match'))) return new Response(null, { status: 412 });
      const row = { bytes: Buffer.from(body), etag: digest(body), headers: new Headers() };
      for (const [name, value] of h) if (name.startsWith('x-tos-meta-') || ['content-type','content-disposition','cache-control'].includes(name)) row.headers.set(name, value);
      rows.set(key, row);
      return new Response(null, { status: 200, headers: { etag: `"${row.etag}"` } });
    }
    if (request.method === 'DELETE') { rows.delete(key); return new Response(null, { status: 204 }); }
    if (!prior) return new Response(null, { status: 404 });
    if (h.get('if-none-match') === `"${prior.etag}"` || h.get('if-none-match') === '*') return new Response(null, { status: 304, headers: { etag: `"${prior.etag}"` } });
    if (h.has('if-match') && h.get('if-match') !== `"${prior.etag}"`) return new Response(null, { status: 412, headers: { etag: `"${prior.etag}"` } });
    const headers = new Headers(prior.headers);
    headers.set('etag', `"${prior.etag}"`);
    let body = prior.bytes, status = 200;
    if (h.has('range')) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(h.get('range'));
      const start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      if (start > end) return new Response(null, { status: 416 });
      headers.set('content-range', `bytes ${start}-${end}/${body.length}`);
      body = body.subarray(start, end + 1); status = 206;
    }
    headers.set('content-length', String(body.length));
    return new Response(request.method === 'HEAD' ? null : body, { status, headers });
  };
  return { storage: createTosStorage({ ...config, fetchImpl: transport, ...overrides }), transport, calls, rows };
}

test('official TOS4 example has its published signature', () => {
  const result = signTosRequest({ method: 'GET', url: 'https://examplebucket.tos-cn-beijing.volces.com/exampleobject',
    region: 'cn-beijing', accessKeyId: 'testAK', secretAccessKey: 'testSK', now: Date.UTC(2022, 0, 1) });
  assert.equal(result.get('authorization'), 'TOS4-HMAC-SHA256 Credential=testAK/20220101/cn-beijing/tos/request,SignedHeaders=host;x-tos-content-sha256;x-tos-date,Signature=d40b66cf0054d1642843670d10fa095e1609c7896f25df217770b0abe717693b');
});

test('fixed namespaces preserve legacy object metadata and block cross-namespace keys', async () => {
  const key = 'tmp/2026/11/14/00000000-0000-0000-0000-000000000000.png';
  const { storage, calls } = fixture({ namespace: 'hamster-ai-media' });
  const options = { httpMetadata: { contentType: 'image/png', contentDisposition: 'inline', cacheControl: 'private, no-store, max-age=0' },
    customMetadata: { expiresAt: '2026-11-15T00:00:00.000Z', retention: 'tmp' } };
  await storage.put(key, 'synthetic-png', options);
  const get = await storage.get(key, { onlyIf: new Headers() });
  assert.deepEqual(get.httpMetadata, options.httpMetadata);
  assert.deepEqual(get.customMetadata, options.customMetadata);
  const headers = new Headers(); get.writeHttpMetadata(headers);
  assert.equal(headers.get('content-disposition'), 'inline');
  assert.equal(headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(await get.text(), 'synthetic-png');
  assert.equal(calls[0].key, 'hamster-ai-media/' + key);
  await assert.rejects(storage.put(claim, 'bad'));
  assert.throws(() => createTosStorage({ ...config, namespace: '../escape' }));
});

test('legacy Range Headers support bounded, open and suffix reads and condition failure omits body', async () => {
  const key = 'tmp/2026/11/14/00000000-0000-0000-0000-000000000000.png';
  const { storage } = fixture({ namespace: 'hamster-ai-media' });
  const original = await storage.put(key, '0123456789abcdefghijklmnopqrstuv');
  for (const [range, offset, length, expected] of [['bytes=8-23', 8, 16, '89abcdefghijklmn'], ['bytes=28-', 28, 4, 'stuv'], ['bytes=-4', 28, 4, 'stuv']]) {
    const get = await storage.get(key, { onlyIf: new Headers(), range: new Headers({ range }) });
    assert.deepEqual(get.range, { offset, length });
    assert.equal(get.size, 32); assert.equal(await get.text(), expected);
  }
  for (const condition of [{ 'if-none-match': original.httpEtag }, { 'if-match': 'wrong' }]) {
    const notModified = await storage.get(key, { onlyIf: new Headers(condition) });
    assert.equal('body' in notModified, false);
    assert.equal(notModified.etag, original.etag); assert.equal(notModified.size, 32);
  }
  const full = await storage.get(key, { range: new Headers() });
  assert.equal(full.range, undefined); assert.equal(await full.text(), '0123456789abcdefghijklmnopqrstuv');
});

test('legacy billing supports scoped keys and validates a complete delete batch before first mutation', async () => {
  const user = 'user_' + 'a'.repeat(32), key = `input/${user}/asset_${'b'.repeat(32)}.mp4`;
  const { storage, calls } = fixture({ namespace: 'hamster-billing-results' });
  const options = { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { user_id: user, created_at: '1794614400000' } };
  await storage.put(key, 'synthetic-video', options);
  const head = await storage.head(key);
  assert.deepEqual(head.customMetadata, options.customMetadata);
  await assert.rejects(storage.delete([key, '../invalid']));
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  await storage.delete([key, key]);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(await storage.head(key), null);
});

test('stream spooling is bounded, exact-length checked and cleaned after success and uncertain PUT', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pikno-tos-test-'));
  const key = `result/user_${'a'.repeat(32)}/task_${'b'.repeat(32)}.mp4`;
  const chunks = 12, chunkSize = 1024 * 1024;
  const stream = () => { let count = 0; return new ReadableStream({ pull(controller) { if (count++ < chunks) controller.enqueue(new Uint8Array(chunkSize)); else controller.close(); } }); };
  let attempts = 0;
  const storage = createTosStorage({ ...config, namespace: 'hamster-billing-results', spoolDirectory: directory,
    fetchImpl: async (url, request) => {
      attempts++;
      assert.equal(request.duplex, 'half');
      assert.equal(request.headers.get('content-length'), String(chunks * chunkSize));
      let size = 0; const digest = createHash('sha256');
      for await (const chunk of request.body) { size += chunk.length; digest.update(chunk); }
      assert.equal(size, chunks * chunkSize);
      assert.equal(request.headers.get('x-tos-content-sha256'), digest.digest('hex'));
      if (attempts === 2) throw Error('synthetic lost acknowledgement');
      return new Response(null, { headers: { etag: 'synthetic-etag' } });
    } });
  try {
    await storage.put(key, stream(), { httpMetadata: { contentType: 'video/mp4' } }, { expectedLength: chunks * chunkSize });
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(storage.put(key, stream(), {}, { expectedLength: chunks * chunkSize }), /^Error: TOS storage response uncertain$/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(storage.put(key, stream(), {}, { expectedLength: chunks * chunkSize - 1 }), /stream rejected/);
    assert.equal(attempts, 2); assert.deepEqual(await readdir(directory), []);
  } finally { await rmdir(directory); }
});

test('PUT, HEAD, GET and DELETE preserve exact body, account metadata and HTTP metadata', async () => {
  const { storage, calls } = fixture(), body = Buffer.from('synthetic media payload for range');
  const options = { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'video/mp4' }, customMetadata: { uid: '7', expires: '1800000000' } };
  const put = await storage.put(asset, body, options), head = await storage.head(asset), get = await storage.get(asset);
  assert.equal(put.etag, head.etag);
  assert.equal(head.size, body.length);
  assert.deepEqual(head.customMetadata, options.customMetadata);
  assert.deepEqual(head.httpMetadata, options.httpMetadata);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), body);
  assert.equal(head.httpEtag, `"${put.etag}"`);
  const headers = new Headers(); head.writeHttpMetadata(headers);
  assert.equal(headers.get('content-type'), 'video/mp4');
  await storage.delete(asset);
  assert.equal(await storage.get(asset), null);
  assert.equal(await storage.head(asset), null);
  assert.equal(calls.length, 6);
  const signedNames = calls[0].headers.get('authorization').split('SignedHeaders=')[1].split(',')[0];
  for (const header of ['if-none-match','content-type','x-tos-meta-uid','x-tos-meta-expires']) assert.ok(signedNames.split(';').includes(header));
});

test('range GET retains full object size and returns the requested bytes', async () => {
  const { storage } = fixture(), body = Buffer.from('0123456789abcdefghijklmnopqrstuv');
  await storage.put(asset, body);
  const part = await storage.get(asset, { range: { offset: 8, length: 16 } });
  assert.equal(part.size, body.length);
  assert.equal(await part.text(), body.subarray(8, 24).toString());
  const last = await storage.get(asset, { range: { offset: 28, length: 16 } });
  assert.equal(last.size, body.length);
  assert.equal(await last.text(), body.subarray(28).toString());
});

test('simultaneous create claims have one winner and stale ETag updates fail atomically', async () => {
  const { storage, calls } = fixture();
  const claims = await Promise.all(Array.from({ length: 16 }, (_, i) => storage.put(claim, JSON.stringify({ attempt: i }), { onlyIf: { etagDoesNotMatch: '*' } })));
  assert.equal(claims.filter(Boolean).length, 1);
  const original = await storage.head(claim);
  const updates = await Promise.all(['first-update', 'second-update'].map(body => storage.put(claim, body, { onlyIf: { etagMatches: original.etag } })));
  assert.equal(updates.filter(Boolean).length, 1);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 18);
  assert.equal(await storage.put('tool-jobs/absent', 'body', { onlyIf: { etagMatches: original.etag } }), null);
});

test('lost PUT acknowledgement preserves the committed claim without automatic replay', async () => {
  const f = fixture(); let attempts = 0;
  const storage = createTosStorage({ ...config, fetchImpl: async (...args) => { attempts++; await f.transport(...args); throw Error('synthetic secret transport details'); } });
  await assert.rejects(storage.put(claim, 'committed', { onlyIf: { etagDoesNotMatch: '*' } }), /^Error: TOS storage response uncertain$/);
  assert.equal(attempts, 1);
  assert.equal(await (await f.storage.get(claim)).text(), 'committed');
  assert.equal(await f.storage.put(claim, 'new', { onlyIf: { etagDoesNotMatch: '*' } }), null);
});

test('DELETE, redirects, throttles and server failures are never retried', async () => {
  for (const method of ['put', 'delete']) for (const status of [301, 403, 408, 429, 500, 503]) {
    let attempts = 0;
    const storage = createTosStorage({ ...config, fetchImpl: async () => { attempts++; return new Response(null, { status, headers: { location: 'https://example.invalid/' } }); } });
    await assert.rejects(storage[method](claim, 'payload'), /^Error: TOS storage response uncertain$/);
    assert.equal(attempts, 1);
  }
});

test('stream upload bounds are checked before dispatch and caller bytes cannot change the signed body', async () => {
  const { storage, rows, calls } = fixture();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('first')); controller.enqueue(Buffer.from('second')); controller.close(); } });
  const result = await storage.put(claim, stream);
  assert.equal(result.size, 11); assert.equal(rows.get(claim).bytes.toString(), 'firstsecond');
  const over = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65)); controller.close(); } });
  await assert.rejects(storage.put('tool-polls/oversized', over), /stream rejected/);
  assert.equal(calls.length, 1);
  const failed = new ReadableStream({ start(controller) { controller.error(Error('synthetic source details')); } });
  await assert.rejects(storage.put(claim, failed), /^Error: TOS upload stream rejected$/);
  assert.equal(calls.length, 1);
});

test('unrecognized object metadata and contradictory range responses fail closed', async () => {
  for (const headers of [
    { etag: 'good', 'content-length': '10', 'x-tos-meta-unreviewed': 'value' },
    { etag: 'good', 'content-length': 'NaN' },
    { etag: 'good', 'content-length': '10', 'content-range': 'bytes 0-9/100' },
    { etag: '\"weak malformed', 'content-length': '10' },
  ]) {
    const storage = createTosStorage({ ...config, fetchImpl: async () => new Response('0123456789', { headers }) });
    await assert.rejects(storage.get(claim), /^Error: TOS storage response uncertain$/);
  }
  for (const [status, range] of [[200, 'bytes 0-9/100'], [206, 'bytes 1-10/100'], [206, 'bytes 0-9/100']]) {
    const storage = createTosStorage({ ...config, fetchImpl: async () => new Response('0123456789', { status, headers: { etag: 'good', 'content-length': '10', 'content-range': range } }) });
    await assert.rejects(storage.get(claim, { range: { offset: 0, length: 16 } }), /^Error: TOS storage response uncertain$/);
  }
});

test('unknown write result does not become success or a conflict', async () => {
  for (const status of [200, 201, 204, 412]) {
    let attempts = 0;
    const storage = createTosStorage({ ...config, fetchImpl: async () => { attempts++; return new Response(null, { status }); } });
    await assert.rejects(storage.put(claim, 'payload'), /^Error: TOS storage response uncertain$/);
    assert.equal(attempts, 1);
  }
});

test('invalid destination, keys, metadata and conditions are rejected before network activity', async () => {
  for (const override of [{ endpoint: 'http://tos-cn-guangzhou.volces.com' }, { endpoint: 'https://tos-cn-beijing.volces.com' }, { endpoint: 'https://tos-cn-guangzhou.volces.com/?query=1' }, { bucket: '../other' }, { accessKeyId: 'invalid\nkey' }]) assert.throws(() => createTosStorage({ ...config, ...override }));
  const { storage, calls } = fixture();
  for (const key of ['../tool-config/active', 'tool-config/active?leak=1', 'unrelated/object', 'input/0/' + 'a'.repeat(32)]) await assert.rejects(storage.put(key, 'x'));
  for (const options of [{ onlyIf: { etagMatches: 'x', etagDoesNotMatch: '*' } }, { onlyIf: { etagDoesNotMatch: 'specific' } }, { customMetadata: { secret: 'not-allowed' } }, { httpMetadata: { contentType: 'text/plain\nunsafe' } }]) await assert.rejects(storage.put(claim, 'payload', options));
  for (const options of [{ range: { offset: -1, length: 2 } }, { range: { offset: 0, length: 100000 } }, { unexpected: true }]) await assert.rejects(storage.get(claim, options));
  assert.equal(calls.length, 0);
});
