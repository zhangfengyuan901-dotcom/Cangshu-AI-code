import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { cnyFromQuota } from '../public/account-lite/client.mjs';

test('account summary shows two decimals without changing ledger values or detail precision', async () => {
  const source = await readFile(new URL('../public/account-lite/account.mjs', import.meta.url), 'utf8');
  const formatters = source.match(/^function (?:formatCny|money)\([^\n]+/gm);
  const balance = source.match(/^async function loadBalance\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.equal(formatters?.length, 2);
  assert.ok(balance);
  const data = { id: 12, quota: 149069966, used_quota: 8230034, request_count: 16 };
  const nodes = Object.fromEntries(['balance-value', 'used-value', 'request-value'].map((id) => [id, { textContent: '' }]));
  const context = {
    Intl, cnyFromQuota, state: { status: { quota_per_unit: 7300000, usd_exchange_rate: 7.3 } },
    $: (id) => nodes[id], identity: () => 'synthetic-account', renderSetupGuide() {},
    client: { current: () => ({ user: { id: 12 } }), request: async () => ({ data }) },
  };
  await runInNewContext(`${formatters.join('\n')}\n${balance}\nloadBalance()`, context);
  assert.equal(nodes['balance-value'].textContent, '¥149.07');
  assert.equal(nodes['used-value'].textContent, '¥8.23');
  assert.equal(nodes['request-value'].textContent, '16');
  assert.equal(runInNewContext('money(149069966)', context), '¥149.069966');
  assert.deepEqual(data, { id: 12, quota: 149069966, used_quota: 8230034, request_count: 16 });
});
