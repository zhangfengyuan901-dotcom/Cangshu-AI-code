import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadRuntime, allowedUpstream, RELEASE_PATH, RELEASE_SHA256 } from './runtime.mjs';
import { createStorageClient } from './storage-client.mjs';
import { createControlServer } from './server.mjs';
import { createMigrationWorker } from '../../cloudflare/relay-media/control-migration/router.mjs';
import { STORE_PREFIX, OPTIONS_HEADER, encodeHeader } from '../../cloudflare/relay-media/control-migration/protocol.mjs';

const require = createRequire(new URL('../../tools/relay-cli/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const bridge = 'B'.repeat(40), admin = 'A'.repeat(40), storeSecret = 'S'.repeat(40), ticketKey = 'T'.repeat(40), master = 'a'.repeat(64);
const bindings = { CONTROL_OWNER: 'ecs', CONTROL_STORAGE_ENABLED: 'true', TOOL_STORE_SECRET: storeSecret, TOOLS_ENABLED: 'true', TOOLS_BRIDGE_SECRET: bridge, TOOLS_ADMIN_SECRET: admin, TICKET_KEY: ticketKey, RH_CONFIG_ENCRYPTION_KEY: master, RUNNINGHUB_API_KEY: 'L'.repeat(32) };
const base = 'https://www.piknoai.com';
const output = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
const records = [];
const signed = (claims) => { const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); return payload + '.' + createHmac('sha256', ticketKey).update(payload).digest('base64url'); };
const toolRequest = (path, data, secret = bridge) => new Request(base + '/media/v1/tools' + path, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });

async function fixture() {
  const protocol = (await readFile(new URL('../../cloudflare/relay-media/control-migration/protocol.mjs', import.meta.url), 'utf8')).replaceAll('export ', '');
  const storage = (await readFile(new URL('../../cloudflare/relay-media/control-migration/storage.mjs', import.meta.url), 'utf8')).replace(/^import .*\n/, '').replace('export async function storage', 'async function storage');
  const pinned = (await readFile(RELEASE_PATH, 'utf8')).replace(/export\s*\{\s*worker_default as default\s*\};/, '').replaceAll('await fetch(', 'await fixtureProvider(');
  // Production source remains intact. This wrapper replaces external I/O only in QA.
  const script = `const storageHandler = (() => { ${protocol}\n${storage}\nreturn storage; })();\n${pinned}\n
  let providerCalls = 0;
  async function fixtureProvider(url, options) {
    providerCalls++;
    if (options.body instanceof ReadableStream) await new Response(options.body).arrayBuffer();
    if(String(url).includes('/media/upload/')) return Response.json({code:0,data:{fileName:'fixture.mp4'}});
    if(String(url).includes('/run/')) return Response.json({taskId:'cf-original-provider'});
    if(String(url).endsWith('/query')) return Response.json({status:'RUNNING'});
    throw Error('No external network allowed');
  }
  export default {fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__test/provider-calls') return Response.json({calls:providerCalls});
    if (url.pathname.startsWith('/__test/original/')) {
      url.pathname = url.pathname.slice('/__test/original'.length);
      return worker_default.fetch(new Request(url, request),env);
    }
    return storageHandler(request,env);
  }};`;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-03', script, r2Buckets: ['MEDIA'], bindings }));
  let bucket;
  try { bucket = await mf.getR2Bucket('MEDIA'); } catch (error) { await mf.dispose(); throw error; }
  const media = createStorageClient({ origin: 'https://store.invalid', secret: storeSecret, fetchImpl: (url, options) => mf.dispatchFetch(String(url), options) });
  return { mf, bucket, media, async close() { await mf.dispose(); } };
}

