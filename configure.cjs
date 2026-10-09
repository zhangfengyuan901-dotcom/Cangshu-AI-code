'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const base = 'http://127.0.0.1:3100';
  const { username, password } = JSON.parse(fs.readFileSync(path.join(__dirname, 'private', 'administrator.json'), 'utf8'));
  const login = await fetch(`${base}/api/user/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(r => r.json());
  if (!login.success || !login.data.access_token) throw new Error(login.message || 'Login failed');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.data.access_token}`,
    'New-Api-User': String(login.data.user.id),
  };
  const options = {
    SystemName: 'PIKNO AI',
    RegisterEnabled: 'true',
    PasswordRegisterEnabled: 'true',
    EmailVerificationEnabled: 'true',
    'general_setting.docs_link': '',
    HeaderNavModules: JSON.stringify({
      home: true,
      console: true,
      pricing: { enabled: true, requireAuth: false },
      rankings: { enabled: true, requireAuth: false },
      docs: false,
      about: false,
    }),
    'passkey.rp_display_name': 'PIKNO AI',
    QuotaForNewUser: '0',
    QuotaForInviter: '0',
    QuotaForInvitee: '0',
  };
  for (const [key, value] of Object.entries(options)) {
    const result = await fetch(`${base}/api/option/`, {
      method: 'PUT', headers, body: JSON.stringify({ key, value }),
    }).then(r => r.json());
    if (!result.success) throw new Error(`${key}: ${result.message}`);
    console.log(`Configured ${key}`);
  }
  const saved = await fetch(`${base}/api/option/`, { headers }).then(r => r.json());
  if (!saved.success) throw new Error('Could not verify saved options');
  for (const [key, value] of Object.entries(options)) {
    if (saved.data.find(row => row.key === key)?.value !== value) throw new Error(`Verification failed: ${key}`);
  }
  console.log('Verified brand and email-verified registration. Upstream configuration is still pending.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
