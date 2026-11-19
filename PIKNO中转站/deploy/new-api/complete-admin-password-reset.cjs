'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const administratorPath = path.join(require('./local-state.cjs').privateDir, 'administrator.json');
const expectedOrigin = 'https://www.piknoai.com';
const expectedPath = '/user/reset';
const expectedEmail = 'zhangfengyuan901@gmail.com';

async function readOneLine() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim()) return line.trim();
  }
  throw new Error('Reset URL was not supplied on stdin');
}

function loadAdministrator() {
  fs.accessSync(administratorPath, fs.constants.R_OK | fs.constants.W_OK);
  const administrator = JSON.parse(fs.readFileSync(administratorPath, 'utf8'));
  if (administrator.username !== 'piknoadmin' || !String(administrator.password || '')) {
    throw new Error('Unexpected administrator credential file');
  }
  return administrator;
}

async function main() {
  const administrator = loadAdministrator();
  const resetUrl = new URL(await readOneLine());
  if (resetUrl.origin !== expectedOrigin || resetUrl.pathname !== expectedPath) {
    throw new Error('Unexpected password reset URL');
  }
  const email = resetUrl.searchParams.get('email');
  const token = resetUrl.searchParams.get('token');
  if (email !== expectedEmail || !/^[a-f0-9]{32}$/i.test(token || '')) {
    throw new Error('Unexpected reset email or token shape');
  }

  const response = await fetch(`${expectedOrigin}/api/user/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok || body.success !== true || !/^[A-Za-z0-9]{12}$/.test(body.data || '')) {
    throw new Error('Password reset endpoint did not return a valid new password');
  }

  const updated = {
    ...administrator,
    password: body.data,
    recoveryEmail: expectedEmail,
    passwordUpdatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(administratorPath, `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  console.log(JSON.stringify({
    resetCompleted: true,
    credentialFileUpdated: true,
    recoveryEmailConfigured: true,
    passwordReturned: false,
    resetTokenReturned: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
