'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envPath = require('./local-state.cjs').envPath;
const privateDir = require('./local-state.cjs').privateDir;
const credentialsPath = path.join(privateDir, 'administrator.json');
if (fs.existsSync(envPath) || fs.existsSync(credentialsPath)) {
  throw new Error('Existing secrets found; refusing to replace credentials.');
}
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const secret = () => crypto.randomBytes(32).toString('hex');
fs.writeFileSync(envPath, [
  `POSTGRES_PASSWORD=${secret()}`,
  `REDIS_PASSWORD=${secret()}`,
  `SESSION_SECRET=${secret()}`,
  `CRYPTO_SECRET=${secret()}`,
  'SESSION_COOKIE_SECURE=false',
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(credentialsPath, JSON.stringify({
  username: 'piknoadmin',
  password: `Pk!${crypto.randomBytes(24).toString('base64url')}9a`,
  localUrl: 'http://127.0.0.1:3100',
  intendedPublicUrl: 'https://www.piknoai.com',
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Generated fresh secrets. Administrator credentials: ' + credentialsPath);
