'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { getEventListeners } = require('node:events');
const { createReferenceUpload } = require('./source/electron/reference-upload.cjs');
const { createPiknoClient } = require('./source/pikno-client.cjs');

const origin = 'https://synthetic-relay.invalid', id = 'a'.repeat(32);
const target = origin + '/media/v1/assets/' + id;
const maximum = 50 << 20;
const headers = length => ({ Authorization: 'Bearer synthetic-upload', 'Content-Type': 'video/mp4', 'Content-Length': String(length) });

function network({ mode = 'success', status = 201 } = {}) {
  const calls = [];
  const net = { request(options) {
    const request = new EventEmitter(), call = { options, ends: 0, aborts: 0, bytes: null, request };
    calls.push(call);
    request.end = bytes => {
      call.ends++; call.bytes = bytes;
      if (mode === 'hold') return;
      queueMicrotask(() => {
        if (mode === 'error') { request.emit('error', Object.assign(Error('synthetic connection reset'), { code: 'ECONNRESET' })); return; }
        const response = Readable.from([Buffer.from('{}')]); response.statusCode = status;
        request.emit('response', response);
      });
    };
    request.abort = () => { call.aborts++; request.emit('abort'); request.emit('close'); };
    return request;
  } };
  return { net, calls, upload: createReferenceUpload(net) };
}

test('exact Buffer and streamed bytes are preserved; Chromium receives one restricted PUT', async () => {
  for (const stream of [false, true]) {
    const f = network(), expected = Buffer.from('synthetic-reference-bytes'), controller = new AbortController();
    const result = await f.upload(target, { headers: { ...headers(expected.length), Cookie: 'must-not-forward' },
      body: stream ? Readable.from([expected.subarray(0, 7), expected.subarray(7)]) : expected, signal: controller.signal });
    assert.deepEqual(result, { ok: true, status: 201 });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ends, 1); assert.equal(f.calls[0].aborts, 0);
    assert.deepEqual(f.calls[0].bytes, expected);
    assert.deepEqual(f.calls[0].options, { url: target, method: 'PUT', redirect: 'error', credentials: 'omit',
      headers: { Authorization: 'Bearer synthetic-upload', 'Content-Type': 'video/mp4' } });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(); assert.equal(f.calls[0].aborts, 0);
  }
});

test('50 MiB is bounded and accepted; missing, excess and short bodies never reach Chromium', async () => {
  const f = network();
  const chunks = function* () { for (let total = 0; total < maximum; total += 65536) yield Buffer.alloc(65536); };
  await f.upload(target, { headers: headers(maximum), body: Readable.from(chunks()), signal: new AbortController().signal });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].bytes.length, maximum);
  assert.equal(f.calls[0].bytes[0], 0); assert.equal(f.calls[0].bytes.at(-1), 0);
  for (const [declared, body] of [
    [maximum + 1, Buffer.alloc(16)], [11, Buffer.alloc(11)], [NaN, Buffer.alloc(16)],
    [16, Buffer.alloc(15)], [16, Buffer.alloc(17)],
    [16, Readable.from([Buffer.alloc(15)])], [16, Readable.from([Buffer.alloc(17)])],
  ]) {
    const rejected = network();
    await assert.rejects(rejected.upload(target, { headers: headers(declared), body, signal: new AbortController().signal }), /length/i);
    assert.equal(rejected.calls.length, 0);
  }
});

test('already-aborted and actively uploading requests reject once without replay or lingering abort listeners', async () => {
  const early = network(), first = new AbortController(), reason = Error('synthetic abort'); first.abort(reason);
  await assert.rejects(early.upload(target, { headers: headers(16), body: Buffer.alloc(16), signal: first.signal }), error => error === reason);
  assert.equal(early.calls.length, 0);
  const f = network({ mode: 'hold' }), controller = new AbortController();
  const pending = f.upload(target, { headers: headers(16), body: Buffer.alloc(16), signal: controller.signal });
  assert.equal(f.calls.length, 1); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(f.calls[0].aborts, 1); assert.equal(f.calls[0].ends, 1); assert.equal(f.calls.length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort interrupts a stalled input stream before any network request', async () => {
  const f = network(), controller = new AbortController(), input = new Readable({ read() {} });
  input.push(Buffer.alloc(12));
  const reason = Error('synthetic stalled-input abort');
  const pending = f.upload(target, { headers: headers(16), body: input, signal: controller.signal });
  const settled = pending.then(() => ({ resolved: true }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(reason);
  let timer;
  try {
    const outcome = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 200); })]);
    assert.equal(outcome.stalled, undefined, 'signal must interrupt a pending read, not await another chunk');
    assert.equal(outcome.error, reason);
    assert.equal(input.destroyed, true);
    assert.equal(f.calls.length, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { clearTimeout(timer); input.destroy(); await settled; }
});