async function seeded(runtime, f) {
  const response = await runtime.fetch(toolRequest('/config', { api_key: 'K'.repeat(32), expected_version: '' }, admin), { ...bindings, MEDIA: f.media });
  assert.equal(response.status, 200, await response.clone().text());
  const config = await response.json();
  const now = Math.floor(Date.now() / 1000), id = '1'.repeat(32);
  const ticket = signed({ v: 1, aud: 'pikno-tool-input', uid: 7, id, iat: now, exp: now + 7200, mime: 'video/mp4', size: output.length, filename: 'openapi/fixture.mp4', credential_version: config.version });
  return { version: config.version, body: { kind: 'depth', request_id: 'task_candidate', videos: [{ url: base + '/media/v1/tool-inputs/' + id + '?ticket=' + ticket }] } };
}

function provider({ run, query } = {}) {
  const counts = { uploads: 0, runs: 0, queries: 0, downloads: 0, checks: 0, keys: [], uploadLengths: [] };
  return { counts, async fetch(url, options) {
    url = String(url);
    if (url.endsWith('/accountStatus')) { counts.checks++; return Response.json({ code: 0, data: {} }); }
    if (url.endsWith('/media/upload/binary')) {
      counts.uploads++;
      const bytes = await new Response(options.body).arrayBuffer();
      assert.equal(Number(options.headers.get('content-length')), bytes.byteLength);
      counts.uploadLengths.push(bytes.byteLength);
      return Response.json({ code: 0, data: { fileName: 'fixture.mp4' } });
    }
    if (url.includes('/run/ai-app/')) { counts.runs++; return run ? run() : Response.json({ taskId: 'original-rh-id', status: 'QUEUED' }); }
    if (url.endsWith('/query')) {
      counts.queries++;
      counts.keys.push(options.headers.get('authorization'));
      assert.deepEqual(JSON.parse(options.body), { taskId: 'original-rh-id' });
      return query ? query() : Response.json({ status: 'SUCCESS', results: [{ outputType: 'video', url: 'https://rh-comfyui01.tos-cn-beijing.volces.com/original.mp4' }] });
    }
    if (url.startsWith('https://rh-comfyui01.tos-cn-beijing.volces.com/')) {
      counts.downloads++;
      const range=options.headers.get('range');
      if(range==='bytes=4-7')return new Response(output.subarray(4,8),{status:206,headers:{'content-length':'4','content-range':'bytes 4-7/'+output.length}});
      return new Response(output, { headers: { 'content-length': String(output.length) } });
    }
    throw Error('No external network allowed');
  } };
}

test('real R2 CAS, metadata, range and unknown transport are preserved', async () => {
  const f = await fixture();
  try {
    const key = 'tool-jobs/task_atomic';
    const result = await Promise.all([f.media.put(key, 'one', { onlyIf: { etagDoesNotMatch: '*' } }), f.media.put(key, 'two', { onlyIf: { etagDoesNotMatch: '*' } })]);
    assert.equal(result.filter(Boolean).length, 1);
    const first = await f.media.get(key);
    assert.equal(await f.media.put(key, 'bad', { onlyIf: { etagMatches: 'wrong' } }), null);
    assert.ok(await f.media.put(key, 'replacement', { onlyIf: { etagMatches: first.etag } }));
    assert.equal(await (await f.media.get(key, { range: { offset: 1, length: 3 } })).text(), 'epl');
    assert.equal((await f.media.head(key)).size, 11);
    let calls = 0;
    const uncertain = createStorageClient({ origin: 'https://store.invalid', secret: storeSecret, fetchImpl: async (url, options) => { calls++; const r = await f.mf.dispatchFetch(String(url), options); await r.body?.cancel(); throw Error('response lost'); } });
    await assert.rejects(uncertain.put('tool-jobs/task_lost', 'original', { onlyIf: { etagDoesNotMatch: '*' } }));
    assert.equal(calls, 1);
    assert.equal(await (await f.bucket.get('tool-jobs/task_lost')).text(), 'original');
    records.push({ test: 'real-r2-cas-range-lost-response', passed: true, uncertainWriteAttempts: calls });
  } finally { await f.close(); }
});

