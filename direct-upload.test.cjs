'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter, getEventListeners } = require('node:events');
const { createPiknoClient } = require('./source/pikno-client.cjs');
const { createReferenceUpload } = require('./source/electron/reference-upload.cjs');
const { bufferReferenceImage } = require('./source/reference-image-upload.cjs');
const origin = 'https://www.piknoai.com', tosOrigin = 'https://cangshu-ai-guangzhou-2026.tos-cn-guangzhou.volces.com';
const id = 'a'.repeat(32), uid = 7, key = 'sk-synthetic-video-not-production';
const bytes = Buffer.from('synthetic-reference-image-bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const asset = origin + '/media/v1/assets/' + id;

function fixture({ mime = 'image/png', status = 200, presignError = false, mutate, signedLifetime = 600, uploadStatus = 200, uploadError = false, completeError = false, readyURL, uploadFetch } = {}) {
  const now = Date.now(), issued = Math.floor(now / 1000), exp = issued + 600;
  const claims = { v: 1, aud: 'pikno-relay-media', uid, id, op: 'upload', iat: issued, exp, mime, size: bytes.length };
  const token = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.synthetic-signature';
  const date = new Date(issued * 1000).toISOString().replace(/[-:]/g, '').replace('.000', '');
  const query = new URLSearchParams({ 'X-Tos-Algorithm': 'TOS4-HMAC-SHA256', 'X-Tos-Credential': 'synthetic-ak/' + date.slice(0, 8) + '/cn-guangzhou/tos/request', 'X-Tos-Date': date,
    'X-Tos-Expires': String(signedLifetime), 'X-Tos-SignedHeaders': 'content-length;content-type;host;if-none-match;x-tos-content-sha256;x-tos-meta-expires;x-tos-meta-uid', 'X-Tos-Signature': 'b'.repeat(64) });
  const signed = { id, transport: 'tos-v1', method: 'PUT', upload_url: tosOrigin + '/pikno-relay-inputs/input/' + uid + '/' + id + '?' + query, expires_at: issued + signedLifetime,
    headers: { 'Content-Length': String(bytes.length), 'Content-Type': mime, 'If-None-Match': '*', 'X-Tos-Content-Sha256': digest, 'X-Tos-Meta-Expires': String(issued + 86400), 'X-Tos-Meta-Uid': String(uid) } };
  if (mutate) mutate(signed);
  const ordinary = [], uploads = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname; ordinary.push(path);
    assert.equal(options.redirect, 'error');
    if (path === '/v1/media/uploads') {
      assert.equal(options.headers.get('authorization'), 'Bearer ' + key);
      assert.deepEqual(JSON.parse(options.body), { content_type: mime, size: bytes.length });
      return Response.json({ id, method: 'PUT', upload_url: asset, upload_ticket: token, expires_at: exp, headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime } });
    }
    if (path.endsWith('/presign')) {
      assert.equal(url, asset + '/presign'); assert.equal(options.credentials, 'omit');
      assert.deepEqual(options.headers, { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(options.body), { sha256: digest });
      if (presignError) throw Error('synthetic presign disconnected');
      return Response.json(signed, { status });
    }
    if (path === '/v1/media/complete') {
      assert.equal(options.headers.get('authorization'), 'Bearer ' + key);
      assert.deepEqual(JSON.parse(options.body), { upload_ticket: token });
      return completeError ? Response.json({}, { status: 409 }) : Response.json({ id, status: 'ready', expires_at: exp, url: readyURL || asset + '?ticket=synthetic-read' });
    }
    assert.equal(path, '/synthetic-read'); return Response.json({ ok: true });
  };
  const uploadFetchImpl = async (url, options) => {
    uploads.push({ url, options });
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    if (uploadFetch) return uploadFetch(url, options);
    if (uploadError) throw Error('synthetic lost acknowledgement');
    return { status: uploadStatus, ok: uploadStatus >= 200 && uploadStatus < 300 };
  };
  const client = createPiknoClient({ endpoint: origin, fetchImpl, uploadFetchImpl, now: () => now });
  return { client, ordinary, uploads, signed, token, cfg: { piknoUserId: uid, piknoVideoKey: key }, upload: body => client.upload({ piknoUserId: uid, piknoVideoKey: key }, body || bytes, { contentType: mime, contentLength: bytes.length, kind: 'video' }) };
}

