// Phase two layers on the frozen client10 overlay; no private files are copied.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const base = dirname(fileURLToPath(import.meta.url))
const files = [
  'src/features/pricing/index.tsx',
  'src/features/pricing/components/model-card-grid.tsx',
  'src/features/pricing/components/model-card.tsx',
  'src/features/pricing/components/pricing-toolbar.tsx',
  'src/features/pricing/components/model-details.tsx',
  'src/features/pricing/components/customer-model-access.tsx',
  'src/features/pricing/__tests__/customer-models.test.tsx',
  'src/features/usage-logs/components/usage-logs-table.tsx',
  'src/features/usage-logs/index.tsx',
  'src/features/usage-logs/components/common-logs-stats.tsx',
  'src/features/usage-logs/components/__tests__/customer-list.test.tsx',
  'src/i18n/locales/zh.json',
  'src/i18n/locales/zh-TW.json',
]
const manifest = {}
for (const file of files) {
  const output = resolve(base, 'client11', file)
  await mkdir(dirname(output), { recursive: true })
  await copyFile(resolve(base, '../../build/brand10-client', file), output)
  manifest[file] = createHash('sha256').update(await readFile(output)).digest('hex')
}
await writeFile(resolve(base, 'client11-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Packaged ${files.length} phase-two files`)