test('storage is private and constrained to original object prefixes and operations', async () => {
  const f = await fixture();
  try {
    const request = (path, options = {}) => f.mf.dispatchFetch('https://store.invalid' + STORE_PREFIX + path, options);
    assert.equal((await request('tool-jobs/task_a')).status, 403);
    assert.equal((await request('unrelated/customer-secret', { headers: { authorization: 'Bearer ' + storeSecret } })).status, 404);
    assert.equal((await request('tool-jobs/task_a', { headers: { authorization: 'Bearer ' + storeSecret, origin: base } })).status, 403);
    assert.equal((await request('tool-config/active', { method: 'PUT', headers: { authorization: 'Bearer ' + storeSecret, [OPTIONS_HEADER]: encodeHeader({}) }, body: 'x'.repeat(2049) })).status, 413);
    assert.equal((await request('tool-jobs/task_a', { method: 'POST', headers: { authorization: 'Bearer ' + storeSecret } })).status, 405);
    assert.equal((await request('tool-jobs/task_a', { method: 'DELETE', headers: { authorization: 'Bearer ' + storeSecret } })).status, 405);
    assert.equal((await request('tool-config/active', { method: 'DELETE', headers: { authorization: 'Bearer ' + storeSecret } })).status, 405);
    assert.throws(() => createStorageClient({ origin: 'http://not-loopback.invalid', secret: storeSecret }));
    assert.throws(() => createStorageClient({ origin: 'https://store.invalid/path', secret: storeSecret }));
    records.push({ test: 'private-storage-boundaries', passed: true });
  } finally { await f.close(); }
});

test('original expired poll lease ETag is content identity and cannot fence parallel owners', async () => {
  const f = await fixture();
  try {
    const key = 'tool-polls/task_expired';
    const original = await f.bucket.put(key, 'polling', { customMetadata: { lease: 'old', expires: '1' } });
    const winners = await Promise.all(['first', 'second'].map((lease) => f.bucket.put(key, 'polling', { onlyIf: { etagMatches: original.etag }, customMetadata: { lease, expires: '2000000000' } })));
    assert.equal(winners.filter(Boolean).length, 2);
    assert.equal(winners[0].etag, winners[1].etag);
    records.push({ test: 'original-expired-poll-cas-limitation-confirmed', passed: true, overlappingOwnersSafe: false, requiresBlockedIngressAndDrain: true });
  } finally { await f.close(); }
});

test('pinned Node runtime submits once across Node/CF concurrency and preserves old RH credential version', async () => {
  const f = await fixture(), p = provider();
  try {
    const runtime = await loadRuntime({ fetchImpl: p.fetch }), env = { ...bindings, MEDIA: f.media };
    const seed = await seeded(runtime, f);
    const responses = await Promise.all(Array.from({ length: 5 }, () => runtime.fetch(toolRequest('', seed.body), env)));
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(p.counts.runs, 1);
    assert.equal(p.counts.uploads, 0);
    const cf = await f.mf.dispatchFetch(base + '/__test/original/media/v1/tools', { method: 'POST', headers: { authorization: 'Bearer ' + bridge }, body: JSON.stringify(seed.body) });
    assert.equal((await cf.json()).status, 'queued');
    assert.equal((await (await f.mf.dispatchFetch('https://store.invalid/__test/provider-calls')).json()).calls, 0);
    const before = await (await f.bucket.get('tool-jobs/task_candidate')).json();
    assert.equal(before.credential_version, seed.version);
    assert.equal(before.provider_task_id, 'original-rh-id');
    const rotated = await runtime.fetch(toolRequest('/config', { api_key: 'N'.repeat(32), expected_version: seed.version }, admin), env);
    assert.equal(rotated.status, 200);
    const polled = await runtime.fetch(toolRequest('/task_candidate'), env);
    assert.equal((await polled.json()).status, 'completed');
    assert.deepEqual(p.counts.keys, ['Bearer ' + 'K'.repeat(32)]);
    assert.equal(p.counts.runs, 1);
    const final = await (await f.bucket.get('tool-jobs/task_candidate')).json();
    assert.equal(final.credential_version, seed.version);
    assert.equal(final.provider_task_id, 'original-rh-id');
    assert.equal(final.id, 'task_candidate');
    const partial = await runtime.fetch(new Request(base + '/media/v1/tools/task_candidate/content', { headers: { authorization: 'Bearer ' + bridge, range: 'bytes=4-7' } }), env);
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'ftyp');
    records.push({ test: 'node-cf-original-claim-and-credential-version', passed: true, runs: p.counts.runs, queries: p.counts.queries, uploads: p.counts.uploads });
  } finally { await f.close(); }
});

