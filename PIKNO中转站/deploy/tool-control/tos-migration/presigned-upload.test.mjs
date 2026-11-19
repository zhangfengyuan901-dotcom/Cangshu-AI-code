import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresignedUpload } from './presigned-upload.mjs';

const now = Date.UTC(2026, 10, 14);
const current = now / 1000;
const config = {
  bucket: 'synthetic-bucket',
  region: 'cn-guangzhou',
  endpoint: 'https://tos-cn-guangzhou.volces.com',
  accessKeyId: 'syntheticAK',
  secretAccessKey: 'syntheticSK',
  now: () => now,
};
const claims = {
  uid: 7, id: 'a'.repeat(32), mime: 'image/png', size: 64, iat: current - 60, exp: current + 120, sha256: '01'.repeat(32),
};
const sign = createPresignedUpload(config);

test('matches the official TOS SDK fixture and fixes all upload headers', () => {
  const { url, headers } = sign(claims);
  const target = new URL(url);
  assert.equal(target.origin, 'https://synthetic-bucket.tos-cn-guangzhou.volces.com');
  assert.equal(target.pathname, '/pikno-relay-inputs/input/7/' + claims.id);
  assert.deepEqual(headers, {
    'Content-Length': '64',
    'Content-Type': 'image/png',
    'If-None-Match': '*',
    'X-Tos-Content-Sha256': claims.sha256,
    'X-Tos-Meta-Expires': String(claims.iat + 86400),
    'X-Tos-Meta-Uid': '7',
  });
  assert.deepEqual(Object.fromEntries(target.searchParams), {
    'X-Tos-Algorithm': 'TOS4-HMAC-SHA256',
    'X-Tos-Credential': 'syntheticAK/20261114/cn-guangzhou/tos/request',
    'X-Tos-Date': '20261114T000000Z',
    'X-Tos-Expires': '120',
    'X-Tos-SignedHeaders': 'content-length;content-type;host;if-none-match;x-tos-content-sha256;x-tos-meta-expires;x-tos-meta-uid',
    // Volcengine tos 2.9.1 pre_signed_url(..., is_signed_all_headers=True) with synthetic credentials
    // and lowercase x-tos-content-sha256 so that the SDK uses it as the canonical payload.
    'X-Tos-Signature': 'e868853b3ffd5e9b7c22e1128812e8d2f0cfb33efbc20c67bc6115c1ee575c88',
  });
  assert.equal(url.includes(config.secretAccessKey), false);
});

test('scope, method-related headers, hash and lifetimes affect the signature', () => {
  const signature = (scope) => new URL(sign(scope).url).searchParams.get('X-Tos-Signature');
  const initial = signature(claims);
  for (const change of [{ uid: 8 }, { id: 'b'.repeat(32) }, { mime: 'image/jpeg' }, { size: 65 },
    { sha256: '02'.repeat(32) }, { iat: current - 59 }, { exp: current + 121 }]) {
    assert.notEqual(signature({ ...claims, ...change }), initial);
  }
  const nonstandard = sign({ ...claims, headers: { 'If-None-Match': 'override' }, path: '../outside' });
  assert.deepEqual(nonstandard, sign(claims));
});

test('rejects unsafe scope and stale, future or overlong authorizations', () => {
  for (const change of [{ uid: 0 }, { uid: 9007199254740992 }, { id: '../' + claims.id }, { id: claims.id.toUpperCase() },
    { mime: 'constructor' }, { mime: 'image/png\r\n' }, { size: '64' }, { size: 11 }, { size: (30 << 20) + 1 },
    { mime: 'video/mp4', size: (50 << 20) + 1 }, { sha256: 'AZ'.repeat(32) }, { sha256: 'a'.repeat(63) },
    { iat: 0 }, { iat: current + 31 }, { exp: current }, { iat: current, exp: current + 601 },
    { iat: current + 30, exp: current + 601 }, { iat: current - 600, exp: current + 1 }]) {
    assert.throws(() => sign({ ...claims, ...change }), { message: 'Invalid TOS presigned upload claims' });
  }
  assert.doesNotThrow(() => sign({ ...claims, uid: Number.MAX_SAFE_INTEGER, size: 30 << 20, iat: current, exp: current + 600 }));
  const ending = new URL(sign({ ...claims, mime: 'video/mp4', size: 50 << 20, exp: current + 1 }).url);
  assert.equal(ending.searchParams.get('X-Tos-Expires'), '1');
});

test('requires a valid bucket, regional endpoint, credentials and clock', () => {
  for (const change of [{ bucket: 'Bucket/path' }, { region: 'cn-guangzhou.volces.com' }, { accessKeyId: 'ak/extra' },
    { secretAccessKey: '' }, { endpoint: 'https://tos-cn-guangzhou.volces.com/other' },
    { endpoint: 'https://tos-cn-guangzhou.volces.com@evil.example' }, { endpoint: 'https://tos-cn-beijing.volces.com' }]) {
    assert.throws(() => createPresignedUpload({ ...config, ...change }));
  }
  assert.throws(() => createPresignedUpload({ ...config, now: () => NaN })(claims));
});
