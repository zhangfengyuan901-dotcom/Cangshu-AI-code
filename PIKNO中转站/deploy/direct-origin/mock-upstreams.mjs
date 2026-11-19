import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// QA-only. Run in the isolated network created by test-ingress.mjs.
if (process.env.HAMSTER_INGRESS_QA !== 'synthetic-only') throw Error('QA marker required');
const tlsDir = process.env.QA_TLS_DIR || '/qa/tls';
const validTLS = { key: fs.readFileSync(tlsDir + '/media.key'), cert: fs.readFileSync(tlsDir + '/media.pem') };
const invalidTLS = { key: fs.readFileSync(tlsDir + '/untrusted.key'), cert: fs.readFileSync(tlsDir + '/untrusted.pem') };
const observations = [], objects = new Map(), mediaSockets = new Set();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
async function bodyOf(req) {
  const parts = []; let size = 0;
  const limit = req.url === '/v1/images/edits' ? 131 * 1024 * 1024 : req.url === '/assistant/v2/files' ? 56 * 1024 * 1024 : 2 * 1024 * 1024;
  for await (const part of req) { size += part.length; if (size > limit) throw Error('QA body too large'); parts.push(part); }
  return Buffer.concat(parts);
}
function handler(backend) {
  return async (req, res) => {
    try {
      const bytes = await bodyOf(req), pathname = new URL(req.url, 'http://qa.invalid').pathname;
      const directAsset = backend === 'control' && pathname.startsWith('/media/v1/assets/');
      const entry = { backend: directAsset ? 'media-direct' : backend, method: req.method, uri: req.url, headers: req.headers, bytes: bytes.length, sha256: sha(bytes), sni: req.socket.servername || null, peer: req.socket.remoteAddress };
      observations.push(entry);
      if (req.headers['x-qa-mode'] === 'reset-after-body') { req.socket.destroy(); return; }
      if (req.headers['x-qa-mode'] === 'uncertain-503') { json(res, 503, { backend, uncertain: true }); return; }
      if (backend === 'new-api') {
        if (pathname === '/api/user/auth/refresh') {
          if (req.headers.origin !== 'https://www.piknoai.com') return json(res, 403, { code: 'AUTH_ORIGIN_FORBIDDEN' });
          return json(res, 200, { backend, authenticated: false, synthetic: true }, { 'set-cookie': 'new_api_refresh=qa-only; Path=/api/user/auth; HttpOnly; Secure; SameSite=Strict' });
        }
        if (pathname === '/api/pikno/catalog/events' || pathname === '/v1/responses' && req.headers['x-qa-mode'] === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          res.flushHeaders(); res.write('event: first\ndata: {"synthetic":true}\n\n');
          const timer = setTimeout(() => res.end('event: last\ndata: {}\n\n'), 1800);
          res.on('close', () => clearTimeout(timer)); return;
        }
        return json(res, 200, { backend, synthetic: true, request: entry });
      }
      if (backend === 'media' || directAsset) {
        if (directAsset ? req.headers.host !== 'www.piknoai.com' : req.headers.host !== 'media.piknoai.com' || req.socket.servername !== 'media.piknoai.com') return json(res, 421, { code: 'HOST_OR_SNI_MISMATCH' });
        if (req.headers.origin && req.headers.origin !== 'https://www.piknoai.com') return json(res, 403, { code: 'ORIGIN_REJECTED' });
        if (!/^\/media\/v1\/assets\/[a-f0-9]{32}(?:\/inspect)?$/.test(pathname)) return json(res, 404, { code: 'NOT_FOUND' });
        if (req.method === 'PUT') {
          if (req.headers.authorization !== 'Bearer synthetic-upload-ticket' || Number(req.headers['content-length']) !== bytes.length || req.headers['content-type'] !== 'image/png' || req.headers['content-encoding']) return json(res, 400, { code: 'UPLOAD_HEADERS_MISMATCH' });
          objects.set(pathname, bytes);
          return json(res, 201, { backend, size: bytes.length, sha256: sha(bytes) }, { 'set-cookie': 'media_should_not_escape=synthetic; Secure; Path=/' });
        }
        if (req.method === 'POST' && pathname.endsWith('/inspect')) {
          if (req.headers.authorization !== 'Bearer synthetic-inspect-ticket') return json(res, 401, { code: 'TICKET_REQUIRED' });
          return json(res, objects.has(pathname.slice(0, -8)) ? 200 : 404, { backend, ready: objects.has(pathname.slice(0, -8)) });
        }
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { code: 'METHOD_NOT_ALLOWED' });
        const url = new URL(req.url, 'https://media.piknoai.com');
        if (url.searchParams.get('ticket') !== 'synthetic-read-ticket') return json(res, 401, { code: 'TICKET_REQUIRED' });
        const data = objects.get(pathname); if (!data) return json(res, 404, { code: 'NOT_FOUND' });
        const headers = { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'private, no-store', 'accept-ranges': 'bytes', 'set-cookie': 'media_should_not_escape=synthetic; Secure; Path=/' };
        let selected = data, status = 200;
        if (req.method === 'GET' && req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range), start = Number(match?.[1]), end = match?.[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
          if (!match || start >= data.length || end < start) { res.writeHead(416, { ...headers, 'content-range': `bytes */${data.length}`, 'content-length': 0 }); res.end(); return; }
          selected = data.subarray(start, end + 1); status = 206; headers['content-range'] = `bytes ${start}-${end}/${data.length}`; headers['content-length'] = selected.length;
        }
        res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : selected); return;
      }
      return json(res, 200, { backend, synthetic: true, request: entry });
    } catch { if (!res.headersSent) json(res, 500, { code: 'QA_UPSTREAM_FAILED' }); else res.destroy(); }
  };
}
const servers = [http.createServer(handler('new-api')).listen(3000, '0.0.0.0'), http.createServer(handler('payment')).listen(8080, '0.0.0.0'), http.createServer(handler('control')).listen(8090, '0.0.0.0')];
const media = https.createServer(validTLS, handler('media')).listen(443, '0.0.0.0'); servers.push(media);
media.on('secureConnection', socket => { mediaSockets.add(socket); socket.on('close', () => mediaSockets.delete(socket)); });
media.on('tlsClientError', () => {});
servers.push(http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ready: servers.every(server => server.listening) });
  if (req.method === 'GET' && req.url === '/observations') return json(res, 200, { observations });
  if (req.method === 'POST' && ['/tls/trusted', '/tls/untrusted'].includes(req.url)) {
    media.setSecureContext(req.url.endsWith('/untrusted') ? invalidTLS : validTLS);
    for (const socket of mediaSockets) socket.destroy();
    return json(res, 200, { changed: true });
  }
  json(res, 404, { code: 'NOT_FOUND' });
}).listen(18080, '0.0.0.0'));
process.on('SIGTERM', () => { for (const server of servers) server.close(); setTimeout(() => process.exit(0), 300).unref(); });
console.log(JSON.stringify({ event: 'synthetic-upstreams-starting', ports: [3000, 8080, 8090, 443, 18080] }));