test('PNG/JPEG/WEBP reference bytes use exactly one TOS PUT; completion stays on original asset', async () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) for (const streamed of [false, true]) {
    const f = fixture({ mime });
    try {
      const result = await f.upload(streamed ? Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]) : bytes);
      assert.equal(result.file.url, asset + '?ticket=synthetic-read');
      assert.deepEqual(f.ordinary, ['/v1/media/uploads', '/media/v1/assets/' + id + '/presign', '/v1/media/complete']);
      assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].url, f.signed.upload_url);
      assert.deepEqual(f.uploads[0].options.body, bytes); assert.deepEqual(f.uploads[0].options.headers, f.signed.headers);
      assert.equal(f.uploads[0].options.headers.Authorization, undefined);
    } finally { f.client.stop(); }
  }
});

test('shorter direct signature expiry is accepted only when it exactly matches the query and stays within original ticket', async () => {
  const short = fixture({ signedLifetime: 240 });
  try { await short.upload(); assert.equal(short.uploads.length, 1); assert.equal(new URL(short.uploads[0].url).searchParams.get('X-Tos-Expires'), '240'); }
  finally { short.client.stop(); }
  for (const options of [
    { signedLifetime: 240, mutate: item => { item.expires_at++; } },
    { signedLifetime: 240, mutate: item => { item.expires_at--; } },
    { signedLifetime: 240, mutate: item => { item.expires_at = String(item.expires_at); } },
    { signedLifetime: 601 },
    { signedLifetime: 0 },
  ]) {
    const f = fixture(options);
    try { await assert.rejects(f.upload(), error => error.code === 'media_upload_ticket'); assert.equal(f.uploads.length, 0); }
    finally { f.client.stop(); }
  }
});

test('404/405 presign supports the original proxy before any PUT; non-image has no presign', async () => {
  for (const status of [404, 405]) {
    const f = fixture({ status });
    try { await f.upload(); assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].url, asset); assert.equal(f.uploads[0].options.headers.Authorization, 'Bearer ' + f.token); }
    finally { f.client.stop(); }
  }
  for (const mime of ['video/mp4', 'audio/wav']) {
    const f = fixture({ mime });
    try { await f.upload(); assert.deepEqual(f.ordinary, ['/v1/media/uploads', '/v1/media/complete']); assert.equal(f.uploads[0].url, asset); }
    finally { f.client.stop(); }
  }
});

test('presign errors never silently bypass the gate or repeat the request', async () => {
  for (const options of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 500 }, { status: 503 }, { presignError: true }]) {
    const f = fixture(options);
    try {
      await assert.rejects(f.upload(), error => error.code === 'media_upload_ticket');
      assert.equal(f.uploads.length, 0); assert.deepEqual(f.ordinary, ['/v1/media/uploads', '/media/v1/assets/' + id + '/presign']);
    } finally { f.client.stop(); }
  }
});

