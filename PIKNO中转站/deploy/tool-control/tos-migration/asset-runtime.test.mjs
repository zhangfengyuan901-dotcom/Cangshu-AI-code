import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readdir, rmdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAssetRuntime, createUploadLimiter, ASSET_RELEASE_SHA256 } from './asset-runtime.mjs';
import { createTosStorage } from './storage.mjs';

const secret = 'synthetic-ticket-key-not-a-production-secret';
const id = 'c'.repeat(32), uid = 7, mime = 'video/mp4';
const path = '/media/v1/assets/' + id;
const prefix = Buffer.from('00000020667479706d70343200000000', 'hex');
const sign = (claims) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
};
function ticket(operation, size = 32, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ v: 1, aud: 'pikno-relay-media', uid, id, op: operation, iat: now, exp: now + 300, mime, size, ...overrides });
}
function body(size, { failAfterFirst = false } = {}) {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset && failAfterFirst) { controller.error(Error('synthetic client disconnect')); return; }
    if (offset === size) { controller.close(); return; }
    const bytes = new Uint8Array(Math.min(65536, size - offset));
    if (offset === 0) bytes.set(prefix.subarray(0, bytes.length));
    offset += bytes.length;
    controller.enqueue(bytes);
  } });
}
function upload(size = 32, options = {}) {
  return new Request('https://www.piknoai.com' + path, { method: 'PUT', duplex: 'half',
    headers: { authorization: 'Bearer ' + ticket('upload', size, options.claims), 'content-type': mime,
      'content-length': String(size), ...options.headers }, body: options.body || body(size) });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pikno-asset-runtime-test-'));
  t.after(async () => { assert.deepEqual(await readdir(directory), []); await rmdir(directory); });
  const rows = new Map(), calls = [];
  const storage = createTosStorage({ bucket: 'synthetic-bucket', region: 'cn-guangzhou', endpoint: 'https://tos-cn-guangzhou.volces.com',
    accessKeyId: 'syntheticAK', secretAccessKey: 'syntheticSK', namespace: 'pikno-relay-inputs', spoolDirectory: directory,
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).hostname, 'synthetic-bucket.tos-cn-guangzhou.volces.com');
      assert.equal(request.redirect, 'manual');
      const key = new URL(url).pathname, headers = request.headers, prior = rows.get(key);
      calls.push(request.method);
      if (request.method === 'PUT') {
        let size = 0;
        const hash = createHash('sha256'), metadata = new Headers();
        for await (const chunk of request.body) { hash.update(chunk); size += chunk.length; }
        const digest = hash.digest('hex');
        assert.equal(headers.get('content-length'), String(size));
        assert.equal(headers.get('x-tos-content-sha256'), digest);
        if (prior && headers.get('if-none-match') === '*') return new Response(null, { status: 412 });
        for (const [name, value] of headers) if (name.startsWith('x-tos-meta-') || name === 'content-type') metadata.set(name, value);
        rows.set(key, { size, etag: digest, metadata });
        return new Response(null, { headers: { etag: '"' + digest + '"' } });
      }
      if (request.method === 'DELETE') { rows.delete(key); return new Response(null, { status: 204 }); }
      if (!prior) return new Response(null, { status: 404 });
      const resultHeaders = new Headers(prior.metadata);
      resultHeaders.set('etag', '"' + prior.etag + '"');
      let offset = 0, length = prior.size, status = 200;
      if (headers.has('range')) {
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range'));
        assert.ok(range);
        offset = Number(range[1]); length = Math.min(Number(range[2]), prior.size - 1) - offset + 1; status = 206;
        resultHeaders.set('content-range', `bytes ${offset}-${offset + length - 1}/${prior.size}`);
      }
      resultHeaders.set('content-length', String(length));
      // Tests only download the synthetic prefix/range, never retain full uploads.
      assert.ok(request.method === 'HEAD' || length <= 32);
      const bytes = new Uint8Array(request.method === 'HEAD' ? 0 : length);
      for (let index = 0; index < bytes.length; index++) bytes[index] = prefix[offset + index] || 0;
      return new Response(request.method === 'HEAD' ? null : bytes, { status, headers: resultHeaders });
    } });
  let limiterCalls = 0;
  const limiter = createUploadLimiter();
  const env = { MEDIA: storage, TICKET_KEY: secret, UPLOAD_LIMITER: { limit(options) { limiterCalls++; return limiter.limit(options); } } };
  return { runtime: await loadAssetRuntime(), env, directory, calls, rows, limiterCalls: () => limiterCalls };
}

test('asset runtime pins the existing release and cannot dispatch control or read control secrets', async t => {
  const f = await fixture(t);
  assert.equal(ASSET_RELEASE_SHA256, 'd9727a639745c53050c85ac9fdaa85298360d4613a652b4496c9d66b0c09b63f');
  Object.defineProperty(f.env, 'TOOLS_BRIDGE_SECRET', { get() { assert.fail('asset runtime read control secret'); } });
  for (const route of ['/media/v1/tools', '/media/v1/packy', '/media/v1/storage-tos/', path + '/unknown']) {
    assert.equal((await f.runtime.fetch(new Request('https://www.piknoai.com' + route), f.env)).status, 404);
  }
  const altered = join(f.directory, 'altered.mjs');
  await writeFile(altered, 'export default {};');
  try { await assert.rejects(loadAssetRuntime({ releasePath: altered }), /digest mismatch/); }
  finally { await unlink(altered); }
  assert.equal(f.limiterCalls(), 0); assert.deepEqual(f.calls, []);
});

