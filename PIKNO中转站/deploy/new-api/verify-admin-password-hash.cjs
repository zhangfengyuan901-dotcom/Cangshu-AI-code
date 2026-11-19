'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { argon2Sync, timingSafeEqual } = require('node:crypto');

const administratorPath = path.join(require('./local-state.cjs').privateDir, 'administrator.json');

async function readOneLine() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim()) return line.trim();
  }
  throw new Error('Password hash was not supplied on stdin');
}

function verifyArgon2id(password, encoded) {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return false;
  const parameters = Object.fromEntries(parts[3].split(',').map((item) => item.split('=')));
  if (parameters.m !== '19456' || parameters.t !== '2' || parameters.p !== '1') return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = argon2Sync('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: 1,
    tagLength: expected.length,
    memory: 19456,
    passes: 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function main() {
  const hash = await readOneLine();
  const administrator = JSON.parse(fs.readFileSync(administratorPath, 'utf8'));
  if (administrator.username !== 'piknoadmin' || !administrator.password) {
    throw new Error('Unexpected administrator credential file');
  }
  if (!hash.startsWith('$argon2id$')) throw new Error('Unexpected password hash algorithm');
  if (!verifyArgon2id(administrator.password, hash)) {
    throw new Error('Stored administrator credential does not match the production password hash');
  }
  console.log(JSON.stringify({ passwordHashMatchesCredential: true, secretsReturned: false }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
