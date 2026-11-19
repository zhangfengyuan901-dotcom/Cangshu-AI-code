'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const accountId = 'd9203440125f1b112668d39a5efd64c9';
const name = 'piknoai-relay';
const credentialsDir = require('./local-state.cjs').privateDir;

async function main() {
  const wrangler = path.resolve(__dirname, '../../tools/relay-cli/node_modules/wrangler/bin/wrangler.js');
  const auth = JSON.parse(execFileSync(process.execPath, [wrangler, 'auth', 'token', '--json', '--profile', 'pikno'], {
    cwd: path.resolve(__dirname, '../../tools/relay-cli'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  async function api(route, method = 'GET', body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
      method, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(`${method} ${route}: ${JSON.stringify(json.errors)}`);
    return json.result;
  }
  const tunnels = await api(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${name}`);
  let tunnel = tunnels.find(item => item.name === name);
  const receiptPath = path.join(credentialsDir, 'tunnel.json');
  if (tunnel) {
    if (!fs.existsSync(receiptPath) || JSON.parse(fs.readFileSync(receiptPath, 'utf8')).id !== tunnel.id) {
      throw new Error('An existing tunnel has this name but no matching local receipt; refusing to alter it.');
    }
  } else {
    tunnel = await api(`/accounts/${accountId}/cfd_tunnel`, 'POST', { name, config_src: 'cloudflare' });
    fs.writeFileSync(receiptPath, JSON.stringify({ id: tunnel.id, accountId, name }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, 'PUT', {
    config: { ingress: [
      { hostname: 'www.piknoai.com', service: 'http://new-api:3000' },
      { service: 'http_status:404' },
    ] },
  });
  const tokenPath = path.join(credentialsDir, 'tunnel-token.txt');
  if (!fs.existsSync(tokenPath)) {
    const token = await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
    fs.writeFileSync(tokenPath, token + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ tunnel: name, id: tunnel.id, hostname: 'www.piknoai.com', cname: `${tunnel.id}.cfargotunnel.com` }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
