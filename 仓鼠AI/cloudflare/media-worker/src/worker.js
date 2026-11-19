const TYPES = new Map([
  ['image/png', { extension: 'png', max: 30 * 1024 * 1024, ttl: 3600 }],
  ['image/jpeg', { extension: 'jpg', max: 30 * 1024 * 1024, ttl: 3600 }],
  ['image/webp', { extension: 'webp', max: 30 * 1024 * 1024, ttl: 3600 }],
  ['video/mp4', { extension: 'mp4', max: 50 * 1024 * 1024, ttl: 7200 }],
  ['video/webm', { extension: 'webm', max: 50 * 1024 * 1024, ttl: 7200 }],
  ['video/quicktime', { extension: 'mov', max: 50 * 1024 * 1024, ttl: 7200 }],
  ['audio/mpeg', { extension: 'mp3', max: 50 * 1024 * 1024, ttl: 7200 }],
  ['audio/wav', { extension: 'wav', max: 50 * 1024 * 1024, ttl: 7200 }],
  ['audio/mp4', { extension: 'm4a', max: 50 * 1024 * 1024, ttl: 7200 }],
  ['audio/aac', { extension: 'aac', max: 50 * 1024 * 1024, ttl: 7200 }],
]);

const DAY_SECONDS = 86400;
const CLIENT_HEADER = 'hamster-desktop-v1';
const encoder = new TextEncoder();

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

async function authorized(request, env) {
  const value = request.headers.get('authorization') || '';
  if (!env.UPLOAD_TOKEN) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(value)),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.UPLOAD_TOKEN}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function desktopClient(request) {
  return request.headers.get('x-hamster-client') === CLIENT_HEADER;
}

async function withinUploadLimit(request, env) {
  if (!env.UPLOAD_RATE_LIMITER) return true;
  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const result = await env.UPLOAD_RATE_LIMITER.limit({ key: address });
  return result.success;
}

function objectKey(pathname) {
  const key = pathname.slice(1);
  return /^(?:tmp|result|media)\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.(?:png|jpg|webp|mp4|webm|mov|mp3|wav|m4a|aac)$/.test(key)
    ? key
    : '';
}

