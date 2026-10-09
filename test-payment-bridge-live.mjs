import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { epaySign, lanjingCreateSign, openState } from '../lanjing-bridge/server.mjs';

const base = 'https://www.piknoai.com';
const secret = name => readFileSync(new URL(`./private/${name}`, import.meta.url), 'utf8').trim();
const session = JSON.parse(secret('admin-session.json'));
const fields = {
  pid: '2347637', type: 'alipay', out_trade_no: `USR${session.userId}NOVERIFY${Date.now()}`,
  notify_url: `${base}/api/user/epay/notify`, return_url: `${base}/wallet`,
  name: 'PIKNO protocol verification', money: '7.30', sign_type: 'MD5',
};
fields.sign = epaySign(fields, secret('payment-epay-key.txt'));
const health = await fetch(`${base}/pay/lanjing/health`).then(r => r.json());
assert.equal(health.ok, true);
const landing = await fetch(`${base}/pay/lanjing/epay/submit.php`, { method: 'POST', body: new URLSearchParams(fields) });
assert.equal(landing.status, 200);
assert.match(await landing.text(), /\/api\/user\/auth\/refresh/);
const auth = await fetch(`${base}/pay/lanjing/epay/authorize`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}` }, body: new URLSearchParams(fields) });
assert.equal(auth.status, 200);
const payment = await auth.json();
assert.equal(payment.fields.sign, lanjingCreateSign(payment.fields, secret('lanjing-key.txt')));
const state = openState(payment.fields.param, secret('payment-state-key.txt'));
assert.equal(state.o, fields.out_trade_no);
assert.equal(state.m, fields.money);
const invalid = await fetch(`${base}/pay/lanjing/notify?payId=invalid`);
assert.equal(invalid.status, 403);
assert.equal(await invalid.text(), 'fail');
const result = { checkedAt: new Date().toISOString(), publicHealth: true, browserLanding: true, newApiUserAuthentication: true, providerSignature: true, encryptedOrderBinding: true, invalidCallbackRejected: true, providerOrderCreated: false, paymentMade: false, creditOrEmailTriggered: false };
writeFileSync(new URL('./private/payment-protocol-acceptance.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
