'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, 'private', 'resend.json');

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const email = String(config.testRecipient || '').trim().toLowerCase();
  const base = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Set a valid private testRecipient first');

  const status = await fetch(`${base}/api/status`, {
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  if (!status.success || status.data?.register_enabled !== false) {
    throw new Error('Refusing mail test unless the service is healthy and registration remains closed');
  }

  const response = await fetch(`${base}/api/verification?email=${encodeURIComponent(email)}`, {
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.message || `HTTP ${response.status}`);
  console.log(JSON.stringify({ sent: true, recipient: maskEmail(email), registrationOpen: false }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