test('unknown submission and old missing receipt are never submitted again', async () => {
  const f = await fixture(), p = provider({ run: () => { throw Error('provider response lost'); } });
  try {
    const runtime = await loadRuntime({ fetchImpl: p.fetch }), env = { ...bindings, MEDIA: f.media }, seed = await seeded(runtime, f);
    assert.equal((await (await runtime.fetch(toolRequest('', seed.body), env)).json()).status, 'unknown');
    for (let i = 0; i < 3; i++) {
      assert.equal((await (await runtime.fetch(toolRequest('', seed.body), env)).json()).status, 'unknown');
      assert.equal((await (await runtime.fetch(toolRequest('/task_candidate'), env)).json()).status, 'unknown');
    }
    assert.equal(p.counts.runs, 1);
    assert.equal(p.counts.queries, 0);
    assert.equal((await (await runtime.fetch(toolRequest('/task_missing'), env)).json()).status, 'unknown');
    assert.equal((await (await runtime.fetch(toolRequest('/legacy-id'), env)).json()).status, 'unknown');
    records.push({ test: 'unknown-no-resubmission', passed: true, runs: p.counts.runs, queries: p.counts.queries });
  } finally { await f.close(); }
});

test('simultaneous original CF and Node submissions share one atomic R2 claim', async () => {
  const f = await fixture(), p = provider();
  try {
    const runtime = await loadRuntime({ fetchImpl: p.fetch }), env = { ...bindings, MEDIA: f.media }, seed = await seeded(runtime, f);
    const responses = await Promise.all([
      f.mf.dispatchFetch(base + '/__test/original/media/v1/tools', { method: 'POST', headers: { authorization: 'Bearer ' + bridge }, body: JSON.stringify(seed.body) }),
      runtime.fetch(toolRequest('', seed.body), env),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    const cfCalls = (await (await f.mf.dispatchFetch('https://store.invalid/__test/provider-calls')).json()).calls;
    assert.equal(cfCalls + p.counts.runs + p.counts.uploads, 1);
    const original = await (await f.bucket.get('tool-jobs/task_candidate')).json();
    assert.equal(original.credential_version, seed.version);
    assert.equal(original.status, 'queued');
    assert.ok(['original-rh-id', 'cf-original-provider'].includes(original.provider_task_id));
    records.push({ test: 'simultaneous-original-cf-node-cas', passed: true, totalProviderCalls: 1, uploads: 0, runs: 1 });
  } finally { await f.close(); }
});

test('poll leases remain shared; an existing 600 second lease blocks Node and original CF query', async () => {
  const f = await fixture(), p = provider();
  try {
    const runtime = await loadRuntime({ fetchImpl: p.fetch }), env = { ...bindings, MEDIA: f.media }, seed = await seeded(runtime, f);
    await runtime.fetch(toolRequest('', seed.body), env);
    await f.bucket.put('tool-polls/task_candidate', 'polling', { customMetadata: { lease: 'existing-lease', expires: String(Math.floor(Date.now() / 1000) + 600) } });
    assert.equal((await (await runtime.fetch(toolRequest('/task_candidate'), env)).json()).status, 'processing');
    const cf = await f.mf.dispatchFetch(base + '/__test/original/media/v1/tools/task_candidate', { headers: { authorization: 'Bearer ' + bridge } });
    assert.equal((await cf.json()).status, 'processing');
    assert.equal(p.counts.queries, 0);
    assert.equal((await f.bucket.head('tool-polls/task_candidate')).customMetadata.lease, 'existing-lease');
    records.push({ test: 'shared-original-poll-lease', passed: true, queries: 0 });
  } finally { await f.close(); }
});

test('legacy RH id and retained previous KEK recover by query only through real HTTP server', async () => {
  const f = await fixture(), p = provider();
  let service;
  try {
    const runtime = await loadRuntime({ fetchImpl: p.fetch }), seed = await seeded(runtime, f);
    const old = { id: 'task_old_version', uid: 7, kind: 'depth', status: 'unknown', provider_task_id: 'original-rh-id', credential_version: seed.version, created_at: 1 };
    await f.bucket.put('tool-jobs/' + old.id, JSON.stringify(old));
    const legacy = { ...old, id: 'task_legacy' };
    delete legacy.credential_version;
    await f.bucket.put('tool-jobs/' + legacy.id, JSON.stringify(legacy));
    const unavailable = { ...bindings, RH_CONFIG_ENCRYPTION_KEY: 'b'.repeat(64), MEDIA: f.media };
    assert.equal((await (await runtime.fetch(toolRequest('/' + old.id), unavailable)).json()).status, 'unknown');
    assert.equal(p.counts.queries, 0);
    const retained = { ...unavailable, RH_CONFIG_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify([master]) };
    service = createControlServer({ runtime, env: retained, media: f.media });
    await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + service.server.address().port;
    assert.equal((await fetch(origin + '/media/v1/tools/status')).status, 401);
    assert.equal((await fetch(origin + '/media/v1/tools/status', { headers: { authorization: 'Bearer ' + bridge, origin: 'https://foreign.invalid' } })).status, 403);
    for (const job of [old, legacy]) {
      const response = await fetch(origin + '/media/v1/tools/' + job.id, { headers: { authorization: 'Bearer ' + bridge } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'completed');
      const saved = await (await f.bucket.get('tool-jobs/' + job.id)).json();
      assert.equal(saved.provider_task_id, job.provider_task_id);
      assert.equal(saved.credential_version, job.credential_version);
    }
    assert.deepEqual(p.counts.keys, ['Bearer ' + 'K'.repeat(32), 'Bearer ' + 'L'.repeat(32)]);
    assert.equal(p.counts.runs, 0);
    assert.equal(p.counts.uploads, 0);
    records.push({ test: 'old-rh-id-legacy-and-previous-kek-native-http', passed: true, queries: 2, submissions: 0 });
  } finally { if (service) await service.close(); await f.close(); }
});

test('packy also moves to Node and preserves its one-shot ticket claim and usage', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
    const runtime = await loadRuntime({ fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://cf.api.fan/v1/images/generations');
      assert.equal(options.headers.get('authorization'), 'Bearer sk-fixture-only');
      calls++;
      return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { total_tokens: 12 } });
    } });
    const body = JSON.stringify({ model: 'gpt-image-2', prompt: 'synthetic fixture', n: 1 }), now = Math.floor(Date.now() / 1000);
    const edgeTicket = signed({ v: 1, aud: 'pikno-packy-edge', uid: 7, id: '9'.repeat(32), path: '/v1/images/generations', iat: now, exp: now + 60, sha256: createHash('sha256').update(body).digest('hex') });
    const request = () => new Request(base + '/media/v1/packy', { method: 'POST', headers: { authorization: 'Bearer sk-fixture-only', 'x-pikno-edge-ticket': edgeTicket }, body });
    const response = await runtime.fetch(request(), { ...bindings, MEDIA: f.media });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).usage, { total_tokens: 12 });
    assert.equal((await runtime.fetch(request(), { ...bindings, MEDIA: f.media })).status, 409);
    assert.equal(calls, 1);
    records.push({ test: 'packy-one-shot-claim', passed: true, providerCalls: calls });
  } finally { await f.close(); }
});

