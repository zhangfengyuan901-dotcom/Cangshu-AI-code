import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createControlServer, readEnvironment } from '../server.mjs';
import { loadRuntime } from '../runtime.mjs';
import { isAssetPath } from '../protocol.mjs';
import { createUploadLimiter, loadAssetRuntime } from './asset-runtime.mjs';
import { createPresignedUpload } from './presigned-upload.mjs';
import { createPresignRoute, isPresignPath } from './presign-route.mjs';
import { createStorageHandler, STORAGE_PATH } from './proxy.mjs';
import { createTosStorage } from './storage.mjs';

const origin = 'https://origin.piknoai.com';
const namespaces = {
  'pikno-relay-inputs': 'TOS_RELAY_PROXY_SECRET_FILE',
  'hamster-ai-media': 'TOS_LEGACY_MEDIA_PROXY_SECRET_FILE',
  'hamster-billing-results': 'TOS_LEGACY_BILLING_PROXY_SECRET_FILE',
};

async function readSecret(source, name) {
  if (!source[name] || typeof source[name] !== 'string') throw Error('TOS secret file required');
  const value = (await readFile(source[name], 'utf8')).trim();
  if (!value || /[\r\n]/.test(value)) throw Error('TOS secret file rejected');
  return value;
}

export function attachStorageGateway(server, handler, { maximum = 2, assetHandler, presignHandler } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4) throw Error('Invalid storage concurrency');
  const [prior] = server.listeners('request');
  if (typeof prior !== 'function' || server.listenerCount('request') !== 1) throw Error('Invalid existing control server');
  server.removeListener('request', prior);
  const active = { storage: 0, upload: 0, assetRead: 0, signing: 0 };
  // A stalled public PUT must not occupy the slots used to inspect its outcome.
  // Legacy storage remains bounded separately, including all legacy writes.
  const limits = { storage: maximum, upload: 2, assetRead: 2, signing: 4 };
  let accepting = true;
  server.on('request', async (incoming, outgoing) => {
    if (incoming.destroyed || outgoing.destroyed) return;
    const storagePath = incoming.url?.startsWith(STORAGE_PATH);
    const pathname = incoming.url?.split('?', 1)[0] ?? '';
    const presign = presignHandler && isPresignPath(pathname);
    const assetPath = presign || assetHandler && isAssetPath(pathname);
    if (!storagePath && !assetPath) return prior(incoming, outgoing);
    if (assetPath && incoming.headers.host !== 'www.piknoai.com') {
      outgoing.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
      outgoing.end();
      return;
    }
    const pool = storagePath ? 'storage' : presign ? 'signing' : incoming.method === 'PUT' ? 'upload' : 'assetRead';
    if (!accepting || active[pool] >= limits[pool]) {
      outgoing.writeHead(503, { 'cache-control': 'no-store', connection: 'close' });
      outgoing.end();
      return;
    }
    active[pool]++;
    const closeIncompleteBody = () => {
      if (!incoming.complete && !incoming.destroyed) incoming.destroy();
    };
    const presignTimeout = presign && setTimeout(closeIncompleteBody, 5000);
    outgoing.once('close', closeIncompleteBody);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const hasBody = ['PUT', 'POST'].includes(incoming.method);
      const request = new Request((assetPath ? 'https://www.piknoai.com' : origin) + incoming.url, { method: incoming.method, headers,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      const response = await (presign ? presignHandler(request) : assetPath ? assetHandler(request) : handler(request));
      if (outgoing.destroyed) { await response.body?.cancel(); return; }
      if (!incoming.complete) outgoing.setHeader('connection', 'close');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { outgoing.end(); return; }
      await pipeline(Readable.fromWeb(response.body), outgoing);
    } catch {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.writeHead(502, { 'cache-control': 'no-store', connection: 'close' }); outgoing.end(); }
    } finally {
      if (presignTimeout) clearTimeout(presignTimeout);
      outgoing.off('close', closeIncompleteBody);
      if (outgoing.destroyed) closeIncompleteBody();
      active[pool]--;
    }
  });
  return { stopAccepting() { accepting = false; }, active: () => Object.values(active).reduce((sum, count) => sum + count, 0) };
}

export async function start(source = process.env) {
  const env = await readEnvironment(source);
  if (env.TOS_STORAGE_READ_ONLY === 'true' && env.CONTROL_OWNER !== 'blocked') throw Error('Read-only TOS requires blocked control');
  const storageOptions = {
    bucket: env.TOS_BUCKET, endpoint: env.TOS_ENDPOINT, region: env.TOS_REGION,
    accessKeyId: await readSecret(source, 'TOS_ACCESS_KEY_FILE'),
    secretAccessKey: await readSecret(source, 'TOS_SECRET_KEY_FILE'),
    spoolDirectory: env.TOS_SPOOL_DIRECTORY,
  };
  const stores = {};
  for (const [namespace, name] of Object.entries(namespaces)) {
    stores[namespace] = { secret: await readSecret(source, name), storage: createTosStorage({ ...storageOptions, namespace }) };
  }
  const runtime = await loadRuntime();
  const control = createControlServer({ runtime, env, media: stores['pikno-relay-inputs'].storage, maxConcurrent: Number(env.CONTROL_MAX_CONCURRENT || 2) });
  const gateFile = env.TOS_STORAGE_WRITE_GATE_FILE;
  const readOnly = env.TOS_STORAGE_READ_ONLY === 'true' || (gateFile ? async () => {
    try { return (await readFile(gateFile, 'utf8')).trim() !== 'open'; }
    catch { return true; }
  } : false);
  const handler = createStorageHandler({ stores, readOnly });
  const assets = await loadAssetRuntime();
  const UPLOAD_LIMITER = createUploadLimiter();
  const assetHandler = async request => {
    if (request.method === 'PUT' && (typeof readOnly === 'function' ? await readOnly() : readOnly)) {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    return assets.fetch(request, { MEDIA: stores['pikno-relay-inputs'].storage, TICKET_KEY: env.TICKET_KEY, UPLOAD_LIMITER });
  };
  const directAllMedia = env.TOS_DIRECT_MEDIA_UPLOAD === 'true';
  const presignHandler = directAllMedia || env.TOS_DIRECT_IMAGE_UPLOAD === 'true' ? createPresignRoute({
    key:env.TICKET_KEY,
    signer:createPresignedUpload(storageOptions),
    limiter:UPLOAD_LIMITER,
    includeTimed:directAllMedia,
    readOnly:async () => typeof readOnly === 'function' ? await readOnly() : readOnly,
  }) : undefined;
  const gateway = attachStorageGateway(control.server, handler, { assetHandler, presignHandler, maximum: Number(env.TOS_STORAGE_MAX_CONCURRENT || 2) });
  const host = env.CONTROL_BIND || '127.0.0.1', port = Number(env.CONTROL_PORT || 8090);
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid listen address');
  await new Promise((resolve, reject) => { control.server.once('error', reject); control.server.listen(port, host, resolve); });
  return { control, gateway };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { control, gateway } = await start();
    const stop = () => { gateway.stopAccepting(); void control.close().catch(() => { process.exitCode = 1; }); };
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
    process.stdout.write('{"event":"TOS_CONTROL_LISTENING"}\n');
  } catch {
    process.stderr.write('{"event":"TOS_CONTROL_START_REJECTED"}\n');
    process.exitCode = 1;
  }
}
