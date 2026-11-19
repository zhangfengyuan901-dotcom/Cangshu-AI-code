const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { checkMedia, deleteMedia, uploadMedia } = require('../media.cjs');

test('R2 uploader authenticates, preserves MIME and validates the returned URL', async () => {
  let request;
  const payload = await uploadMedia(Buffer.from([1, 2, 3]), {
    endpoint: 'https://media.example/v1/upload',
    token: 'secret-token',
    contentType: 'image/jpeg',
    fileName: '../portrait.jpg',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ file: { url: 'https://media.example/media/id.jpg' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(payload.file.url, 'https://media.example/media/id.jpg');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
  assert.equal(request.options.headers['Content-Type'], 'image/jpeg');
  assert.equal(request.options.headers['Content-Length'], '3');
  assert.equal(new URL(request.url).searchParams.get('fileName'), 'portrait.jpg');
});

test('portable client uploads without a distributed secret', async () => {
  let request;
  const payload = await uploadMedia(Buffer.from([1]), {
    endpoint: 'https://media.example/v1/upload',
    contentType: 'image/png',
    fileName: 'portable.png',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ file: { url: 'https://media.example/tmp/x.png?exp=1&sig=x' } }), { status: 201 });
    },
  });
  assert.ok(payload.file.url);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers['X-Hamster-Client'], 'hamster-desktop-v1');
});

test('R2 uploader forwards a readable stream without converting it to a Buffer', async () => {
  let requestBody,duplex,received='';
  await uploadMedia(Readable.from([Buffer.from('abc')]), {
    endpoint:'https://media.example/v1/upload',contentType:'video/mp4',contentLength:3,fileName:'stream.mp4',
    fetchImpl:async(_url,options)=>{
      requestBody=options.body;duplex=options.duplex;
      for await(const chunk of options.body)received+=chunk.toString();
      return new Response(JSON.stringify({file:{url:'https://media.example/tmp/stream.mp4'}}),{status:201});
    },
  });
  assert.equal(Buffer.isBuffer(requestBody),false);assert.equal(duplex,'half');assert.equal(received,'abc');
});

test('R2 cleanup batches object keys through the authenticated bridge', async () => {
  let request;
  const result = await deleteMedia(['tmp/2026/09/16/a.jpg', 'tmp/2026/09/16/a.jpg'], {
    endpoint: 'https://media.example/v1/upload',
    token: 'secret-token',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
    },
  });
  assert.equal(request.url, 'https://media.example/v1/objects');
  assert.equal(request.options.method, 'DELETE');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(request.options.body), { keys: ['tmp/2026/09/16/a.jpg'] });
  assert.equal(result.deleted, 1);
});

test('portable client deletes only by its signed object URL', async () => {
  let request;
  const signed = 'https://media.example/tmp/2026/09/16/id.jpg?exp=1&sig=signed';
  await deleteMedia([signed, signed], {
    endpoint: 'https://media.example/v1/upload',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
    },
  });
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers['X-Hamster-Client'], 'hamster-desktop-v1');
  assert.deepEqual(JSON.parse(request.options.body), { urls: [signed] });
});

test('storage status verifies the portable upload capability endpoint', async () => {
  let request;
  const status = await checkMedia({
    endpoint: 'https://media.example/v1/upload',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ ok: true, upload: true, service: 'fixture' }));
    },
  });
  assert.deepEqual(status, { connected: true, service: 'fixture' });
  assert.equal(request.url, 'https://media.example/v1/status');
  assert.equal(request.options.headers['X-Hamster-Client'], 'hamster-desktop-v1');
});

test('R2 uploader rejects unsupported and oversized material before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  await assert.rejects(
    uploadMedia(Buffer.from('text'), { endpoint: 'https://media.example', token: 'x', contentType: 'text/plain', fetchImpl }),
    /不支持/,
  );
  await assert.rejects(
    uploadMedia(Buffer.alloc(30 * 1024 * 1024 + 1), { endpoint: 'https://media.example', token: 'x', contentType: 'image/png', fetchImpl }),
    /30MB/,
  );
  assert.equal(calls, 0);
});