function base64url(bytes) {
  let value = '';
  for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function signingKey(env, usages) {
  if (!env.URL_SIGNING_KEY) throw new Error('URL signing key is not configured');
  return crypto.subtle.importKey(
    'raw', encoder.encode(env.URL_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, usages,
  );
}

async function signedUrl(env, url, key, ttl) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const path = `/${key}`;
  const mac = await crypto.subtle.sign('HMAC', await signingKey(env, ['sign']), encoder.encode(`${path}\n${expires}`));
  const output = new URL(path, url.origin);
  output.searchParams.set('exp', String(expires));
  output.searchParams.set('sig', base64url(mac));
  return { url: output.href, expires };
}

async function validSignature(value, env, requireFresh = true) {
  const url = value instanceof URL ? value : new URL(value.url || value);
  const expires = Number(url.searchParams.get('exp'));
  const signature = url.searchParams.get('sig') || '';
  if (!objectKey(url.pathname) || !Number.isSafeInteger(expires)
      || (requireFresh && expires < Math.floor(Date.now() / 1000))
      || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const received = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
  return crypto.subtle.verify(
    'HMAC', await signingKey(env, ['verify']), received,
    encoder.encode(`${url.pathname}\n${expires}`),
  );
}

function objectHeaders(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, no-store, max-age=0');
  headers.set('access-control-allow-origin', '*');
  headers.set('cross-origin-resource-policy', 'cross-origin');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

async function upload(request, env, url) {
  const privileged = await authorized(request, env);
  if (!privileged && !desktopClient(request)) return json({ error: 'Unauthorized client' }, 401);
  if (!privileged && !(await withinUploadLimit(request, env))) return json({ error: 'Upload rate limit exceeded' }, 429);
  const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
  const type = TYPES.get(contentType);
  if (!type) return json({ error: 'Unsupported media type' }, 415);
  const contentLength = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) return json({ error: 'Content-Length is required' }, 411);
  if (contentLength > type.max) return json({ error: 'File is too large' }, 413);
  const requestedTtl = url.searchParams.has('ttl') ? Number(url.searchParams.get('ttl')) : Number.NaN;
  const retention = url.searchParams.get('retention') === 'result' ? 'result' : 'tmp';
  const maximumTtl = retention === 'result' ? DAY_SECONDS : type.ttl;
  const ttl = Number.isSafeInteger(requestedTtl) ? Math.max(60, Math.min(maximumTtl, requestedTtl)) : maximumTtl;
  const now = new Date();
  const day = now.toISOString().slice(0, 10).replaceAll('-', '/');
  const key = `${retention}/${day}/${crypto.randomUUID()}.${type.extension}`;
  const expiresAt = new Date(now.getTime() + DAY_SECONDS * 1000).toISOString();
  const object = await env.MEDIA.put(key, request.body, {
    httpMetadata: { contentType, contentDisposition: 'inline', cacheControl: 'private, no-store, max-age=0' },
    customMetadata: { expiresAt, retention },
  });
  if (!object) return json({ error: 'Upload failed' }, 500);
  const access = await signedUrl(env, url, key, ttl);
  return json({
    file: { url: access.url, key, size: object.size, contentType },
    accessExpiresAt: new Date(access.expires * 1000).toISOString(),
    expiresAt,
  }, 201);
}

async function remove(request, env) {
  const privileged = await authorized(request, env);
  if (!privileged && !desktopClient(request)) return json({ error: 'Unauthorized client' }, 401);
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  let keys = [];
  if (privileged) {
    keys.push(...(Array.isArray(payload?.keys) ? payload.keys : [])
      .filter(key => typeof key === 'string' && objectKey(`/${key}`) === key));
  }
  const urls = [...new Set(Array.isArray(payload?.urls) ? payload.urls : [])].slice(0, 1000);
  for (const value of urls) {
    let signed;
    try { signed = new URL(value); }
    catch { return json({ error: 'Invalid signed object URL' }, 403); }
    if (signed.origin !== new URL(request.url).origin || !(await validSignature(signed, env, false))) {
      return json({ error: 'Invalid signed object URL' }, 403);
    }
    keys.push(objectKey(signed.pathname));
  }
  keys = [...new Set(keys)].slice(0, 1000);
  if (!keys.length) return json({ deleted: 0 });
  await env.MEDIA.delete(keys);
  return json({ deleted: keys.length });
}

async function serve(request, env, key) {
  // Existing media/* links remain compatible only while the new one-day lifecycle removes them.
  if (!key.startsWith('media/') && !(await validSignature(request, env))) {
    return new Response('Expired or invalid URL', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const range = request.headers.has('range') ? request.headers : undefined;
  const object = request.method === 'HEAD'
    ? await env.MEDIA.head(key)
    : await env.MEDIA.get(key, { onlyIf: request.headers, ...(range ? { range } : {}) });
  if (!object) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = objectHeaders(object);
  if (request.method === 'HEAD') {
    headers.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers });
  }
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  const ranged = range && object.range && 'offset' in object.range;
  if (ranged) {
    const end = object.range.offset + object.range.length - 1;
    headers.set('content-range', `bytes ${object.range.offset}-${end}/${object.size}`);
    headers.set('content-length', String(object.range.length));
  } else headers.set('content-length', String(object.size));
  return new Response(object.body, { status: ranged ? 206 : 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'hamster-ai-media' });
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      if (!desktopClient(request)) return json({ ok: false, error: 'Unauthorized client' }, 401);
      return json({ ok: true, upload: true, service: 'hamster-ai-media' });
    }
    if (request.method === 'POST' && url.pathname === '/v1/upload') return upload(request, env, url);
    if (request.method === 'DELETE' && url.pathname === '/v1/objects') return remove(request, env);
    const key = objectKey(url.pathname);
    if (key && (request.method === 'GET' || request.method === 'HEAD')) return serve(request, env, key);
    return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
};
