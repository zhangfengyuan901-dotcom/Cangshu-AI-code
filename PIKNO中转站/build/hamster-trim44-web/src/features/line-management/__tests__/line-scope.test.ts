import { expect, it } from 'vitest'

import { filterLineScope, isArchivedLine, lineScopeCounts } from '../line-scope'
import type { LineRecord } from '../types'

function record(id: string, published: boolean | null, reason = ''): LineRecord {
  const config = { name: `Name ${id}`, enabled: published ?? false }
  return {
    public_model: id,
    published: published == null ? null : config,
    draft: published == null ? config : null,
    sync: { paused: reason !== '', pause_reason: reason },
  } as LineRecord
}

it('archives closed upstream drafts and publications plus manually closed publications', () => {
  for (const reason of ['disabled', 'missing', 'stale']) {
    expect(isArchivedLine(record('old', true, reason))).toBe(true)
    expect(isArchivedLine(record('new', null, reason))).toBe(true)
  }
  expect(isArchivedLine(record('manual-close', false))).toBe(true)
  expect(isArchivedLine(record('open', true))).toBe(false)
})

it('keeps unpublished and published billing or adapter faults available for management', () => {
  for (const reason of ['adapter_invalid', 'billing_unknown', 'schema_changed']) {
    expect(isArchivedLine(record('draft', null, reason))).toBe(false)
    expect(isArchivedLine(record('published', true, reason))).toBe(false)
  }
  const pending = record('not-paused', true, 'missing')
  if (pending.sync) pending.sync.paused = false
  expect(isArchivedLine(pending)).toBe(false)
})

it('filters by scope and search while counts describe all stored configurations', () => {
  const lines = [record('OPEN', true), record('draft', null), record('closed', false), record('gone', true, 'missing')]
  expect(lineScopeCounts(lines)).toEqual({ manageable: 2, archived: 2, all: 4 })
  expect(filterLineScope(lines, 'manageable').map((line) => line.public_model)).toEqual(['OPEN', 'draft'])
  expect(filterLineScope(lines, 'archived', ' NAME CLOSED ').map((line) => line.public_model)).toEqual(['closed'])
  expect(filterLineScope(lines, 'all', 'open').map((line) => line.public_model)).toEqual(['OPEN'])
})

it('archives every Sanbao draft without confusing other unpublished suppliers', () => {
  const retired = record('sanbao-unpublished', null)
  retired.draft!.provider = 'sanbao'
  const current = record('cansee-unpublished', null)
  current.draft!.provider = 'canseedream'
  expect(isArchivedLine(retired)).toBe(true)
  expect(filterLineScope([retired, current], 'manageable')).toEqual([current])
  expect(filterLineScope([retired, current], 'archived')).toEqual([retired])
  expect(lineScopeCounts([retired, current])).toEqual({ manageable: 1, archived: 1, all: 2 })
  expect(filterLineScope([retired], 'manageable', 'sanbao')).toEqual([])
})
