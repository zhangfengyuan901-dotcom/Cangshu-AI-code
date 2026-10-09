import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const base = 'https://www.piknoai.com';
const session = JSON.parse(readFileSync(new URL('./private/admin-session.json', import.meta.url)));
const headers = { authorization: `Bearer ${session.accessToken}`, 'New-Api-User': String(session.userId), 'content-type': 'application/json' };
const attempt = process.argv[2] ?? '';
if (attempt && !/^[a-z0-9-]+$/.test(attempt)) throw new Error('Invalid attempt label');
const file = new URL(`./private/payment-live-order${attempt ? '-' + attempt : ''}.json`, import.meta.url);
if (existsSync(file)) throw new Error('An acceptance order already exists; inspect before creating another');
async function request(path, body) {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json();
  if (!res.ok || !(data.success || data.message === 'success')) throw new Error(`Request failed: ${path}: ${data.message}`);
  return data;
}
const user = (await request('/api/user/self')).data;
const quote = await request('/api/user/amount', { amount: 1 });
if (Number(quote.data) !== 7.3) throw new Error('Quote changed; inspect before continuing');
const order = await request('/api/user/pay', { amount: 1, payment_method: 'alipay' });
if (order.url !== `${base}/pay/lanjing/epay/submit.php` || order.data.money !== '7.30') throw new Error('Unexpected payment parameters');
writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), userId: user.id, quotaBefore: user.quota, quoteCny: Number(quote.data), nativeOrder: order }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ orderCreated: true, tradeNo: order.data.out_trade_no, paymentMethod: 'alipay', quoteCny: Number(quote.data), paid: false }));
