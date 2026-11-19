import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadRuntime, RELEASE_SHA256 } from './runtime.mjs';
import { createStorageClient } from './storage-client.mjs';
import { isControlPath, storageSecretValid } from './protocol.mjs';

const ENV_KEYS = ['TOOLS_ENABLED', 'TICKET_KEY', 'TOOLS_BRIDGE_SECRET', 'TOOLS_ADMIN_SECRET', 'RUNNINGHUB_API_KEY', 'RH_CONFIG_ENCRYPTION_KEY', 'RH_CONFIG_ENCRYPTION_PREVIOUS_KEYS'];
const SECRET_KEYS = ['TOOL_STORE_SECRET', ...ENV_KEYS.filter((key) => !['TOOLS_ENABLED'].includes(key))];

export async function readEnvironment(source) {
  const env = { ...source };
  // Existing encrypted configuration and KEK versions must be supplied unchanged.
  for (const name of SECRET_KEYS) {
    if (!source[name + '_FILE']) continue;
    if (source[name]) throw Error('Ambiguous secret configuration');
    env[name] = await readFile(source[name + '_FILE'], 'utf8');
  }
  return env;
}

export function validateEnvironment(env) {
  if (!storageSecretValid(env)) throw Error('Invalid transport secrets');
  if (!env.TOOLS_BRIDGE_SECRET || env.TOOLS_BRIDGE_SECRET.length < 32 || !env.TOOLS_ADMIN_SECRET || env.TOOLS_ADMIN_SECRET.length < 32 || env.TOOLS_ADMIN_SECRET === env.TOOLS_BRIDGE_SECRET || !env.TICKET_KEY || env.TICKET_KEY.length < 32 || [env.TOOLS_BRIDGE_SECRET, env.TOOLS_ADMIN_SECRET, env.TICKET_KEY].some((value) => /[\r\n]/.test(value)) || !/^[a-f0-9]{64}$/.test(env.RH_CONFIG_ENCRYPTION_KEY || '')) throw Error('Existing control secrets required');
  if (!['blocked', 'ecs'].includes(env.CONTROL_OWNER)) throw Error('Invalid control owner');
}

export function createControlServer({ runtime, env, media, maxConcurrent = 2 }) {
  validateEnvironment(env);
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) throw Error('Invalid concurrency bound');
  const bindings = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));
  bindings.MEDIA = media;
  let accepting = env.CONTROL_OWNER === 'ecs', active = 0;
  const drained = new Set();
  const queries = new Map();
  const dispatch = async (request) => {
    const url = new URL(request.url);
    const match = /^\/media\/v1\/tools\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname);
    if (request.method !== 'GET' || url.search || !match || ['status', 'config'].includes(match[1])) return runtime.fetch(request, bindings);
    const origin = request.headers.get('origin');
    if (origin && origin !== 'https://www.piknoai.com') return runtime.fetch(request, bindings);
    // The original expired R2 lease uses a constant-body ETag. One ECS process
    // coalesces only the identical authenticated query; no cross-credential reply.
    // Absent, empty and same-origin are equivalent in the pinned runtime. Other
    // origins go through its rejection path and cannot observe a shared response.
    const key = createHash('sha256').update(JSON.stringify([url.pathname, request.headers.get('authorization')])).digest('hex');
    let work = queries.get(key);
    if (!work) {
      work = Promise.resolve().then(() => runtime.fetch(request, bindings));
      queries.set(key, work);
    }
    try { return (await work).clone(); }
    finally { if (queries.get(key) === work) queries.delete(key); }
  };
  const publicHost = 'www.piknoai.com';
  const respond = (response, status, value) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, async (incoming, outgoing) => {
    if (incoming.url === '/healthz' && incoming.method === 'GET') return respond(outgoing, 200, { accepting, active, release_sha256: RELEASE_SHA256 });
    let parsed;
    try { parsed = new URL(incoming.url, 'https://' + publicHost); } catch { return respond(outgoing, 400, { error: 'CONTROL_REQUEST_REJECTED' }); }
    if (!incoming.url.startsWith('/') || incoming.url.startsWith('//') || parsed.origin !== 'https://' + publicHost || !isControlPath(parsed.pathname) || incoming.headers['content-encoding']) return respond(outgoing, 404, { error: 'CONTROL_NOT_FOUND' });
    if (!accepting || active >= maxConcurrent) return respond(outgoing, 503, { error: 'CONTROL_UNAVAILABLE' });
    const length = incoming.headers['content-length'];
    const maximum = parsed.pathname === '/media/v1/tools/uploads' && incoming.method === 'POST' ? 50 << 20 : 65536;
    if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) return respond(outgoing, 413, { error: 'CONTROL_BODY_REJECTED' });
    active++;
    try {
      const headers = new Headers();
      for (const name of ['authorization', 'content-type', 'content-length', 'origin', 'range', 'x-pikno-edge-ticket', 'x-pikno-user']) {
        if (typeof incoming.headers[name] === 'string') headers.set(name, incoming.headers[name]);
      }
      const hasBody = !['GET', 'HEAD'].includes(incoming.method);
      const request = new Request(parsed, { method: incoming.method, headers, ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      // A downstream disconnect must not replay or abort a dispatched paid operation.
      const response = await dispatch(request);
      if (outgoing.destroyed) { await response.body?.cancel(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body || incoming.method === 'HEAD') { await response.body?.cancel(); outgoing.end(); }
      else await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(response.body);
        outgoing.once('close', () => { stream.destroy(); resolve(); });
        outgoing.once('finish', resolve);
        stream.once('error', reject);
        stream.pipe(outgoing);
      });
    } catch {
      if (!outgoing.headersSent) respond(outgoing, 502, { error: 'CONTROL_RESPONSE_UNCERTAIN' });
      else outgoing.destroy();
    } finally {
      active--;
      if (active === 0) { for (const done of drained) done(); drained.clear(); }
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 180000;
  server.timeout = 0;
  return {
    server,
    state: () => ({ accepting, active }),
    async drain() {
      accepting = false;
      if (active > 0) await new Promise((resolve) => drained.add(resolve));
    },
    async close() {
      accepting = false;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await this.drain();
      server.closeIdleConnections();
      await closed;
    },
  };
}

export async function start(source = process.env) {
  const env = await readEnvironment(source);
  validateEnvironment(env);
  const runtime = await loadRuntime();
  const media = createStorageClient({ origin: env.TOOL_STORE_ORIGIN, secret: env.TOOL_STORE_SECRET });
  const control = createControlServer({ runtime, media, env, maxConcurrent: Number(env.CONTROL_MAX_CONCURRENT || 2) });
  const host = env.CONTROL_BIND || '127.0.0.1', port = Number(env.CONTROL_PORT || 8090);
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('Invalid listen address');
  await new Promise((resolve, reject) => { control.server.once('error', reject); control.server.listen(port, host, resolve); });
  return control;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const control = await start();
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      // No forced termination timer: wait for original upstream operations to drain.
      await control.close();
    });
    process.stdout.write(JSON.stringify({ event: 'CONTROL_LISTENING', release_sha256: RELEASE_SHA256 }) + '\n');
  } catch {
    process.stderr.write('{"event":"CONTROL_START_REJECTED"}\n');
    process.exitCode = 1;
  }
}
