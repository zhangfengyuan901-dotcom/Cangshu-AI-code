import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { rspack } from '@rsbuild/core';
import { transform } from 'lightningcss';

// Public H5 files have a separate syntax pass; the admin entry does not compile them.
export async function buildLite(root, dist) {
  const files = ['account-lite/account.mjs', 'account-lite/client.mjs', 'account-lite/compat.mjs', 'account-lite/checkout-qr.mjs', 'auth-lite/auth.mjs', 'auth-lite/client.mjs'];
  const compiler = rspack({
    mode: 'production', context: root,
    target: ['web', 'es2020'],
    entry: Object.fromEntries(files.map((file) => [file, { import: path.join(root, 'public', file), library: { type: 'module' } }])),
    output: { path: dist, filename: '[name]', module: true, chunkFormat: 'module', environment: { arrowFunction: true, const: true, destructuring: true, optionalChaining: false } },
    experiments: { outputModule: true },
    // Keep the public entry modules separate and preserve their stable URLs.
    externalsType: 'module',
    externals: [({ request }, callback) => /^\.{1,2}\/.*\.mjs$/.test(request || '') ? callback(null, request) : callback()],
    module: { rules: [{ test: /\.mjs$/, type: 'javascript/esm', use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'ecmascript' } }, env: { targets: { chrome: '87', edge: '88', firefox: '78', safari: '14', ios: '14' } } } } }] },
    optimization: { splitChunks: false, runtimeChunk: false },
    devtool: false, performance: { hints: false },
  });
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  } finally { await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve())); }
  // Native bridge and CSP depend on fixed entry names. Do not rename the HTML.
  for (const file of files) {
    const code = await readFile(path.join(dist, file), 'utf8');
    if (!code || /sourceMappingURL=data:/.test(code)) throw new Error(`Invalid H5 output: ${file}`);
  }
  for (const file of ['account-lite/account.css', 'auth-lite/auth.css']) {
    const result = transform({ filename: file, code: await readFile(path.join(root, 'public', file)), minify: true,
      targets: { chrome: 87 << 16, firefox: 78 << 16, safari: 14 << 16, ios_saf: 14 << 16 },
    });
    await writeFile(path.join(dist, file), result.code);
  }
  // Keep this build marker machine-readable; it contains no account state.
  await writeFile(path.join(dist, 'lite-build.json'), JSON.stringify({ format: 1, syntaxTargets: { chrome: 87, edge: 88, firefox: 78, safari: 14, ios: 14 }, files }) + '\n');
}
