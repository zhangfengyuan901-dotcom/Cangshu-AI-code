import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [previousArg, currentArg, evidenceArg] = process.argv.slice(2)
assert.ok(previousArg && currentArg && evidenceArg)
const previous = path.resolve(previousArg)
const current = path.resolve(currentArg)
assert.notEqual(previous, current)

async function files(root, prefix = '') {
  assert.equal((await lstat(path.join(root, prefix))).isDirectory(), true)
  const result = []
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, item.name)
    const resolved = path.resolve(root, relative)
    assert.ok(resolved.startsWith(root + path.sep))
    assert.equal(item.isSymbolicLink(), false, relative)
    if (item.isDirectory()) result.push(...await files(root, relative))
    else {
      assert.equal(item.isFile(), true, relative)
      result.push(relative)
    }
  }
  return result.sort()
}

async function identity(root, relative) {
  const bytes = await readFile(path.join(root, relative))
  return { path: relative.split(path.sep).join('/'), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
}

const nativePaths = await files(current)
const nativeFiles = await Promise.all(nativePaths.map(relative => identity(current, relative)))
const nativeByPath = new Map(nativeFiles.map(file => [file.path, file]))
const previousPaths = await files(previous)
const retainedFiles = []
let sharedFiles = 0
for (const relative of previousPaths) {
  const old = await identity(previous, relative)
  const present = nativeByPath.get(old.path)
  if (present) {
    assert.equal(present.sha256, old.sha256, `Static path content conflict: ${old.path}`)
    sharedFiles++
  } else {
    const target = path.join(current, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(previous, relative), target)
    assert.deepEqual(await identity(current, relative), old)
    retainedFiles.push(old)
  }
}
const evidence = { success: true, previousVersion: 'v1.0.0-rc.41-pikno.42',
  currentVersion: 'v1.0.0-rc.41-hamster.44', staticOnly: true,
  nativeFiles, retainedFiles, sharedFiles,
  retainedBytes: retainedFiles.reduce((sum, item) => sum + item.bytes, 0) }
await writeFile(evidenceArg, JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ success: true, nativeFiles: nativeFiles.length,
  retainedFiles: retainedFiles.length, sharedFiles, retainedBytes: evidence.retainedBytes }))
