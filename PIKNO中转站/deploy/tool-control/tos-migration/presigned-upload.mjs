import { createHash, createHmac } from 'node:crypto';

const algorithm = 'TOS4-HMAC-SHA256';
const maximumTicketLifetime = 600;
const objectLifetime = 86400;
const contentLimits = {
  'image/png': 30 << 20,
  'image/jpeg': 30 << 20,
  'image/webp': 30 << 20,
  'video/mp4': 50 << 20,
  'video/webm': 50 << 20,
  'video/quicktime': 50 << 20,
  'audio/mpeg': 50 << 20,
  'audio/wav': 50 << 20,
  'audio/mp4': 50 << 20,
  'audio/aac': 50 << 20,
};
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

export function createPresignedUpload({ bucket, region, endpoint, accessKeyId, secretAccessKey, now = Date.now }) {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region) ||
      typeof accessKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accessKeyId) ||
      typeof secretAccessKey !== 'string' || !secretAccessKey || typeof now !== 'function') {
    throw Error('Invalid TOS presigned upload configuration');
  }
  const endpointHost = `tos-${region}.volces.com`;
  if (endpoint !== `https://${endpointHost}` && endpoint !== `https://${endpointHost}/`) {
    throw Error('Invalid TOS presigned upload endpoint');
  }
  const host = `${bucket}.${endpointHost}`;

  return ({ uid, id, mime, size, iat, exp, sha256 }) => {
    const currentTime = new Date(now());
    const current = Math.floor(currentTime.getTime() / 1000);
    if (!Number.isSafeInteger(uid) || uid < 1 || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) ||
        typeof mime !== 'string' || !Object.hasOwn(contentLimits, mime) ||
        !Number.isSafeInteger(size) || size < 12 || size > contentLimits[mime] ||
        !Number.isSafeInteger(current) || current < 1 || currentTime.getUTCFullYear() > 9999 ||
        !Number.isSafeInteger(iat) || iat < 1 || iat > current + 30 ||
        !Number.isSafeInteger(exp) || exp <= iat || exp - iat > maximumTicketLifetime ||
        exp <= current || exp - current > maximumTicketLifetime ||
        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw Error('Invalid TOS presigned upload claims');
    }

    const path = `/pikno-relay-inputs/input/${uid}/${id}`;
    const headers = {
      'Content-Length': String(size),
      'Content-Type': mime,
      'If-None-Match': '*',
      'X-Tos-Content-Sha256': sha256,
      'X-Tos-Meta-Expires': String(iat + objectLifetime),
      'X-Tos-Meta-Uid': String(uid),
    };
    const entries = Object.entries({ ...headers, Host: host })
      .map(([name, value]) => [name.toLowerCase(), value])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const signedHeaders = entries.map(([name]) => name).join(';');
    const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
    const date = currentTime.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = date.slice(0, 8);
    const scope = `${shortDate}/${region}/tos/request`;
    const query = [
      ['X-Tos-Algorithm', algorithm],
      ['X-Tos-Credential', `${accessKeyId}/${scope}`],
      ['X-Tos-Date', date],
      ['X-Tos-Expires', String(exp - current)],
      ['X-Tos-SignedHeaders', signedHeaders],
    ].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
    // The TOS SDK uses the SHA-256 header value as the canonical payload when present.
    const canonical = `PUT\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${sha256}`;
    const digest = createHash('sha256').update(canonical).digest('hex');
    const key = hmac(hmac(hmac(hmac(secretAccessKey, shortDate), region), 'tos'), 'request');
    const signature = hmac(key, `${algorithm}\n${date}\n${scope}\n${digest}`).toString('hex');
    return { url: `https://${host}${path}?${query}&X-Tos-Signature=${signature}`, headers };
  };
}