test('real runtime normalizes permitted Origin variants before an expired-lock query', async () => {
  const f = await fixture();
  let entered, finish, service;
  const enteredQuery = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const p = provider({ query: async () => { entered(); await pending; return Response.json({ status: 'RUNNING' }); } });
  try {
    const runtime = await loadRuntime({ fetchImpl: p.fetch }), seed = await seeded(runtime, f);
    await f.bucket.put('tool-jobs/task_origin', JSON.stringify({ id: 'task_origin', uid: 7, kind: 'depth', status: 'unknown', provider_task_id: 'original-rh-id', credential_version: seed.version }));
    await f.bucket.put('tool-polls/task_origin', 'polling', { customMetadata: { lease: 'expired', expires: '1' } });
    service = createControlServer({ runtime, env: bindings, media: f.media, maxConcurrent: 6 });
    await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + service.server.address().port, url = origin + '/media/v1/tools/task_origin';
    const first = fetch(url, { headers: { authorization: 'Bearer ' + bridge } });
    await enteredQuery;
    const others = [base, ''].map((value) => fetch(url, { headers: { authorization: 'Bearer ' + bridge, origin: value } }));
    for (let i = 0; service.state().active !== 3 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.state().active, 3);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + bridge, origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer invalid', origin: base } })).status, 401);
    finish();
    const replies = await Promise.all([first, ...others].map(async (response) => (await response).json()));
    assert.ok(replies.every((reply) => reply.status === 'processing'));
    assert.equal(p.counts.queries, 1);
    assert.equal(p.counts.runs, 0);
    records.push({ test: 'real-runtime-allowed-origins-expired-poll-singleflight', passed: true, allowedOriginVariants: 3, providerQueries: 1, providerSubmissions: 0 });
  } finally { finish(); if (service) await service.close(); await f.close(); }
});

