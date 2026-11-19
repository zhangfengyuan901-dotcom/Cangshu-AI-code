import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { attachStorageGateway } from './server.mjs';
import { createRemoteStorage, createStorageHandler, STORAGE_PATH } from './proxy.mjs';

const namespace = 'pikno-relay-inputs';
const legacy = 'hamster-billing-results';
const secret = 'a'.repeat(64);
const otherSecret = 'b'.repeat(64);
const origin = 'https://origin.piknoai.com';
const key = 'tool-config/active';
const meta = { size: 3, etag: 'synthetic-etag', httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { uid: '1' } };

test('HTTP gateway preserves ordinary control and streams the separate authenticated storage route', async t => {
  const seen = [];
  const storage = {
    async put(k, body, options, transfer) {
      seen.push({ key: k, options, transfer, bytes: await new Response(body).text() });
      return meta;
    },
    async head() { return meta; },
    async get(k, opts) {
      assert.equal(k, key);
      assert.deepEqual(opts.range, { offset: 0, length: 2 });
      return { ...meta, range: { offset: 0, length: 2 }, body: new Response('ab').body };
    },
  };
  const server = http.createServer((_, res) => res.end('original control'));
  const gateway = attachStorageGateway(server, createStorageHandler({ stores: { [namespace]: { storage, secret } } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createRemoteStorage({ origin, namespace, secret, fetchImpl: (url, options) => fetch(base + new URL(url).pathname, options) });

  assert.equal(await (await fetch(base + '/healthz')).text(), 'original control');
  const onlyIf = { etagDoesNotMatch: '*' };
  assert.equal((await client.put(key, 'abc', { onlyIf })).etag, meta.etag);
  assert.deepEqual(seen, [{ key, options: { onlyIf }, transfer: { expectedLength: 3 }, bytes: 'abc' }]);
  assert.equal((await client.head(key)).size, 3);
  const read = await client.get(key, { range: { offset: 0, length: 2 } });
  assert.deepEqual(read.range, { offset: 0, length: 2 });
  assert.equal(await read.text(), 'ab');
  gateway.stopAccepting();
  assert.equal(gateway.active(), 0);
  assert.equal((await fetch(base + STORAGE_PATH + namespace + '/' + key)).status, 503);
  assert.equal(await (await fetch(base + '/healthz')).text(), 'original control');
});

test('storage credentials cannot cross namespaces and failed writes are never replayed', async () => {
  let attempts = 0;
  const storage = { async put() { attempts++; throw Error('lost acknowledgement'); }, async head() { return meta; } };
  const handler = createStorageHandler({ stores: { [namespace]: { storage, secret }, [legacy]: { storage, secret: otherSecret } } });
  const fetchImpl = (url, options) => handler(new Request(url, options));
  const wrong = createRemoteStorage({ origin, namespace: legacy, secret, fetchImpl });
  await assert.rejects(wrong.head(key), /uncertain/);
  const client = createRemoteStorage({ origin, namespace, secret, fetchImpl });
  await assert.rejects(client.put(key, 'abc'), /uncertain/);
  assert.equal(attempts, 1);
  assert.equal((await handler(new Request(origin + STORAGE_PATH + namespace + '/' + key, { headers: { origin, authorization: 'Bearer ' + secret } }))).status, 404);
});

test('legacy conditional reads, batched deletes and read-only guard keep existing contracts', async () => {
  const updates = [];
  const storage = {
    async get(_, options) { assert.equal(options.onlyIf.get('if-none-match'), meta.etag); return meta; },
    async delete(keys) { updates.push(keys); },
  };
  const stores = { [legacy]: { storage, secret } };
  const clientOf = handler => createRemoteStorage({ origin, namespace: legacy, secret, fetchImpl: (url, options) => handler(new Request(url, options)) });
  const client = clientOf(createStorageHandler({ stores }));
  const read = await client.get(key, { onlyIf: new Headers({ 'if-none-match': meta.etag }) });
  assert.equal('body' in read, false);
  assert.equal(read.httpEtag, '"synthetic-etag"');
  await client.delete([key]);
  assert.deepEqual(updates, [[key]]);
  await assert.rejects(clientOf(createStorageHandler({ stores, readOnly: true })).delete([key]), /uncertain/);
  assert.deepEqual(updates, [[key]]);
});

test('only the www vhost enters assets and asset reads do not occupy compatibility storage slots', async t => {
  const server = http.createServer((_, res) => res.end('original control'));
  const path = '/media/v1/assets/' + '0'.repeat(32);
  const held = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const gateway = attachStorageGateway(server, async () => new Response('storage'), { maximum: 1, async assetHandler(request) {
    assert.equal(new URL(request.url).origin, 'https://www.piknoai.com');
    assert.equal(request.headers.get('origin'), 'https://www.piknoai.com');
    entered.resolve(); await held.promise;
    return new Response('asset');
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + path)).status, 404);
  const inFlight = new Promise((resolve, reject) => {
    const request = http.get(base + path, { headers: { host: 'www.piknoai.com', origin: 'https://www.piknoai.com' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body)); response.on('error', reject);
    });
    request.on('error', reject);
  });
  try {
    await Promise.race([entered.promise, inFlight.then(() => assert.fail('asset handler did not run'))]);
    assert.equal(gateway.active(), 1);
    assert.equal((await fetch(base + STORAGE_PATH + namespace + '/' + key)).status, 200);
    assert.equal(await (await fetch(base + '/healthz')).text(), 'original control');
  } finally { held.resolve(); }
  assert.equal(await inFlight, 'asset');
});

function localRequest(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(base + path, { method, agent: false, headers: { host: 'www.piknoai.com', ...headers } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, text }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('two incomplete asset uploads cannot block inspect, reads or compatibility storage, and disconnect frees only their slots', async t => {
  const path = '/media/v1/assets/' + '0'.repeat(32);
  let priorCalls = 0, uploadCalls = 0;
  const entered = [Promise.withResolvers(), Promise.withResolvers()];
  const finished = [Promise.withResolvers(), Promise.withResolvers()];
  const clients = [];
  const server = http.createServer((_, response) => { priorCalls++; response.end('control'); });
  const gateway = attachStorageGateway(server, createStorageHandler({ stores: {
    [namespace]: { secret, storage: { async head() { return meta; } } },
  } }), { assetHandler: async request => {
    if (request.method !== 'PUT') return new Response(request.method === 'HEAD' ? null : 'ready');
    const index = uploadCalls++;
    entered[index]?.resolve();
    try { await new Response(request.body).arrayBuffer(); }
    catch { finished[index]?.resolve(); throw Error('synthetic incomplete upload'); }
    return new Response('uploaded', { status: 201 });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let index = 0; index < 2; index++) {
    const client = http.request(base + path, { method: 'PUT', agent: false, headers: { host: 'www.piknoai.com', 'content-length': '1024' } });
    client.on('error', () => {}); clients.push(client); client.write('x');
    await entered[index].promise;
  }
  assert.equal(gateway.active(), 2);
  assert.equal((await localRequest(base, path, { method: 'PUT', body: 'x' })).status, 503);
  assert.equal(uploadCalls, 2);
  for (const [method, target] of [['POST', path + '/inspect'], ['HEAD', path], ['GET', path]]) {
    assert.equal((await localRequest(base, target, { method })).status, 200);
  }
  assert.equal((await localRequest(base, STORAGE_PATH + namespace + '/' + key, {
    method: 'HEAD', headers: { authorization: 'Bearer ' + secret },
  })).status, 200);
  assert.equal(gateway.active(), 2);
  clients[0].destroy();
  await finished[0].promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gateway.active(), 1);
  assert.equal((await localRequest(base, path, { method: 'PUT', body: 'x' })).status, 201);
  assert.equal(uploadCalls, 3);
  clients[1].destroy();
  await finished[1].promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gateway.active(), 0);
  assert.equal(priorCalls, 0);
  gateway.stopAccepting();
  for (const [method, target] of [['PUT', path], ['POST', path + '/inspect'], ['GET', STORAGE_PATH + namespace + '/' + key]]) {
    assert.equal((await localRequest(base, target, { method })).status, 503);
  }
  assert.equal((await localRequest(base, '/healthz')).text, 'control');
});

test('asset read slots and legacy storage writes retain independent finite bounds', async t => {
  const path = '/media/v1/assets/' + '0'.repeat(32), storagePath = STORAGE_PATH + namespace + '/' + key;
  const held = Promise.withResolvers(), entered = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  let storageCalls = 0, readCalls = 0;
  const server = http.createServer((_, response) => response.end('control'));
  const gateway = attachStorageGateway(server, async () => {
    storageCalls++; entered[0].resolve(); await held.promise; return new Response('stored');
  }, { maximum: 1, assetHandler: async request => {
    if (request.method === 'PUT') return new Response('uploaded', { status: 201 });
    entered[++readCalls].resolve(); await held.promise; return new Response('read');
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { held.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = [localRequest(base, storagePath, { method: 'PUT', body: 'x' }), localRequest(base, path), localRequest(base, path)];
  try {
    await Promise.all(entered.map(item => item.promise));
    assert.equal(gateway.active(), 3);
    assert.equal((await localRequest(base, storagePath, { method: 'PUT', body: 'x' })).status, 503);
    assert.equal((await localRequest(base, path)).status, 503);
    assert.equal(storageCalls, 1); assert.equal(readCalls, 2);
    assert.equal((await localRequest(base, path, { method: 'PUT', body: 'x' })).status, 201);
  } finally { held.resolve(); }
  assert.deepEqual((await Promise.all(pending)).map(item => item.status), [200, 200, 200]);
  assert.equal(gateway.active(), 0);
});

test('disconnect after the complete upload body does not release its slot before the single write finishes', async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers(), completed = Promise.withResolvers();
  let calls = 0, cancelled = 0;
  const server = http.createServer(() => assert.fail('disconnected asset must never fall through to control'));
  const gateway = attachStorageGateway(server, () => assert.fail('asset must not enter compatibility storage'), {
    assetHandler: async request => {
      calls++;
      assert.equal(await new Response(request.body).text(), 'x');
      entered.resolve(); await held.promise;
      return new Response(new ReadableStream({ cancel() { cancelled++; completed.resolve(); } }));
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { held.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = http.request(`http://127.0.0.1:${server.address().port}/media/v1/assets/` + '0'.repeat(32), {
    method: 'PUT', agent: false, headers: { host: 'www.piknoai.com', 'content-length': '1' },
  });
  client.on('error', () => {});
  const disconnected = new Promise(resolve => server.once('connection', socket => socket.once('close', resolve)));
  client.end('x'); await entered.promise;
  client.destroy(); await disconnected;
  assert.equal(gateway.active(), 1); assert.equal(calls, 1);
  held.resolve(); await completed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gateway.active(), 0); assert.equal(calls, 1); assert.equal(cancelled, 1);
});