test('transport error and HTTP rejection each make only one Chromium attempt', async () => {
  const failed = network({ mode: 'error' });
  await assert.rejects(failed.upload(target, { headers: headers(16), body: Buffer.alloc(16), signal: new AbortController().signal }), /synthetic connection reset/);
  assert.equal(failed.calls.length, 1); assert.equal(failed.calls[0].ends, 1);
  for (const status of [400, 409, 429, 503]) {
    const f = network({ status });
    assert.deepEqual(await f.upload(target, { headers: headers(16), body: Buffer.alloc(16), signal: new AbortController().signal }), { ok: false, status });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ends, 1);
  }
});

function clientFixture({ useOverride = true, uploadFailure = false, confirmFailure = false, badTarget = false } = {}) {
  const ordinary = [], special = [];
  const expires = Math.floor(Date.now() / 1000) + 300;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname; ordinary.push(path);
    if (path === '/v1/media/uploads') return Response.json({ id, upload_url: badTarget ? 'https://other.invalid/media/v1/assets/' + id : target,
      method: 'PUT', upload_ticket: 'synthetic-upload', headers: { Authorization: 'Bearer synthetic-upload', 'Content-Type': 'video/mp4' }, expires_at: expires });
    if (path === '/v1/media/complete') {
      assert.deepEqual(JSON.parse(options.body), { upload_ticket: 'synthetic-upload' });
      return confirmFailure ? Response.json({}, { status: 404 }) : Response.json({ id, status: 'ready', url: target + '?ticket=synthetic-read', expires_at: expires });
    }
    if (path === new URL(target).pathname) return new Response(null, { status: 201 });
    assert.equal(path, '/synthetic-read-only'); return Response.json({ ok: true });
  };
  const uploadFetchImpl = async (url, options) => {
    special.push({ url, method: options.method });
    assert.equal(options.redirect, 'error'); assert.equal(options.headers['Content-Length'], '16');
    if (uploadFailure) throw Error('synthetic dropped acknowledgement');
    return { ok: true, status: 201 };
  };
  const client = createPiknoClient({ endpoint: origin, fetchImpl, ...(useOverride ? { uploadFetchImpl } : {}) });
  return { client, ordinary, special, cfg: { piknoUserId: 7, piknoVideoKey: 'sk-synthetic-not-production' } };
}

test('only reference PUT uses the new transport; ordinary API fetch and default injection remain unchanged', async () => {
  for (const useOverride of [false, true]) {
    const f = clientFixture({ useOverride });
    try {
      await f.client.request(f.cfg, 'video', '/synthetic-read-only', { readOnly: true });
      const result = await f.client.upload(f.cfg, Buffer.alloc(16), { contentType: 'video/mp4', kind: 'video' });
      assert.ok(result.file.url);
      assert.deepEqual(f.ordinary, ['/synthetic-read-only', '/v1/media/uploads', ...(useOverride ? [] : ['/media/v1/assets/' + id]), '/v1/media/complete']);
      assert.equal(f.special.length, useOverride ? 1 : 0);
    } finally { f.client.stop(); }
  }
});

test('lost PUT acknowledgement inspects its exact ticket once and never retransmits bytes', async () => {
  for (const confirmFailure of [false, true]) {
    const f = clientFixture({ uploadFailure: true, confirmFailure });
    try {
      const pending = f.client.upload(f.cfg, Buffer.alloc(16), { contentType: 'video/mp4', kind: 'video' });
      if (confirmFailure) await assert.rejects(pending, error => error.code === 'media_upload_transfer');
      else assert.ok((await pending).file.url);
      assert.equal(f.special.length, 1); assert.deepEqual(f.ordinary, ['/v1/media/uploads', '/v1/media/complete']);
    } finally { f.client.stop(); }
  }
});

test('untrusted ticket destination is rejected before the new transport', async () => {
  const f = clientFixture({ badTarget: true });
  try {
    await assert.rejects(f.client.upload(f.cfg, Buffer.alloc(16), { contentType: 'video/mp4', kind: 'video' }), error => error.code === 'media_upload_ticket');
    assert.equal(f.special.length, 0); assert.deepEqual(f.ordinary, ['/v1/media/uploads']);
  } finally { f.client.stop(); }
});
