// Reproducible frontend overlay; copies only reviewed source and public API docs.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const base = dirname(fileURLToPath(import.meta.url))
const web = resolve(base, '../../build/brand10-client')
const files = [
  'src/hooks/use-sidebar-data.ts',
  'src/hooks/use-top-nav-links.ts',
  'src/hooks/__tests__/customer-navigation.test.tsx',
  'src/features/dashboard/index.tsx',
  'src/features/dashboard/components/overview/customer-overview.tsx',
  'src/features/dashboard/components/overview/__tests__/customer-overview.test.tsx',
  'src/features/wallet/index.tsx',
  'src/features/wallet/hooks/use-affiliate.ts',
  'src/features/wallet/components/recharge-form-card.tsx',
  'src/features/wallet/__tests__/customer-wallet.test.tsx',
  'src/i18n/locales/zh.json',
  'src/i18n/locales/zh-TW.json',
  'src/routes/_authenticated/developer.tsx',
]
const manifest = {}
for (const file of files) {
  const output = resolve(base, 'client10', file)
  await mkdir(dirname(output), { recursive: true })
  await copyFile(resolve(web, file), output)
  manifest[file] = createHash('sha256').update(await readFile(output)).digest('hex')
}
// The public guide contains no credentials; do not package private test/deploy files.
const guide = await readFile(resolve(base, 'CUSTOMER-API.md'), 'utf8')
for (const target of [resolve(web, 'public'), resolve(base, 'client10/public')]) {
  await mkdir(target, { recursive: true })
  await writeFile(resolve(target, 'developer-guide.md'), guide)
  await mkdir(resolve(target, 'examples'), { recursive: true })
  await copyFile(resolve(base, 'examples/media-edit.mjs'), resolve(target, 'examples/media-edit.mjs'))
}
manifest['public/developer-guide.md'] = createHash('sha256').update(guide).digest('hex')
await writeFile(resolve(base, 'client10-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Packaged ${files.length} frontend files and public API guide/examples`)
