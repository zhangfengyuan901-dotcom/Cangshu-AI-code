'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');

const configPath = path.join(require('./local-state.cjs').privateDir, 'turnstile.json');

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!String(config.siteKey || '').startsWith('0x') || !String(config.secretKey || '').startsWith('0x')) {
    throw new Error('Turnstile private configuration is incomplete');
  }

  const base = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
  const request = await connect();
  const before = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(10000) }).then((response) => response.json());
  if (!before.success || before.data?.register_enabled !== false || before.data?.password_register_enabled !== false) {
    throw new Error('Refusing Turnstile rollout unless registration remains closed');
  }
  if (before.data?.turnstile_site_key !== config.siteKey) {
    throw new Error('Staged Turnstile site key does not match the private configuration');
  }

  await request('/api/option/', 'PUT', { key: 'TurnstileCheckEnabled', value: 'true' });
  const after = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(10000) }).then((response) => response.json());
  if (!after.success || after.data?.turnstile_check !== true) throw new Error('Turnstile enforcement did not become active');
  if (after.data?.register_enabled !== false || after.data?.password_register_enabled !== false) {
    throw new Error('Registration safety invariant changed during Turnstile rollout');
  }

  console.log(JSON.stringify({
    enabled: true,
    hostname: config.hostname,
    registrationOpen: false,
    passwordRegistrationOpen: false,
    secretsReturned: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
