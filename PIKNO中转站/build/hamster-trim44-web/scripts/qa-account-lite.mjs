// Isolated UI fixture: synthetic accounts and payment records only, no upstream traffic.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = path.resolve(process.env.HAMSTER_ACCOUNT_QA_DIST || fileURLToPath(new URL('../public/', import.meta.url)));
let signedIn = true, accountID = 12;
let tokens = [{ id: 7, user_id: 12, name: '我的图片工作台', group: 'image-standard', status: 1, unlimited_quota: true, remain_quota: 0, expired_time: -1, created_time: Math.floor(Date.now() / 1000) - 3600 }];
let orders = []; const calls = [];
const created = Math.floor(Date.now() / 1000);
// Match GetTokenKey: the service reveals a raw 48-character key, not an sk- credential.
const fixtureKey = (token) => `${({ 'image-standard': 'i', 'video-standard': 'v', 'tool-standard': 't', 'chat-standard': 'c' })[token.group]}${String(token.user_id).padStart(9, '0')}${String(token.id).padStart(9, '0')}${'q'.repeat(29)}`;
const server = createServer(async (req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`, url = new URL(req.url, base);
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const ok = (data) => json({ success: true, data });
  try {
    if (url.pathname === '/__qa/state') return ok({ calls, orders, tokens, accountID, signedIn });
    if (url.pathname === '/__qa/account') { accountID = Number(url.searchParams.get('id')) || 12; signedIn = url.searchParams.get('signedIn') !== 'false'; return ok({ accountID, signedIn }); }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : null;
      calls.push({ path: url.pathname, method: req.method, body: url.pathname.includes('/key') ? undefined : body });
      if (url.pathname === '/api/status') return ok({ quota_per_unit: 7300000, usd_exchange_rate: 7.3 });
      if (url.pathname === '/api/user/auth/refresh') return signedIn ? ok({ access_token: 'fixture-session-access', access_expires_at: created + 3600, user: { id: accountID, username: '灵感收藏家', display_name: '灵感收藏家' }, session: { sid: `fixture-${accountID}` } }) : json({ success: false }, 401);
      if (url.pathname === '/api/user/auth/logout') { signedIn = false; return ok({}); }
      if (!signedIn || req.headers.authorization !== 'Bearer fixture-session-access') return json({ success: false }, 401);
      if (url.pathname === '/api/user/self') return ok({ id: accountID, quota: 128500000, used_quota: 21500000, request_count: 48 });
      if (url.pathname === '/api/user/self/groups') return ok(Object.fromEntries(['image-standard', 'video-standard', 'tool-standard', 'chat-standard'].map((name) => [name, { ratio: 1 }])));
      if (url.pathname === '/api/log/self') return ok({ total: 2, items: [{ id: 1, model_name: '图片生成', quota: 1500000, token_name: '我的图片工作台', created_at: created - 1800 }, { id: 2, model_name: 'AI 对话', quota: 30000, created_at: created - 3600 }] });
      if (url.pathname === '/api/pikno/settlements/self') return ok({ total: 1, items: [{ order_id: 'fixture-task-1', model: '视频生成', financial_state: 'pending_review', review_required: true, net_quota: 0, refunded_quota: 0, reserved_quota: 6000000, created_at: created - 1200 }] });
      if (url.pathname === '/api/user/topup/info') return ok({ fixed_cny_topup: true, enable_online_topup: true, payment_compliance_confirmed: true, pay_methods: [{ type: 'alipay' }, { type: 'wxpay' }], amount_options: [50, 100, 200] });
      if (url.pathname === '/api/user/amount') return ok(String(body.amount));
      if (url.pathname === '/api/user/topup/self') return ok({ total: orders.length, items: orders });
      if (url.pathname === '/api/user/pay') {
        const order = { trade_no: `USR${accountID}NOfixture${orders.length + 1}`, money: body.amount, payment_method: body.payment_method, create_time: created, status: 'pending' }; orders.unshift(order);
        return json({ message: 'success', url: `${base}/pay/lanjing/epay/submit.php`, data: { pid: 'fixture', type: body.payment_method, out_trade_no: order.trade_no, notify_url: `${base}/api/user/epay/notify`, return_url: `${base}/usage-logs`, name: 'fixture-topup', money: `${body.amount}.00`, sign_type: 'MD5', sign: '0'.repeat(32) } });
      }
      if (url.pathname === '/api/token/' && req.method === 'GET') { const owned = tokens.filter((token) => token.user_id === accountID); return ok({ total: owned.length, items: owned }); }
      if (url.pathname === '/api/token/' && req.method === 'POST') { tokens.push({ ...body, user_id: accountID, created_time: Math.floor(Date.now() / 1000), id: Math.max(7, ...tokens.map((token) => token.id)) + 1, status: 1 }); return ok({}); }
      if (url.pathname === '/api/token/search') { const found = tokens.filter((token) => token.user_id === accountID && token.name.includes(url.searchParams.get('keyword') || '')); return ok({ total: found.length, items: found }); }
      if (url.pathname === '/api/token/' && req.method === 'PUT') { tokens.find((token) => token.id === body.id).status = body.status; return ok({}); }
      const key = /^\/api\/token\/(\d+)\/key$/.exec(url.pathname); if (key) { const token = tokens.find((item) => item.id === Number(key[1]) && item.user_id === accountID); return token ? ok({ key: fixtureKey(token) }) : json({ success: false }, 404); }
      const removed = /^\/api\/token\/(\d+)\/$/.exec(url.pathname); if (removed && req.method === 'DELETE') { tokens = tokens.filter((token) => token.id !== Number(removed[1])); return ok({}); }
      return json({ success: false, message: 'Unknown fixture route' }, 404);
    }
    if (url.pathname === '/pay/lanjing/epay/submit.php') { const chunks = []; for await (const chunk of req) chunks.push(chunk); const form = new URLSearchParams(Buffer.concat(chunks).toString()); calls.push({ path: url.pathname, method: req.method, fields: [...form.keys()] }); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }); return res.end('<html lang="zh-CN"><title>离线支付示例</title><h1>离线支付示例</h1><p>仅展示合成订单，没有发起真实支付。</p></html>'); }
    if (url.pathname === '/') { res.writeHead(302, { location: '/account-lite/index.html' }); return res.end(); }
    if (url.pathname === '/__qa/frame') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<html lang="zh-CN"><title>隔离子框架</title><p>仅验证子框架没有原生接入能力。</p></html>'); }
    if (['/sign-in', '/sign-up', '/forgot-password'].includes(url.pathname)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<html lang="zh-CN"><title>离线登录入口</title><p>正式版本使用原有安全登录流程；此页为合成入口。</p></html>'); }
    const target = path.resolve(publicDir, '.' + decodeURIComponent(url.pathname)); if (!target.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
    const body = await readFile(target); const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  } catch { json({ success: false, message: 'Fixture failed' }, 500); }
});
server.listen(Number(process.env.HAMSTER_ACCOUNT_QA_PORT || 11149), '127.0.0.1', () => process.stdout.write(JSON.stringify({ base: `http://127.0.0.1:${server.address().port}`, synthetic: true, pid: process.pid }) + '\n'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
