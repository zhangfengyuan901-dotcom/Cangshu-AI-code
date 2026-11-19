'use strict';
const { createHash } = require('node:crypto');
const tosOrigin = 'https://cangshu-ai-guangzhou-2026.tos-cn-guangzhou.volces.com';
const headerNames = ['Content-Length', 'Content-Type', 'If-None-Match', 'X-Tos-Content-Sha256', 'X-Tos-Meta-Expires', 'X-Tos-Meta-Uid'];
const queryNames = ['X-Tos-Algorithm', 'X-Tos-Credential', 'X-Tos-Date', 'X-Tos-Expires', 'X-Tos-Signature', 'X-Tos-SignedHeaders'];
const signedHeaders = 'content-length;content-type;host;if-none-match;x-tos-content-sha256;x-tos-meta-expires;x-tos-meta-uid';
const invalid = () => { throw Error('Invalid reference upload authorization'); };
const maximumFor = mime => /^image\/(png|jpeg|webp)$/.test(mime) ? 30 * 1024 * 1024 : /^(video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|mp4|aac))$/.test(mime) ? 50 * 1024 * 1024 : 0;

async function bufferReferenceMedia(body, length, mime, signal) {
  if (!Number.isSafeInteger(length) || length < 12 || length > maximumFor(mime)) invalid();
  signal.throwIfAborted();
  let bytes;
  if (Buffer.isBuffer(body)) {
    if (body.length !== length) invalid();
    bytes = Buffer.from(body);
  } else {
    if (!body || typeof body[Symbol.asyncIterator] !== 'function' || typeof body.destroy !== 'function') invalid();
    bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    const abort = () => body.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of body) {
        if (!Buffer.isBuffer(chunk) || offset + chunk.length > length) invalid();
        offset += chunk.copy(bytes, offset);
      }
      signal.throwIfAborted();
      if (offset !== length) invalid();
    } catch (error) { signal.throwIfAborted(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  signal.throwIfAborted();
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function tosUploadHeaders(value, headers) {
  if (typeof value !== 'string' || value.length > 8192 || !headers || typeof headers !== 'object' || Array.isArray(headers)) invalid();
  const url = new URL(value), entries = [...url.searchParams.entries()];
  if (url.origin !== tosOrigin || url.username || url.password || url.hash || !/^\/pikno-relay-inputs\/input\/[1-9]\d*\/[a-f0-9]{32}$/.test(url.pathname)) invalid();
  if (Object.keys(headers).sort().join('|') !== headerNames.join('|') || Object.values(headers).some(item => typeof item !== 'string' || /[\r\n]/.test(item))) invalid();
  if (entries.length !== queryNames.length || entries.map(([name]) => name).sort().join('|') !== queryNames.join('|')) invalid();
  const q = url.searchParams;
  if (q.get('X-Tos-Algorithm') !== 'TOS4-HMAC-SHA256' || q.get('X-Tos-SignedHeaders') !== signedHeaders || !/^[a-f0-9]{64}$/.test(q.get('X-Tos-Signature') || '') ||
      !/^\d{8}T\d{6}Z$/.test(q.get('X-Tos-Date') || '') || !/^[1-9]\d{0,2}$/.test(q.get('X-Tos-Expires') || '') || Number(q.get('X-Tos-Expires')) > 600 ||
      !new RegExp('^[A-Za-z0-9_-]{1,128}/' + q.get('X-Tos-Date').slice(0, 8) + '/cn-guangzhou/tos/request$').test(q.get('X-Tos-Credential') || '')) invalid();
  const length = Number(headers['Content-Length']);
  if (!Number.isSafeInteger(length) || length < 12 || length > maximumFor(headers['Content-Type']) || String(length) !== headers['Content-Length'] ||
      headers['If-None-Match'] !== '*' || !/^[a-f0-9]{64}$/.test(headers['X-Tos-Content-Sha256']) ||
      !/^[1-9]\d{0,15}$/.test(headers['X-Tos-Meta-Expires']) || headers['X-Tos-Meta-Uid'] !== url.pathname.split('/')[3]) invalid();
  return { ...headers };
}

function validateTosTicket(ticket, { uid, mime, length, sha256, ticketExpires, now }) {
  const headers = tosUploadHeaders(ticket.upload_url, ticket.headers), url = new URL(ticket.upload_url);
  let claims;
  if (typeof ticket.upload_ticket !== 'string' || ticket.upload_ticket.length > 8192) invalid();
  try { claims = JSON.parse(Buffer.from(ticket.upload_ticket.split('.')[0], 'base64url').toString('utf8')); } catch { invalid(); }
  if (ticket.transport !== 'tos-v1' || ticket.method !== 'PUT' || !Number.isSafeInteger(uid) || uid < 1 ||
      !claims || claims.v !== 1 || claims.aud !== 'pikno-relay-media' || claims.op !== 'upload' || claims.uid !== uid || claims.id !== ticket.id || claims.mime !== mime || claims.size !== length ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp !== ticketExpires || claims.exp <= now / 1000 || claims.iat > now / 1000 + 60 || claims.exp - claims.iat > 600 || claims.exp <= claims.iat ||
      !Number.isSafeInteger(ticket.expires_at) || ticket.expires_at > claims.exp || ticket.expires_at <= now / 1000 ||
      url.pathname !== '/pikno-relay-inputs/input/' + uid + '/' + ticket.id || headers['Content-Length'] !== String(length) || headers['Content-Type'] !== mime ||
      headers['X-Tos-Content-Sha256'] !== sha256 || headers['X-Tos-Meta-Expires'] !== String(claims.iat + 86400)) invalid();
  const date = url.searchParams.get('X-Tos-Date');
  const issued = Date.parse(date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) + 'T' + date.slice(9, 11) + ':' + date.slice(11, 13) + ':' + date.slice(13, 15) + 'Z');
  if (!Number.isFinite(issued) || new Date(issued).toISOString().replace(/[-:]/g, '').replace('.000', '') !== date || issued > now + 60000 || issued < claims.iat * 1000 - 60000 ||
      issued + Number(url.searchParams.get('X-Tos-Expires')) * 1000 !== ticket.expires_at * 1000) invalid();
  return { target: url, headers };
}

async function readPresignJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) invalid();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); invalid(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { reader.releaseLock(); }
}

module.exports = { bufferReferenceMedia, tosUploadHeaders, validateTosTicket, readPresignJSON };
