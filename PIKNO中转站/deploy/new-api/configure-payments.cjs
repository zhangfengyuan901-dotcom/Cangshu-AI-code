'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connect } = require('./admin-client.cjs');
const privateDir = require('./local-state.cjs').privateDir;
const mode = process.argv[2];

async function main() {
  if (mode === 'tunnel') {
    const { id, accountId } = JSON.parse(fs.readFileSync(path.join(privateDir, 'tunnel.json')));
    const cwd = path.resolve(__dirname, '../../tools/relay-cli');
    const wrangler = path.join(cwd, 'node_modules/wrangler/bin/wrangler.js');
    const auth = JSON.parse(execFileSync(process.execPath, [wrangler, 'auth', 'token', '--json', '--profile', 'pikno'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${id}/configurations`;
    async function request(method, body) {
      const res = await fetch(url, { method, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error('Tunnel configuration failed');
      return json.result;
    }
    const current = await request('GET');
    const backup = path.join(privateDir, 'payment-tunnel-before.json');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(current.config, null, 2), { mode: 0o600 });
    const ingress = current.config.ingress;
    const existing = ingress.find(r => r.hostname === 'www.piknoai.com' && r.path === '^/pay/lanjing/.*$');
    if (existing && existing.service !== 'http://lanjing-bridge:8080') throw new Error('Conflicting payment route');
    if (!existing) {
      const index = ingress.findIndex(r => r.hostname === 'www.piknoai.com' && !r.path);
      if (index < 0) throw new Error('Expected www default route is missing');
      ingress.splice(index, 0, { hostname: 'www.piknoai.com', path: '^/pay/lanjing/.*$', service: 'http://lanjing-bridge:8080' });
      await request('PUT', { config: current.config });
    }
    console.log(JSON.stringify({ ingress: (await request('GET')).config.ingress }));
  } else if (mode === 'new-api') {
    const request = await connect();
    const opts = await request('/api/option/');
    const before = Object.fromEntries(opts.map(o => [o.key, o.value]));
    const changes = {
      PayAddress: 'https://www.piknoai.com/pay/lanjing/epay',
      EpayId: '2347637',
      EpayKey: fs.readFileSync(path.join(privateDir, 'payment-epay-key.txt'), 'utf8').trim(),
      PayMethods: JSON.stringify([{ icon: 'SiAlipay', name: '支付宝', type: 'alipay' }, { icon: 'SiWechat', name: '微信', type: 'wxpay' }]),
    };
    const backup = path.join(privateDir, 'payment-options-before.json');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(Object.fromEntries(Object.keys(changes).map(k => [k, before[k] ?? null])), null, 2), { mode: 0o600 });
    for (const [key, value] of Object.entries(changes)) await request('/api/option/', 'PUT', { key, value });
    const after = Object.fromEntries((await request('/api/option/')).map(o => [o.key, o.value]));
    for (const key of ['PayAddress', 'EpayId', 'PayMethods']) if (after[key] !== changes[key]) throw new Error(`Verification failed: ${key}`);
    console.log(JSON.stringify({ configured: true, payAddress: after.PayAddress, paymentComplianceConfirmed: after['payment_setting.compliance_confirmed'] === 'true', price: after.Price, minTopUp: after.MinTopUp }));
  } else throw new Error('Usage: configure-payments.cjs tunnel|new-api');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
