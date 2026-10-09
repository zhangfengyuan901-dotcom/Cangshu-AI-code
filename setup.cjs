'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'private', 'administrator.json'), 'utf8'));
  const base = 'http://127.0.0.1:3100';
  const status = await fetch(`${base}/api/setup`).then(r => r.json());
  if (!status.success) throw new Error('Could not check initialization status');
  if (status.data.status) {
    console.log('Already initialized; no changes made.');
    return;
  }
  if (status.data.root_init) throw new Error('A root account already exists; manual review required.');
  const result = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password,
      confirmPassword: credentials.password,
      SelfUseModeEnabled: false,
      DemoSiteEnabled: false,
    }),
  }).then(r => r.json());
  if (!result.success) throw new Error(result.message || 'Initialization failed');
  console.log('Administrator initialized. No upstream channels or paid requests created.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
