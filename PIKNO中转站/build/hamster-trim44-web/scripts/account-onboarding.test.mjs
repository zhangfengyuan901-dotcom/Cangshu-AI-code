import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/account-lite/account.mjs', import.meta.url), 'utf8');
const guideSource = source.match(/^function setupGuideState\([^\n]+\{[\s\S]*?^\}/m)?.[0];
const loadSource = source.match(/^async function loadSetupGuide\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(guideSource && loadSource);
const guide = input => JSON.parse(JSON.stringify(runInNewContext(`${guideSource}\nsetupGuideState(input)`, { input })));

test('new account manually recharges before its suggested Key setup; the guide never creates a payment', () => {
  const result = guide({ keyCount: 0, balanceSufficient: false, activated: false, native: true });
  assert.equal(result.action, 'topup'); assert.equal(result.create, false);
  assert.equal(result.label, '联系管理员'); assert.match(result.status, /联系管理员充值/);
  assert.equal(result.activation, 'waiting');
});

test('funded new account is guided to explicit creation by purpose without requiring four Keys', () => {
  const result = guide({ keyCount: 0, balanceSufficient: true, activated: false, native: true });
  assert.equal(result.action, 'keys'); assert.equal(result.create, true);
  assert.match(result.status, /无需一次开通四类/); assert.equal(result.activation, 'waiting');
});

test('one existing Key does not imply native activation; one exact successful receipt can complete this page step', () => {
  const waiting = guide({ keyCount: 1, balanceSufficient: true, activated: false, native: true });
  assert.equal(waiting.key, 'done'); assert.equal(waiting.activation, 'current'); assert.equal(waiting.create, false);
  const ready = guide({ keyCount: 1, balanceSufficient: true, activated: true, native: true });
  assert.equal(ready.activation, 'done'); assert.match(ready.status, /所选用途/);
});

test('unknown metadata or balance does not manufacture an authorization or an insufficient balance', () => {
  const result = guide({ keyCount: null, balanceSufficient: null, activated: false, native: true });
  assert.equal(result.key, 'unknown'); assert.equal(result.activation, 'waiting'); assert.equal(result.create, false);
  assert.equal(result.label, '查看 API Key'); assert.doesNotMatch(result.status, /不足|已激活/);
  assert.match(guide({ keyCount: 1, balanceSufficient: null, activated: false, native: false }).status, /应用中/);
});

test('metadata refresh reads a single count request without complete Keys and rejects old-account responses', async () => {
  let account = 'account-a', finish, renders = 0; const calls = [];
  const state = { setupRevision: 0, setupKeyCount: null };
  const context = { state, identity: () => account, renderSetupGuide: () => { renders++; }, client: { request: path => { calls.push(path); return new Promise(resolve => { finish = resolve; }); } } };
  const promise = runInNewContext(`${loadSource}\nloadSetupGuide()`, context);
  account = 'account-b'; finish({ data: { total: 17 } }); await promise;
  assert.deepEqual(calls, ['/api/token/?p=1&size=1']); assert.equal(state.setupKeyCount, null); assert.equal(renders, 0);
});

test('metadata network failure leaves the guide unconfirmed without activating, opening a dialog or reusing a stale count', async () => {
  const state = { setupRevision: 0, setupKeyCount: 1 }; let renders = 0;
  await runInNewContext(`${loadSource}\nloadSetupGuide()`, { state, identity: () => 'same-account', renderSetupGuide: () => { renders++; }, client: { request: async () => { throw Error('offline'); } } });
  assert.equal(state.setupKeyCount, null); assert.equal(renders, 1);
});