test('CF cutover disables local control, forwards exactly once, rejects redirect and retains assets', async () => {
  let local = 0, forwarded = 0, target, forwardHeaders;
  const released = { fetch: () => { local++; return Response.json({ original: true }); } };
  const worker = createMigrationWorker(released, { fetchImpl: async (url, options) => { forwarded++; target = url; forwardHeaders = options.headers; return new Response('ok'); } });
  const env = { CONTROL_OWNER: 'ecs', CONTROL_ORIGIN: 'https://origin.test.invalid', CONTROL_ORIGIN_HOST: 'origin.test.invalid' };
  for (const path of ['/media/v1/tools', '/media/v1/tools/config', '/media/v1/tools/task_a/content', '/media/v1/packy']) {
    assert.equal((await worker.fetch(new Request(base + path, { headers: { authorization: 'Bearer fixture', cookie: 'must-not-forward', 'x-arbitrary': 'drop' } }), env)).status, 200);
    assert.equal(target, 'https://origin.test.invalid' + path);
    assert.equal(forwardHeaders.get('authorization'), 'Bearer fixture');
    assert.equal(forwardHeaders.has('cookie'), false);
    assert.equal(forwardHeaders.has('x-arbitrary'), false);
  }
  assert.equal(local, 0);
  assert.equal(forwarded, 4);
  assert.equal((await worker.fetch(toolRequest('/status'), { ...env, CONTROL_OWNER: 'blocked' })).status, 503);
  assert.equal((await worker.fetch(toolRequest('/status'), { ...env, CONTROL_ORIGIN: base, CONTROL_ORIGIN_HOST: 'www.piknoai.com' })).status, 503);
  await worker.fetch(new Request(base + '/media/v1/assets/' + 'a'.repeat(32)), env);
  assert.equal(local, 1);
  let redirects = 0;
  const redirecting = createMigrationWorker(released, { fetchImpl: async () => { redirects++; return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid' } }); } });
  assert.equal((await redirecting.fetch(toolRequest('/status'), env)).status, 503);
  assert.equal(redirects, 1);
  records.push({ test: 'cf-storage-only-and-single-forward', passed: true, forwarded, localControlExecutions: 0 });
});

test('real HTTP Node listener drains accepted work and rejects new control without cancelling it', async () => {
  let finish, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const service = createControlServer({ env: bindings, media: {}, runtime: { async fetch() { entered(); await pending; return Response.json({ status: 'unknown' }); } } });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + service.server.address().port;
  try {
    const first = fetch(origin + '/media/v1/packy', { method: 'POST', body: '{}' });
    await started;
    const draining = service.drain();
    assert.deepEqual(service.state(), { accepting: false, active: 1 });
    assert.equal((await fetch(origin + '/media/v1/tools/status')).status, 503);
    assert.equal((await fetch(origin + '/unrelated')).status, 404);
    finish();
    assert.equal((await (await first).json()).status, 'unknown');
    await draining;
    assert.equal((await (await fetch(origin + '/healthz')).json()).active, 0);
    records.push({ test: 'native-http-graceful-drain', passed: true });
  } finally { finish(); await service.close(); }
});

test('Node query singleflight shares only identical authorization and origin and clones responses', async () => {
  let finish, entered, calls = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const service = createControlServer({ env: bindings, media: {}, maxConcurrent: 4, runtime: { async fetch(request) {
    calls++;
    if (request.headers.get('authorization') !== 'Bearer ' + bridge) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (request.headers.get('origin')) return Response.json({ error: 'origin rejected' }, { status: 403 });
    entered();
    await pending;
    return Response.json({ id: 'task_same', status: 'unknown', outputs: [] });
  } } });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + service.server.address().port + '/media/v1/tools/task_same';
  try {
    const first = fetch(url, { headers: { authorization: 'Bearer ' + bridge } });
    await started;
    const second = fetch(url, { headers: { authorization: 'Bearer ' + bridge } });
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + bridge, origin: 'https://foreign.invalid' } })).status, 403);
    finish();
    const values = await Promise.all([first, second].map(async (response) => (await response).json()));
    assert.deepEqual(values[0], values[1]);
    assert.equal(calls, 3);
    await fetch(url, { headers: { authorization: 'Bearer ' + bridge } });
    assert.equal(calls, 4, 'a later poll performs fresh original query');
    records.push({ test: 'node-singleflight-auth-and-origin-bound', passed: true, coalescedValidCalls: 1, invalidAuthorizationStatus: 401, foreignOriginStatus: 403 });
  } finally { finish(); await service.close(); }
});

