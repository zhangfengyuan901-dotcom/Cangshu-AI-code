import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(process.env.MEASURE_ROOT || '/build/web/dist');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const item = url => {
  const buffer = fs.readFileSync(path.join(root, url));
  return { file: url, bytes: buffer.length, gzipBytes: zlib.gzipSync(buffer, { level: 9 }).length, brotliBytes: zlib.brotliCompressSync(buffer).length };
};
const total = files => Object.fromEntries(['bytes', 'gzipBytes', 'brotliBytes'].map(key => [key, files.reduce((sum, file) => sum + file[key], 0)]));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const initial = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => item(match[1]));
const account = ['account.mjs', 'client.mjs'].map(name => item('/account-lite/' + name));
const authentication = fs.existsSync(path.join(root, 'auth-lite/auth.mjs')) ? ['auth.mjs', 'client.mjs'].map(name => item('/auth-lite/' + name)) : [];
const scripts = walk(root).filter(file => /\.(?:js|mjs)$/.test(file)).map(file => ({ file: path.relative(root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size }));
console.log(JSON.stringify({ scope: 'local-build-uncompressed-and-compression-estimates-not-live-speed', entry: { files: initial, total: total(initial) }, account: { files: account, total: total(account) }, authentication: { files: authentication, total: total(authentication) }, scripts: { count: scripts.length, bytes: scripts.reduce((sum, file) => sum + file.bytes, 0) } }, null, 2));