test('unchanged asset contract retains upload, duplicate claim, inspect, HEAD and Range responses', async t => {
  const f = await fixture(t);
  const sent = await f.runtime.fetch(upload(), f.env);
  assert.equal(sent.status, 201); assert.equal((await sent.json()).status, 'uploaded');
  assert.equal((await f.runtime.fetch(upload(), f.env)).status, 409);
  const inspect = new Request('https://www.piknoai.com' + path + '/inspect', { method: 'POST', headers: { authorization: 'Bearer ' + ticket('inspect') } });
  assert.equal((await f.runtime.fetch(inspect, f.env)).status, 200);
  const readUrl = 'https://www.piknoai.com' + path + '?ticket=' + ticket('read');
  const head = await f.runtime.fetch(new Request(readUrl, { method: 'HEAD' }), f.env);
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '32'); assert.equal(head.body, null);
  const range = await f.runtime.fetch(new Request(readUrl, { headers: { range: 'bytes=4-7' } }), f.env);
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 4-7/32'); assert.equal(await range.text(), 'ftyp');
  const suffix = await f.runtime.fetch(new Request(readUrl, { headers: { range: 'bytes=-4' } }), f.env);
  assert.equal(suffix.status, 206); assert.equal(suffix.headers.get('content-range'), 'bytes 28-31/32');
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), new Uint8Array(4));
  assert.equal((await f.runtime.fetch(new Request(readUrl, { headers: { range: 'bytes=32-40' } }), f.env)).status, 416);
});

test('ticket, origin, method, metadata and preflight checks run before storage admission', async t => {
  const f = await fixture(t);
  const invalid = upload(32, { headers: { authorization: 'Bearer invalid' } });
  assert.equal((await f.runtime.fetch(invalid, f.env)).status, 401);
  assert.equal((await f.runtime.fetch(upload(32, { claims: { exp: 1 } }), f.env)).status, 403);
  assert.equal((await f.runtime.fetch(upload(32, { headers: { origin: 'https://invalid.example' } }), f.env)).status, 403);
  assert.equal(f.limiterCalls(), 0);
  const options = await f.runtime.fetch(new Request('https://www.piknoai.com' + path, { method: 'OPTIONS', headers: { origin: 'https://www.piknoai.com' } }), f.env);
  assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), 'https://www.piknoai.com');
  assert.equal((await f.runtime.fetch(upload(32, { headers: { 'content-type': 'image/png' } }), f.env)).status, 400);
  assert.equal((await f.runtime.fetch(upload(32, { headers: { 'content-encoding': 'gzip' } }), f.env)).status, 400);
  assert.equal((await f.runtime.fetch(new Request('https://www.piknoai.com' + path, { method: 'DELETE' }), f.env)).status, 405);
  assert.deepEqual(f.calls, []);
});

test('per-user limiter enforces 60 per fixed minute with bounded state and no early reset', () => {
  let time = 60000;
  const limiter = createUploadLimiter({ maximumUsers: 2, now: () => time });
  for (let count = 0; count < 60; count++) assert.equal(limiter.limit({ key: '7' }).success, true);
  assert.equal(limiter.limit({ key: '7' }).success, false);
  assert.equal(limiter.limit({ key: '8' }).success, true);
  assert.equal(limiter.limit({ key: '9' }).success, false);
  for (const key of ['0', '07', '../escape', '9007199254740992', 7, undefined]) assert.equal(limiter.limit({ key }).success, false);
  time = 59999; assert.equal(limiter.limit({ key: '7' }).success, false);
  time = 119999; assert.equal(limiter.limit({ key: '7' }).success, false);
  time = 120000; assert.equal(limiter.limit({ key: '9' }).success, true); assert.equal(limiter.limit({ key: '7' }).success, true);
});

test('50 MiB synthetic video streams to TOS once, validates full size and cleans its spool', async t => {
  const f = await fixture(t), maximum = 50 << 20;
  assert.equal((await f.runtime.fetch(upload(maximum), f.env)).status, 201);
  assert.deepEqual(f.calls, ['PUT', 'GET']);
  assert.equal([...f.rows.values()][0].size, maximum);
  assert.deepEqual(await readdir(f.directory), []);
  const before = f.calls.length;
  assert.equal((await f.runtime.fetch(upload(maximum + 1), f.env)).status, 403);
  assert.equal(f.calls.length, before);
});

test('interrupted and oversized streams never dispatch a TOS PUT and leave no temporary file', async t => {
  const f = await fixture(t), maximum = 50 << 20;
  assert.equal((await f.runtime.fetch(upload(maximum, { body: body(maximum, { failAfterFirst: true }) }), f.env)).status, 500);
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), []);
  assert.equal((await f.runtime.fetch(upload(maximum, { body: body(maximum + 1) }), f.env)).status, 500);
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), []);
});

test('a real local HTTP upload disconnect reaches stream cleanup without committing or replaying', async t => {
  const f = await fixture(t), maximum = 50 << 20;
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const server = http.createServer(async (incoming, outgoing) => {
    const request = new Request('https://www.piknoai.com' + incoming.url, { method: 'PUT', headers: incoming.headers, body: Readable.toWeb(incoming), duplex: 'half' });
    const response = await f.runtime.fetch(request, f.env);
    finished(response.status);
    if (!outgoing.destroyed) { outgoing.writeHead(response.status); outgoing.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const received = new Promise(resolve => server.once('request', resolve));
  const client = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'PUT', headers: {
    authorization: 'Bearer ' + ticket('upload', maximum), 'content-type': mime, 'content-length': maximum,
  } });
  client.on('error', () => {});
  const chunk = Buffer.alloc(65536); prefix.copy(chunk);
  await new Promise((resolve, reject) => client.write(chunk, error => error ? reject(error) : resolve()));
  await received;
  client.destroy();
  assert.equal(await done, 500);
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), []);
});
