// Loopback-only synthetic authentication and account fixture. No live transport.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(process.env.HAMSTER_TRIM_QA_DIST || new URL('../../../deploy/new-api/backend/web/dist/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
let scenario = { signedIn: false, role: 1, challenge: false, turnstile: false, loseLogin: false, loseReset: false };
const calls = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const ok = data => json({ success: true, data });
  const legacySidebar = () => scenario.hiddenSidebar ? JSON.stringify({ admin: { enabled: false, channel: false }, console: { enabled: false }, personal: { enabled: false } }) : '';
  const bundle = () => ({ access_token: 'synthetic-memory-only', token_type: 'Bearer', access_expires_at: Date.now() / 1000 + 3600, user: { id: 12, username: 'synthetic', display_name: '验收账户', role: scenario.role, permissions: { sidebar_settings: false }, sidebar_modules: legacySidebar() }, session: { sid: 'synthetic-session', current: true, login_method: 'password', ip: '', user_agent: '', created_at: Date.now() / 1000, last_active_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 } });
  const authenticated = () => { scenario.signedIn = true; res.setHeader('Set-Cookie', 'new_api_has_session=1; Path=/; SameSite=Strict'); return ok(bundle()); };
  try {
    if (url.pathname === '/__qa/scenario') { scenario = { signedIn: false, role: 1, challenge: false, turnstile: false, loseLogin: false, loseReset: false, ...Object.fromEntries([...url.searchParams].map(([key, value]) => [key, ['true', 'false'].includes(value) ? value === 'true' : Number(value)])) }; calls.length = 0; return ok({ scenario }); }
    if (url.pathname === '/__qa/state') return ok({ calls, signedIn: scenario.signedIn });
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : {};
      const call = { path: url.pathname, method: req.method };
      calls.push(call);
      if (url.pathname === '/api/status') return ok({ system_name: 'Legacy PIKNO', quota_per_unit: 7300000, usd_exchange_rate: 7.3, password_login_enabled: true, password_login_encryption_enabled: true, register_enabled: true, password_register_enabled: true, email_verification: true, turnstile_check: scenario.turnstile, turnstile_site_key: 'synthetic-site-key', user_agreement_enabled: false, privacy_policy_enabled: false, HeaderNavModules: '{}', SidebarModulesAdmin: legacySidebar(), passkey_login: true });
      if (url.pathname === '/api/setup') return ok({ status: true });
      if (url.pathname === '/api/user/login/encryption-key') return ok({ kid: 'qa-public', public_key: publicKey });
      if (url.pathname === '/api/user/login') {
        if (body.password) return json({ success: false }, 400);
        const decrypted = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.password_encrypted || '', 'base64')).toString();
        call.encrypted = decrypted === 'synthetic-password';
        if (!call.encrypted) return json({ success: false }, 401);
        if (scenario.loseLogin) return json({ success: false }, 503);
        if (scenario.challenge) return ok({ require_verification: true, flow_token: 'synthetic-memory-flow', expires_at: Date.now() / 1000 + 300, methods: [{ method: '2fa', available: true }] });
        return authenticated();
      }
      if (url.pathname === '/api/user/login/verify') {
        call.validContract = body.flow_token === 'synthetic-memory-flow' && body.method === '2fa' && body.code === '123456';
        return call.validContract ? authenticated() : json({ success: false }, 401);
      }
      if (url.pathname === '/api/user/register') { call.affAbsent = !Object.hasOwn(body, 'aff_code'); return ok(null); }
      if (['/api/verification', '/api/reset_password'].includes(url.pathname)) return ok(null);
      if (url.pathname === '/api/user/reset') { call.resetContract = body.email === 'synthetic@example.test' && body.token === 'synthetic-mail-token'; if (scenario.loseReset) return json({ success: false }, 503); return ok('synthetic-new-password'); }
      if (url.pathname === '/api/user/auth/refresh') return scenario.signedIn ? ok(bundle()) : json({ success: false }, 401);
      if (url.pathname === '/api/user/auth/logout') { scenario.signedIn = false; return ok(null); }
      if (!scenario.signedIn) return json({ success: false }, 401);
      if (url.pathname === '/api/user/self') return ok({ id: 12, username: 'synthetic', role: scenario.role, quota: 128500000, used_quota: 1200000, request_count: 4 });
      if (url.pathname === '/api/user/self/groups') return ok(Object.fromEntries(['image', 'video', 'tool', 'chat'].map(kind => [kind + '-standard', { ratio: 1 }])));
      if (['/api/log/self', '/api/pikno/settlements/self', '/api/user/topup/self', '/api/log/', '/api/user/', '/api/channel/', '/api/channel'].includes(url.pathname)) return ok({ total: 0, items: [] });
      if (url.pathname === '/api/pikno/lines/admin') return ok({ lines: [] });
      if (url.pathname === '/api/user/topup/info') return ok({ fixed_cny_topup: true, enable_online_topup: true, payment_compliance_confirmed: true, pay_methods: [{ type: 'alipay' }, { type: 'wxpay' }], amount_options: [50, 100, 200] });
      if (url.pathname === '/api/user/amount') return ok(String(body.amount));
      if (url.pathname === '/api/token/') return ok({ total: 0, items: [] });
      if (url.pathname === '/api/option/') return ok([]);
      if (url.pathname === '/api/notice') return ok('简短公告，无需公式渲染。');
      if (url.pathname.startsWith('/api/pikno/')) return ok({ items: [], total: 0, data: [], models: [] });
      return ok(null);
    }
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); return res.end(); }
    if (!path.extname(file)) file = path.join(root, 'index.html');
    const bytes = await readFile(file), mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(bytes);
  } catch { json({ success: false }, 500); }
});
server.listen(Number(process.env.HAMSTER_TRIM_QA_PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({ synthetic: true, base: `http://127.0.0.1:${server.address().port}`, pid: process.pid })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
