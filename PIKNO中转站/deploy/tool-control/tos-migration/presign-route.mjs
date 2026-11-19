import { createHmac, timingSafeEqual } from 'node:crypto';

const imageMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
const timedMime = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac']);
const assetId = /^\/media\/v1\/assets\/([a-f0-9]{32})\/presign$/;
const base64url = /^[A-Za-z0-9_-]+$/;
const digest = /^[a-f0-9]{64}$/;

export const isPresignPath = pathname => assetId.test(pathname);

function verifiedTicket(value, id, key, now) {
  if (!value?.startsWith('Bearer ') || value.length > 2048) return null;
  const parts = value.slice(7).split('.');
  if (parts.length !== 2 || parts.some(part => !base64url.test(part))) return null;
  const mac = createHmac('sha256', key).update(parts[0]).digest();
  const signature = Buffer.from(parts[1], 'base64url');
  if (signature.length !== mac.length || !timingSafeEqual(mac, signature)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (p.v !== 1 || p.aud !== 'pikno-relay-media' || p.op !== 'upload' || p.id !== id ||
        !Number.isSafeInteger(p.uid) || p.uid < 1 || (!imageMime.has(p.mime) && !timedMime.has(p.mime)) ||
        !Number.isSafeInteger(p.size) || p.size < 12 || p.size > (imageMime.has(p.mime) ? 30 : 50) * 1024 * 1024 ||
        !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.iat > now + 30 ||
        p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 600) return null;
    return p;
  } catch { return null; }
}

export function createPresignRoute({ key, signer, limiter, readOnly, includeTimed = false, now = Date.now }) {
  const reply = (status, body = null) => new Response(body && JSON.stringify(body), {
    status, headers: { 'cache-control':'no-store', ...(body ? { 'content-type':'application/json' } : {}) },
  });

  return async request => {
    const { pathname, search, origin } = new URL(request.url);
    const id = assetId.exec(pathname)?.[1];
    if (!id || search) return reply(404);
    if (request.method !== 'POST') return reply(405);
    if (request.headers.has('origin') && request.headers.get('origin') !== origin) return reply(403);
    const clock = Math.floor(now() / 1000);
    const claims = verifiedTicket(request.headers.get('authorization'), id, key, clock);
    if (!claims) return reply(403);
    if (timedMime.has(claims.mime) && !includeTimed) return reply(404);
    const length = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 1 || length > 128 ||
        request.headers.get('content-type') !== 'application/json' || request.headers.has('content-encoding')) return reply(400);
    let body;
    try { body = await request.json(); } catch { return reply(400); }
    if (!body || Object.keys(body).length !== 1 || typeof body.sha256 !== 'string' || !digest.test(body.sha256)) return reply(400);
    if (await readOnly()) return reply(503);
    if (!(await limiter.limit({ key:String(claims.uid) })).success) return reply(429);
    try {
      const expires_at = Math.min(claims.exp, clock + 240);
      const { url, headers } = signer({ ...claims, exp:expires_at, sha256:body.sha256 });
      return reply(201, { id, transport:'tos-v1', method:'PUT', upload_url:url, headers, expires_at });
    } catch { return reply(503); }
  };
}
