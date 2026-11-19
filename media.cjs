const path = require('node:path');

const DEFAULT_MEDIA_ENDPOINT = 'https://media.hamsterai.cc/v1/upload';
const DESKTOP_CLIENT = 'hamster-desktop-v1';
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MIME_LIMITS = new Map([
  ['image/png', 30 * 1024 * 1024],
  ['image/jpeg', 30 * 1024 * 1024],
  ['image/webp', 30 * 1024 * 1024],
  ['video/mp4', MAX_MEDIA_BYTES],
  ['video/webm', MAX_MEDIA_BYTES],
  ['video/quicktime', MAX_MEDIA_BYTES],
  ['audio/mpeg', MAX_MEDIA_BYTES],
  ['audio/wav', MAX_MEDIA_BYTES],
  ['audio/mp4', MAX_MEDIA_BYTES],
  ['audio/aac', MAX_MEDIA_BYTES],
]);

function cleanContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function safeFileName(value) {
  return path.basename(String(value || 'media')).replace(/[\r\n"]/g, '').slice(0, 160) || 'media';
}

function checkedLength(value, limit, mime) {
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 1) {
    const error = new Error('上传请求缺少有效的文件大小');
    error.statusCode = 411;
    throw error;
  }
  if (length > limit) {
    const error = new Error(mime.startsWith('image/') ? '图片最大支持30MB' : '素材最大支持50MB');
    error.statusCode = 413;
    throw error;
  }
  return length;
}

async function uploadMedia(data, { endpoint, token, contentType, contentLength, fileName, ttlSeconds, retention, fetchImpl = fetch } = {}) {
  const mime = cleanContentType(contentType);
  const limit = MIME_LIMITS.get(mime);
  if (!limit) {
    const error = new Error('不支持此素材格式');
    error.statusCode = 415;
    throw error;
  }
  const length = checkedLength(contentLength ?? data?.length, limit, mime);
  const target = String(endpoint || '').trim();
  const credential = String(token || '').trim();
  if (!target) {
    const error = new Error('Cloudflare R2 素材通道尚未配置');
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(target);
  url.searchParams.set('fileName', safeFileName(fileName));
  if (Number.isSafeInteger(ttlSeconds)) url.searchParams.set('ttl', String(ttlSeconds));
  if (retention === 'result') url.searchParams.set('retention', 'result');
  const request = {
    method: 'POST',
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      'X-Hamster-Client': DESKTOP_CLIENT,
      'Content-Type': mime,
      'Content-Length': String(length),
    },
    body: data,
    signal: AbortSignal.timeout(180000),
  };
  if (!Buffer.isBuffer(data) && typeof data?.pipe === 'function') request.duplex = 'half';
  const response = await fetchImpl(url, request);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload.error || `R2 素材上传失败（HTTP ${response.status}）`);
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw error;
  }
  const remote = payload?.file?.url || payload?.url;
  if (!/^https:\/\//i.test(remote || '')) {
    const error = new Error('R2 上传成功但未返回有效素材地址');
    error.statusCode = 502;
    throw error;
  }
  return { ...payload, file: { ...(payload.file || {}), url: remote } };
}

async function deleteMedia(objects, { endpoint, token, fetchImpl = fetch } = {}) {
  const unique = [...new Set((Array.isArray(objects) ? objects : []).filter((value) => typeof value === 'string' && value))];
  if (!unique.length) return { deleted: 0 };
  const target = String(endpoint || '').trim();
  const credential = String(token || '').trim();
  if (!target) throw new Error('Cloudflare R2 素材通道尚未配置');
  const urls = unique.filter(value => /^https:\/\//i.test(value));
  const keys = unique.filter(value => !/^https:\/\//i.test(value));
  if (keys.length && !credential) throw new Error('无权按对象键清理 R2 素材');
  const url = new URL('/v1/objects', target);
  const response = await fetchImpl(url, {
    method: 'DELETE',
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      'X-Hamster-Client': DESKTOP_CLIENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...(keys.length ? { keys } : {}), ...(urls.length ? { urls } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error || `R2 素材清理失败（HTTP ${response.status}）`);
  return payload;
}

async function checkMedia({ endpoint, fetchImpl = fetch } = {}) {
  const target = String(endpoint || DEFAULT_MEDIA_ENDPOINT).trim();
  if (!target) return { connected: false, error: 'Cloudflare R2 素材通道尚未配置' };
  try {
    const response = await fetchImpl(new URL('/v1/status', target), {
      headers: { 'X-Hamster-Client': DESKTOP_CLIENT },
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.upload !== true) {
      return { connected: false, error: payload?.error || `HTTP ${response.status}` };
    }
    return { connected: true, service: payload.service || 'hamster-ai-media' };
  } catch (error) {
    return { connected: false, error: String(error?.message || error) };
  }
}

async function handleMediaUpload(req, res, url, options) {
  try {
    const mime = cleanContentType(req.headers['content-type']);
    const limit = MIME_LIMITS.get(mime);
    if (!limit) {
      const error = new Error('不支持此素材格式');
      error.statusCode = 415;
      throw error;
    }
    const contentLength = checkedLength(req.headers['content-length'], limit, mime);
    const payload = await uploadMedia(req, {
      ...options,
      contentType: mime,
      contentLength,
      fileName: url.searchParams.get('fileName') || 'media',
      ttlSeconds: Number(url.searchParams.get('ttl')) || undefined,
      retention: url.searchParams.get('retention') || undefined,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(error.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: error.message || 'R2 素材上传失败' }));
  }
}

module.exports = {
  DEFAULT_MEDIA_ENDPOINT,
  MAX_MEDIA_BYTES,
  MIME_LIMITS,
  checkMedia,
  cleanContentType,
  deleteMedia,
  handleMediaUpload,
  uploadMedia,
};
