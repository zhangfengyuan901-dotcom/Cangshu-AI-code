import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)]); }
const sourceFiles = files(path.join(root, 'src'));
for (const file of sourceFiles.filter(file => file.endsWith('section-nav.ts'))) {
  const source = await readFile(file, 'utf8');
  if (/from\s+['"](?!i18next)/.test(source) || /import\s*\(/.test(source)) throw new Error('Navigation metadata imports runtime components: ' + path.basename(path.dirname(file)));
}
const source = await readFile(path.join(root, 'src/main.tsx'), 'utf8');
if (!source.includes("import('./app')") || /from ['"]react/.test(source)) throw new Error('Customer boot imports admin runtime');
const app = await readFile(path.join(root, 'src/app.tsx'), 'utf8');
if (app.includes('initializeFrontendCache')) throw new Error('Administration must not clear pending account operation metadata');
for (const section of ['auth', 'billing', 'content', 'models', 'operations', 'request-policies', 'security', 'site']) {
  const registry = await readFile(path.join(root, 'src/features/system-settings', section, 'section-registry.tsx'), 'utf8');
  if (!registry.includes('lazy(() => import(')) throw new Error('Setting forms are not deferred: ' + section);
}
for (const retired of ['chat', 'playground', 'rankings', 'redemption-codes']) if (fs.existsSync(path.join(root, 'src/features', retired)) && files(path.join(root, 'src/features', retired)).some(file => /\.[jt]sx?$/.test(file))) throw new Error('Retired implementation remains: ' + retired);
console.log(JSON.stringify({ ok: true, navigationFormsIsolated: true, administrationDynamic: true, retiredSourceAbsent: true }));
