'use strict';
// Normal sign-in using the existing user-provided credential. One attempt only.
// Never reset passwords, bypass challenges, mint tokens or print credentials.
const fs = require('node:fs');
const path = require('node:path');
const base = 'https://www.piknoai.com';
async function main() {
  const privateDir = path.join(__dirname, 'private');
  const credentials = JSON.parse(fs.readFileSync(path.join(privateDir, 'administrator.json'), 'utf8'));
  if (credentials.username !== 'piknoadmin' || !credentials.password) throw new Error('Expected administrator credential unavailable');
  const keyResponse = await fetch(base + '/api/user/login/encryption-key', { redirect: 'error', signal: AbortSignal.timeout(20000) });
  const key = await keyResponse.json();
  if (!keyResponse.ok || !key.success || key.data?.enabled !== false) throw new Error('Interactive or encrypted login required; no credential sent');
  const response = await fetch(base + '/api/user/login', {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    signal: AbortSignal.timeout(25000),
  });
  const body = await response.json();
  if (!response.ok || !body.success || !body.data?.access_token || body.data.user?.role !== 100) {
    console.log(JSON.stringify({ authenticated: false, http: response.status, code: body.code || null, challengeRequired: !body.data?.access_token }));
    process.exitCode = 1; return;
  }
  const session = { accessToken: body.data.access_token, userId: body.data.user.id, expiresAt: body.data.access_expires_at };
  const check = await fetch(base + '/api/user/self', { headers: { Authorization: 'Bearer ' + session.accessToken, 'New-Api-User': String(session.userId) }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const self = await check.json();
  if (!check.ok || !self.success || self.data?.username !== 'piknoadmin' || self.data.role !== 100) throw new Error('Administrator identity verification failed');
  fs.writeFileSync(path.join(privateDir, 'admin-session.json'), JSON.stringify(session), { mode: 0o600 });
  console.log(JSON.stringify({ authenticated: true, role: self.data.role, expiresAt: session.expiresAt }));
}
main().catch(() => { console.error('Administrator sign-in unavailable; no retry or reset performed'); process.exitCode = 1; });
