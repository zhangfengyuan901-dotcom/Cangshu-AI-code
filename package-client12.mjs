// Layer phase three on the frozen client10 and client11 overlays.
import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const base = dirname(fileURLToPath(import.meta.url))
const files = [
  'src/features/pricing/index.tsx',
  'src/hooks/use-sidebar-data.ts',
  'src/routes/_authenticated/catalog-admin.tsx',
  'src/i18n/locales/zh.json',
  'src/i18n/locales/zh-TW.json',
]
for (const entry of await readdir(resolve(base, '../../build/brand10-client/src/features/catalog'), { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) {
    const parent = entry.parentPath.replaceAll('\\', '/')
    files.push('src/features/catalog/' + parent.split('/src/features/catalog')[1].replace(/^\//, '') + (parent.endsWith('/catalog') ? '' : '/') + entry.name)
  }
}
const manifest = {}
for (const file of files) {
  const output = resolve(base, 'client12', file)
  await mkdir(dirname(output), { recursive: true })
  await copyFile(resolve(base, '../../build/brand10-client', file), output)
  manifest[file] = createHash('sha256').update(await readFile(output)).digest('hex')
}
await writeFile(resolve(base, 'client12-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Packaged ${files.length} phase-three files`)
