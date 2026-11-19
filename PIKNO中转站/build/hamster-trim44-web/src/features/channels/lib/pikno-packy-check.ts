import type { Channel } from '../types'

export function isPiknoPackyImageChannel(channel: Channel | null): boolean {
  if (!channel || channel.type !== 1) return false
  try {
    return new URL(channel.base_url?.trim() ?? '').hostname === 'cf.api.fan'
  } catch {
    return false
  }
}

export function getPackyMappedModels(channel: Channel) {
  let mapping: Record<string, string> = {}
  let invalidMapping = false
  try {
    const parsed: unknown = JSON.parse(channel.model_mapping || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      invalidMapping = true
    } else if (
      Object.values(parsed).some((value) => typeof value !== 'string')
    ) {
      invalidMapping = true
    } else {
      mapping = parsed as Record<string, string>
    }
  } catch {
    invalidMapping = true
  }

  return [
    ...new Set(
      channel.models
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ].map((model) => {
    let upstreamModel = model
    let invalid = invalidMapping
    const seen = new Set([model])
    while (
      !invalid &&
      Object.hasOwn(mapping, upstreamModel) &&
      mapping[upstreamModel]
    ) {
      const next = mapping[upstreamModel]
      if (next === upstreamModel) break
      if (seen.has(next)) {
        invalid = true
        break
      }
      seen.add(next)
      upstreamModel = next
    }
    return { model, upstreamModel, invalid }
  })
}
