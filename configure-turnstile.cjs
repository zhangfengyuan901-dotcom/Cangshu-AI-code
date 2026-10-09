'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');

const configPath = path.join(__dirname, 'private', 'turnstile.json');

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const key of ['widgetName', 'hostname', 'siteKey', 'secretKey']) {
    if (!String(config[key] || '').trim()) throw new Error(`Missing private Turnstile setting: ${key}`);
  }
  if (config.hostname !== 'www.piknoai.com') throw new Error('Unexpected Turnstile hostname');
  if (!config.siteKey.startsWith('0x') || !config.secretKey.startsWith('0x')) {
    throw new Error('Invalid Turnstile key shape');
  }
  return config;
}

async function verifySecret(secretKey) {
  const body = new URLSearchParams({ secret: secretKey, response: 'pikno-invalid-test-token' });
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  const codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
  if (!response.ok || codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    throw new Error('Cloudflare rejected the Turnstile secret');
  }
  if (result.success === true) throw new Error('Invalid test token unexpectedly passed Turnstile verification');
  return codes;
}

async function main() {
  const config = loadConfig();
  const request = await connect();
  const beforeStatus = await fetch(`${process.env.NEW_API_BASE || 'http://127.0.0.1:3100'}/api/status`, {
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  if (!beforeStatus.success || beforeStatus.data?.register_enabled !== false) {
    throw new Error('Refusing Turnstile setup unless the service is healthy and registration remains closed');
  }
  if (beforeStatus.data?.turnstile_check !== false) {
    throw new Error('Refusing staged setup while Turnstile enforcement is already enabled');
  }

  const verificationErrors = await verifySecret(config.secretKey);
  await request('/api/option/', 'PUT', { key: 'TurnstileSiteKey', value: config.siteKey });
  await request('/api/option/', 'PUT', { key: 'TurnstileSecretKey', value: config.secretKey });

  const afterStatus = await fetch(`${process.env.NEW_API_BASE || 'http://127.0.0.1:3100'}/api/status`, {
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  if (!afterStatus.success || afterStatus.data?.turnstile_site_key !== config.siteKey) {
    throw new Error('Turnstile site key verification failed');
  }
  if (afterStatus.data?.turnstile_check !== false || afterStatus.data?.register_enabled !== false) {
    throw new Error('Turnstile staging changed a public safety gate');
  }

  console.log(JSON.stringify({
    configured: true,
    hostname: config.hostname,
    widgetMode: 'managed',
    secretAcceptedByCloudflare: true,
    invalidProbeRejectedWith: verificationErrors,
    enforcementEnabled: false,
    registrationOpen: false,
    secretsReturned: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
