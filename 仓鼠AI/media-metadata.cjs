const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MIME_LIMITS, cleanContentType } = require('./media.cjs');

// Existing release-72 imageio-ffmpeg runtime; never resolve a tool from PATH.
const BINARY = 'Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';
const BINARY_SHA256 = '2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3';
const invalid = () => Object.assign(new Error('无法读取参考素材时长，请重新选择有效的视频或音频'), { statusCode: 415, code: 'media_duration_required' });
const unavailable = () => Object.assign(new Error('素材读取环境不可用，请重新启动应用后重试'), { statusCode: 503, code: 'media_metadata_unavailable' });

async function readMediaMetadata(file, { contentType, runtimeProvider, runFile = promisify(execFile) } = {}) {
  let binary;
  try {
    const root = runtimeProvider ? path.dirname((await runtimeProvider()).python) : path.join(__dirname, 'smart-video-agent', '.venv');
    binary = path.join(root, BINARY);
    if (!(await fs.promises.lstat(binary)).isFile()) throw unavailable();
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(binary)) hash.update(chunk);
    if (hash.digest('hex') !== BINARY_SHA256) throw unavailable();
  } catch { throw unavailable(); }
  try {
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    // Read machine progress from a complete local decode. Container tags are
    // untrusted text and must never be parsed as Duration/Stream log lines.
    const kind = cleanContentType(contentType).startsWith('video/') ? 'V' : 'a';
    const { stdout } = await runFile(binary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,aac', '-i', file,
      '-map', `0:${kind}:0`, '-dn', '-sn', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-',
    ], { windowsHide: true, shell: false, env, timeout: 15000, maxBuffer: 128 * 1024, encoding: 'utf8' });
    const lines = String(stdout || '').trim().split(/\r?\n/);
    if (lines.at(-1) !== 'progress=end') throw invalid();
    const duration = lines.filter(line => /^out_time_us=\d+$/.test(line)).at(-1);
    const durationSeconds = duration ? Number(duration.slice('out_time_us='.length)) / 1e6 : NaN;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) throw invalid();
    return { durationSeconds };
  } catch { throw invalid(); }
}

async function uploadWithMediaMetadata(data, metadata, upload, { runtimeProvider, readMetadata = readMediaMetadata } = {}) {
  const contentType = cleanContentType(metadata.contentType);
  const contentLength = Number(metadata.contentLength ?? data?.length);
  const limit = MIME_LIMITS.get(contentType);
  if (!limit || !/^(?:audio|video)\//.test(contentType)) throw invalid();
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw Object.assign(new Error('上传请求缺少有效的文件大小'), { statusCode: 411 });
  }
  if (contentLength > limit) throw Object.assign(new Error('素材最大支持50MB'), { statusCode: 413 });
  let directory, file, input, uploading = false;
  try {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hamster-media-'));
    file = path.join(directory, 'material');
    let received = 0;
    await pipeline(Buffer.isBuffer(data) ? Readable.from([data]) : data, new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > contentLength || received > limit ? invalid() : null, chunk);
    } }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(180000) });
    if (received !== contentLength) throw invalid();
    const details = await readMetadata(file, { contentType, runtimeProvider });
    const durationSeconds = details?.durationSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) throw invalid();
    input = fs.createReadStream(file);
    uploading = true;
    const payload = await upload(input, { ...metadata, contentType, contentLength, durationSeconds });
    return { ...payload, durationSeconds, file: { ...(payload?.file || {}), durationSeconds } };
  } catch (error) {
    if (uploading || [411, 413].includes(error?.statusCode) || ['media_duration_required', 'media_metadata_unavailable'].includes(error?.code)) throw error;
    throw invalid();
  } finally {
    if (input) {
      input.destroy();
      if (!input.closed) await new Promise(resolve => input.once('close', resolve));
    }
    if (file) await fs.promises.unlink(file).catch(() => {});
    if (directory) await fs.promises.rmdir(directory).catch(() => {});
  }
}

module.exports = { readMediaMetadata, uploadWithMediaMetadata };
