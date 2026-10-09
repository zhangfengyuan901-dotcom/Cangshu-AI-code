'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');

const configPath = path.join(__dirname, 'private', 'resend.json');

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const required = ['domain', 'smtpHost', 'smtpPort', 'smtpAccount', 'smtpFrom', 'apiKey'];
  for (const key of required) {
    if (config[key] === undefined || String(config[key]).trim() === '') {
      throw new Error(`Missing private Resend setting: ${key}`);
    }
  }
  if (config.domain !== 'mail.piknoai.com') throw new Error('Unexpected Resend sending domain');
  if (config.smtpHost !== 'smtp.resend.com') throw new Error('Unexpected SMTP host');
  if (Number(config.smtpPort) !== 465) throw new Error('Production SMTP must use implicit TLS on port 465');
  if (config.smtpAccount !== 'resend') throw new Error('Unexpected Resend SMTP account');
  if (!config.smtpFrom.endsWith('@mail.piknoai.com')) throw new Error('SMTP sender must use the verified sending domain');
  if (!config.apiKey.startsWith('re_')) throw new Error('Invalid Resend API key shape');
  return config;
}

async function main() {
  const config = loadConfig();
  const request = await connect();
  const before = await request('/api/option/');
  const optionMap = new Map(before.map(({ key, value }) => [key, value]));
  if (optionMap.get('RegisterEnabled') !== 'false' || optionMap.get('PasswordRegisterEnabled') !== 'false') {
    throw new Error('Refusing SMTP setup while public registration is open');
  }

  const options = {
    SMTPServer: config.smtpHost,
    SMTPPort: String(config.smtpPort),
    SMTPAccount: config.smtpAccount,
    SMTPFrom: config.smtpFrom,
    SMTPToken: config.apiKey,
    SMTPSSLEnabled: 'true',
    SMTPStartTLSEnabled: 'false',
    SMTPInsecureSkipVerify: 'false',
    SMTPForceAuthLogin: 'false',
  };
  for (const [key, value] of Object.entries(options)) {
    await request('/api/option/', 'PUT', { key, value });
  }

  const after = await request('/api/option/');
  const saved = new Map(after.map(({ key, value }) => [key, value]));
  for (const [key, value] of Object.entries(options)) {
    if (key === 'SMTPToken') continue;
    if (saved.get(key) !== value) throw new Error(`SMTP verification failed: ${key}`);
  }
  if (saved.get('RegisterEnabled') !== 'false' || saved.get('PasswordRegisterEnabled') !== 'false') {
    throw new Error('Registration safety invariant changed during SMTP setup');
  }
  console.log(JSON.stringify({
    configured: true,
    host: config.smtpHost,
    port: config.smtpPort,
    sender: config.smtpFrom,
    implicitTls: true,
    registrationOpen: false,
    secretReturned: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