test('release pin and upstream allowlist fail closed; write machine result', async () => {
  assert.equal(allowedUpstream('https://www.runninghub.cn/openapi/v2/query'), true);
  for (const url of ['http://www.runninghub.cn/openapi/v2/query', 'https://www.runninghub.cn/admin', 'https://www.runninghub.cn:8443/openapi/v2/query', 'https://example.com/', 'https://user:pass@cf.api.fan/v1/images/generations']) assert.equal(allowedUpstream(url), false);
  await assert.rejects(loadRuntime({ releasePath: new URL('./package.json', import.meta.url) }), /digest mismatch/);
  assert.equal(records.length, 13);
  const dir = new URL('../../output/tool-control-build-current/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('verification.json', dir), JSON.stringify({ candidateOnly: true, productionChanged: false, externalProviderCalls: 0, testRuntime: process.version, testStorage: 'Miniflare real R2 binding', releaseSHA256: RELEASE_SHA256, tests: records, testCount: 14, allPassed: true, cutoverRequires: { dnsVerified: false, originalSecretsVerified: false, blockedIngressAndDrainedOldRequests: true, singleNodeProcess: true, noCloudflareNodeControlOverlap: true, storageEnabledWhileDraining: true }, completedAt: new Date().toISOString() }, null, 2));
});
