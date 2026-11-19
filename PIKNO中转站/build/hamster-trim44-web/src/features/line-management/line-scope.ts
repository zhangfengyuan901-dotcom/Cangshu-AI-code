import type { LineRecord } from './types'
import { isRetiredUpstream } from '@/lib/retired-upstreams'

export type LineScope = 'manageable' | 'archived' | 'all'

export function isRetiredLine(line: LineRecord): boolean {
  return isRetiredUpstream(line.draft?.provider) || isRetiredUpstream(line.published?.provider)
}

// A closed upstream is archived even before its first publication. Other
// drafts remain available for pricing, protocol and billing configuration.
export function isArchivedLine(line: LineRecord): boolean {
  return isRetiredLine(line) || Boolean(line.published && !line.published.enabled) || Boolean(
    line.sync?.paused && ['disabled', 'missing', 'stale'].includes(line.sync.pause_reason)
  )
}

export function filterLineScope(lines: LineRecord[], scope: LineScope, search = ''): LineRecord[] {
  const term = search.trim().toLowerCase()
  return lines.filter((line) => {
    const config = line.draft ?? line.published
    if (!config) return false
    if (scope !== 'all' && isArchivedLine(line) !== (scope === 'archived')) return false
    return `${line.public_model} ${config.name}`.toLowerCase().includes(term)
  })
}

export function lineScopeCounts(lines: LineRecord[]): Record<LineScope, number> {
  const all = lines.filter((line) => line.draft ?? line.published)
  const archived = all.filter(isArchivedLine).length
  return { manageable: all.length - archived, archived, all: all.length }
}
