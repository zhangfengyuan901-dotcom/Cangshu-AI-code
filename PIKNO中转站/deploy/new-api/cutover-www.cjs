'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const accountId = 'd9203440125f1b112668d39a5efd64c9';
const zoneId = 'd4a1f8cdf4b9be64d85c24436ce5725d';
const tunnelReceipt = JSON.parse(fs.readFileSync(path.join(require('./local-state.cjs').privateDir, 'tunnel.json'), 'utf8'));
const tunnelId = tunnelReceipt.id;
const tunnelTarget = `${tunnelId}.cfargotunnel.com`;
const wrangler = path.resolve(__dirname, '../../tools/relay-cli/node_modules/wrangler/bin/wrangler.js');
const wranglerCwd = path.resolve(__dirname, '../../tools/relay-cli');
const mode = process.argv[2] || 'inspect';

if (!['inspect', 'inspect-tunnel', 'stage', 'stage-tunnel', 'finalize', 'finalize-tunnel', 'remove-api-dns'].includes(mode)) {
  throw new Error('Usage: node cutover-www.cjs inspect|inspect-tunnel|stage|stage-tunnel|finalize|finalize-tunnel|remove-api-dns');
}

async function main() {
  if (tunnelReceipt.accountId !== accountId || tunnelReceipt.name !== 'piknoai-relay') {
    throw new Error('Tunnel receipt does not match the expected account and tunnel name');
  }
  const auth = JSON.parse(execFileSync(process.execPath, [wrangler, 'auth', 'token', '--json', '--profile', 'pikno'], {
    cwd: wranglerCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  async function api(route, method = 'GET', body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
      method,
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(`${method} ${route}: ${JSON.stringify(json.errors)}`);
    return json.result;
  }
  const recordsFor = name => api(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  const summarizeRecords = records => records.map(({ type, name, content, proxied }) => ({ type, name, content, proxied }));
  const inspectTunnel = async () => {
    const configuration = await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
    return { ingress: configuration.config.ingress };
  };
  const inspect = async () => {
    const [configuration, apiRecords, wwwRecords] = await Promise.all([
      api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`),
      recordsFor('api.piknoai.com'),
      recordsFor('www.piknoai.com'),
    ]);
    return {
      ingress: configuration.config.ingress,
      apiDns: summarizeRecords(apiRecords),
      wwwDns: summarizeRecords(wwwRecords),
    };
  };

  if (mode === 'inspect-tunnel') {
    console.log(JSON.stringify(await inspectTunnel(), null, 2));
    return;
  }
  if (mode === 'inspect') {
    console.log(JSON.stringify(await inspect(), null, 2));
    return;
  }

  if (mode === 'stage-tunnel') {
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, 'PUT', {
      config: { ingress: [
        { hostname: 'www.piknoai.com', service: 'http://new-api:3000' },
        { hostname: 'api.piknoai.com', service: 'http://new-api:3000' },
        { service: 'http_status:404' },
      ] },
    });
    console.log(JSON.stringify({ mode, state: await inspectTunnel() }, null, 2));
    return;
  }
  if (mode === 'stage') {
    const wwwRecords = await recordsFor('www.piknoai.com');
    const conflicts = wwwRecords.filter(record => record.type !== 'CNAME');
    if (conflicts.length || wwwRecords.filter(record => record.type === 'CNAME').length > 1) {
      throw new Error('www.piknoai.com has conflicting DNS records; refusing automatic replacement');
    }
    const cname = wwwRecords.find(record => record.type === 'CNAME');
    const dnsPayload = { type: 'CNAME', name: 'www', content: tunnelTarget, ttl: 1, proxied: true };
    if (cname) await api(`/zones/${zoneId}/dns_records/${cname.id}`, 'PUT', dnsPayload);
    else await api(`/zones/${zoneId}/dns_records`, 'POST', dnsPayload);
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, 'PUT', {
      config: { ingress: [
        { hostname: 'www.piknoai.com', service: 'http://new-api:3000' },
        { hostname: 'api.piknoai.com', service: 'http://new-api:3000' },
        { service: 'http_status:404' },
      ] },
    });
    console.log(JSON.stringify({ mode, state: await inspect() }, null, 2));
    return;
  }

  if (mode === 'finalize-tunnel') {
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, 'PUT', {
      config: { ingress: [
        { hostname: 'www.piknoai.com', service: 'http://new-api:3000' },
        { service: 'http_status:404' },
      ] },
    });
    console.log(JSON.stringify({ mode, state: await inspectTunnel() }, null, 2));
    return;
  }
  if (mode === 'finalize') {
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, 'PUT', {
      config: { ingress: [
        { hostname: 'www.piknoai.com', service: 'http://new-api:3000' },
        { service: 'http_status:404' },
      ] },
    });
    console.log(JSON.stringify({ mode, state: await inspect() }, null, 2));
    return;
  }

  const apiRecords = await recordsFor('api.piknoai.com');
  const unexpected = apiRecords.filter(record => record.type !== 'CNAME' || record.content !== tunnelTarget);
  if (unexpected.length) throw new Error('api.piknoai.com contains an unexpected DNS record; refusing deletion');
  for (const record of apiRecords) await api(`/zones/${zoneId}/dns_records/${record.id}`, 'DELETE');
  console.log(JSON.stringify({ mode, removed: apiRecords.length, state: await inspect() }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