test('untrusted destinations, query, metadata and signed headers are rejected before bytes leave', async () => {
  const query = (name, value) => item => { const url = new URL(item.upload_url); url.searchParams.set(name, value); item.upload_url = url.href; };
  const mutations = [
    item => { item.upload_url = item.upload_url.replace('https:', 'http:'); },
    item => { item.upload_url = item.upload_url.replace('cangshu-ai-guangzhou-2026', 'other-bucket'); },
    item => { item.upload_url = item.upload_url.replace('/input/7/', '/input/8/'); },
    item => { item.upload_url = item.upload_url.replace('/input/', '/input/%2E%2E/'); },
    item => { item.upload_url += '&X-Tos-Signature=' + 'b'.repeat(64); },
    item => { item.upload_url += '#unsafe'; },
    item => { item.upload_url = item.upload_url.replace('https://', 'https://user@'); },
    query('unexpected', 'unsafe'), query('X-Tos-Algorithm', 'unknown'), query('X-Tos-Expires', '601'),
    query('X-Tos-Credential', 'synthetic-ak/20260101/other-region/tos/request'), query('X-Tos-SignedHeaders', 'host'),
    item => { item.headers.Authorization = 'must-not-leave'; },
    item => { item.headers['Content-Length'] = String(bytes.length + 1); },
    item => { item.headers['Content-Type'] = 'image/jpeg'; },
    item => { item.headers['X-Tos-Content-Sha256'] = '0'.repeat(64); },
    item => { item.headers['X-Tos-Meta-Uid'] = '8'; },
    item => { item.headers['X-Tos-Meta-Expires'] = '1'; },
    item => { item.headers['If-None-Match'] = ''; },
    item => { item.id = 'c'.repeat(32); }, item => { item.expires_at++; }, item => { item.transport = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const f = fixture({ mutate });
    try { await assert.rejects(f.upload(), error => error.code === 'media_upload_ticket'); assert.equal(f.uploads.length, 0); }
    finally { f.client.stop(); }
  }
});

test('unknown PUT or conditional collision confirms original ticket once, never proxy fallback or replay', async () => {
  for (const options of [{ uploadError: true }, { uploadStatus: 408 }, { uploadStatus: 409 }, { uploadStatus: 412 }, { uploadStatus: 503 }]) for (const completeError of [false, true]) {
    const f = fixture({ ...options, completeError });
    try {
      if (completeError) await assert.rejects(f.upload(), error => error.code === 'media_upload_transfer'); else await f.upload();
      assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].url, f.signed.upload_url);
      assert.equal(f.ordinary.filter(path => path === '/v1/media/complete').length, 1);
    } finally { f.client.stop(); }
  }
});

test('definite TOS rejection stops; foreign completion URL cannot become a reference', async () => {
  const denied = fixture({ uploadStatus: 403 }), foreign = fixture({ readyURL: tosOrigin + '/private-object' });
  try {
    await assert.rejects(denied.upload(), error => error.code === 'media_upload_transfer' && error.statusCode === 403);
    assert.equal(denied.ordinary.includes('/v1/media/complete'), false);
    await assert.rejects(foreign.upload(), error => error.code === 'media_upload_confirm');
    assert.equal(denied.uploads.length, 1); assert.equal(foreign.uploads.length, 1);
  } finally { denied.client.stop(); foreign.client.stop(); }
});

test('pre-ticket read bounds, length mismatch and abort reject without any remote request', async () => {
  for (const body of [Buffer.alloc(bytes.length - 1), Readable.from([Buffer.alloc(bytes.length + 1)]), Readable.from([Buffer.alloc(bytes.length - 1)])]) {
    const f = fixture();
    try { await assert.rejects(f.upload(body), error => error.code === 'media_upload_transfer'); assert.deepEqual(f.ordinary, []); assert.equal(f.uploads.length, 0); }
    finally { f.client.stop(); }
  }
  const controller = new AbortController(), body = new Readable({ read() {} }), reason = Error('synthetic abort');
  const pending = bufferReferenceImage(body, 20, controller.signal);
  const outcome = pending.then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(reason);
  assert.equal(await outcome, reason); assert.equal(body.destroyed, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(bufferReferenceImage(Buffer.alloc(12), 30 * 1024 * 1024 + 1, new AbortController().signal));
  const exact = await bufferReferenceImage(Readable.from([Buffer.alloc(30 * 1024 * 1024)]), 30 * 1024 * 1024, new AbortController().signal);
  assert.equal(exact.bytes.length, 30 * 1024 * 1024); assert.match(exact.sha256, /^[a-f0-9]{64}$/);
});

test('Chromium sends only signed direct headers with exact body and no credentials or redirects', async () => {
  const calls = [];
  const upload = createReferenceUpload({ request(options) {
    const request = new EventEmitter(); calls.push({ options });
    request.abort = () => {};
    request.end = value => { calls.at(-1).bytes = value; queueMicrotask(() => { const response = Readable.from([]); response.statusCode = 200; request.emit('response', response); }); };
    return request;
  } });
  const f = fixture({ uploadFetch: upload });
  try {
    await f.upload(); const expected = { ...f.signed.headers }; delete expected['Content-Length'];
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].bytes, bytes);
    assert.deepEqual(calls[0].options, { url: f.signed.upload_url, method: 'PUT', redirect: 'error', credentials: 'omit', headers: expected });
    await f.client.request(f.cfg, 'video', '/synthetic-read', { readOnly: true });
    assert.equal(calls.length, 1);
  } finally { f.client.stop(); }
});
