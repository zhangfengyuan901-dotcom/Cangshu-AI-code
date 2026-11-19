import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloudflare/media-worker/src/worker.js';

const path = '/tmp/2026/09/20/12345678-1234-1234-1234-123456789abc.png';
const secret = 'test-signing-key';

async function signedUrl() {
  const expires = Math.floor(Date.now() / 1000) + 600;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${path}\n${expires}`)));
  const signature = Buffer.from(bytes).toString('base64url');
  return `https://media.hamsterai.cc${path}?exp=${expires}&sig=${signature}`;
}

function environment() {
  let options;
  const metadata = {
    size: 4,
    httpEtag: '"test"',
    writeHttpMetadata(headers) { headers.set('content-type', 'image/png'); },
  };
  return {
    URL_SIGNING_KEY: secret,
    getOptions: () => options,
    MEDIA: {
      async head() { return metadata; },
      async get(_key, input) {
        options = input;
        const partial = input.range?.has('range');
        return {
          ...metadata,
          // R2 supplies range metadata even for a full-body response.
          range: partial ? { offset: 1, length: 2 } : { offset: 0, length: 4 },
          body: partial ? new Uint8Array([2, 3]) : new Uint8Array([1, 2, 3, 4]),
        };
      },
    },
  };
}

test('signed image full GET returns 200 and no Content-Range', async () => {
  const env = environment();
  const response = await worker.fetch(new Request(await signedUrl()), env);
  assert.equal(env.getOptions().range, undefined);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('content-length'), '4');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test('signed image Range GET returns 206 with only the requested bytes', async () => {
  const env = environment();
  const response = await worker.fetch(new Request(await signedUrl(), {
    headers: { Range: 'bytes=1-2' },
  }), env);
  assert.equal(env.getOptions().range.get('range'), 'bytes=1-2');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
  assert.equal(response.headers.get('content-length'), '2');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([2, 3]));
});

test('signed image HEAD returns full object size', async () => {
  const response = await worker.fetch(new Request(await signedUrl(), { method: 'HEAD' }), environment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '4');
});
