'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Local-only administrative requests; secrets never enter command-line arguments.
async function connect() {
  const base = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
  const sessionFile = path.join(__dirname, 'private/admin-session.json');
  let session;
  if (process.env.PIKNO_ADMIN_ACCESS_TOKEN && process.env.PIKNO_ADMIN_USER_ID) {
    session = { accessToken: process.env.PIKNO_ADMIN_ACCESS_TOKEN, userId: process.env.PIKNO_ADMIN_USER_ID };
  } else if (fs.existsSync(sessionFile)) {
    session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } else {
    const { username, password } = JSON.parse(fs.readFileSync(path.join(__dirname, 'private/administrator.json'), 'utf8'));
    const response = await fetch(base + '/api/user/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(20000),
    });
    const login = await response.json();
    if (!response.ok || !login.success || !login.data?.access_token) throw new Error('Local administrator login failed');
    session = { accessToken: login.data.access_token, userId: login.data.user.id };
  }
  if (!session.accessToken || !session.userId) throw new Error('Administrator session is missing');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.accessToken, 'New-Api-User': String(session.userId) };
  return async function request(route, method = 'GET', payload) {
    const result = await fetch(base + route, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const body = await result.json();
    if (!result.ok || !body.success) throw new Error(route + ': ' + (body.message || 'HTTP ' + result.status));
    return body.data;
  };
}
module.exports = { connect };
