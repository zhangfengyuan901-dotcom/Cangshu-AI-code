import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadGate, fileFingerprint } from '../public/media-upload-state.mjs';

test('upload reservation blocks duplicates before preparation or upload resolves', () => {
  const items = [];
  const gate = createUploadGate(() => items);
  const release = gate.claim('image', 'same');
  assert.equal(typeof release, 'function');
  assert.equal(gate.claim('image', 'same'), null);
  items.push({ kind:'image', fingerprint:'same' });
  release();
  assert.equal(gate.claim('image', 'same'), null);
  items.pop();
  const retry = gate.claim('image', 'same');
  assert.equal(typeof retry, 'function');
  retry();
  assert.equal(typeof gate.claim('image', 'same'), 'function');
});

test('failed uploads can be retried and different contents remain independent', () => {
  const gate = createUploadGate(() => []);
  const failed = gate.claim('image', 'a');
  assert.equal(typeof gate.claim('image', 'b'), 'function');
  failed();
  assert.equal(typeof gate.claim('image', 'a'), 'function');
});

test('fingerprints compare complete content instead of sampled bytes or metadata', async () => {
  const bytes = new Uint8Array(600000);
  const different = bytes.slice();
  different[100000] = 1;
  const file = (content, name, type) => ({ name, type, arrayBuffer:async () => content.slice().buffer });
  const first = await fileFingerprint(file(bytes, 'same.png', 'image/png'));
  assert.equal(first, await fileFingerprint(file(bytes, 'renamed.bin', 'application/octet-stream')));
  assert.notEqual(first, await fileFingerprint(file(different, 'same.png', 'image/png')));
});
