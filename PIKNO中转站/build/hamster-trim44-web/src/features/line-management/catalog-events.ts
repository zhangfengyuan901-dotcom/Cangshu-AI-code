const burstDelayMs = 250
const minimumRefreshMs = 2000

export function catalogEventRevision(data: string): string | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const revision = (parsed as { revision?: unknown }).revision
    if (typeof revision === 'string' && revision.length > 0 && revision.length <= 128 && [...revision].every((character) => character.charCodeAt(0) >= 32)) {
      return revision
    }
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) return String(revision)
    return null
  } catch {
    return null
  }
}

// Query invalidation updates the list only. The editor keeps its separately
// captured line/version, so a push cannot replace unsaved operator input.
export function subscribeToCatalogChanges(onChange: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  let source: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRevision: string | null = null
  let lastRefreshAt: number | null = null
  let disposed = false

  function scheduleRefresh() {
    if (disposed || document.visibilityState === 'hidden' || timer != null) return
    const delay = lastRefreshAt == null ? burstDelayMs : Math.max(burstDelayMs, minimumRefreshMs - (Date.now() - lastRefreshAt))
    timer = setTimeout(() => {
      timer = null
      if (disposed || document.visibilityState === 'hidden') return
      lastRefreshAt = Date.now()
      onChange()
    }, delay)
  }

  function disconnect() {
    source?.close()
    source = null
    if (timer != null) clearTimeout(timer)
    timer = null
  }

  function connect() {
    if (disposed || document.visibilityState === 'hidden' || source) return
    source = new EventSource('/api/pikno/catalog/events')
    source.addEventListener('open', scheduleRefresh)
    source.addEventListener('catalog-change', (event) => {
      const revision = catalogEventRevision((event as MessageEvent<string>).data)
      if (revision == null || revision === lastRevision) return
      lastRevision = revision
      scheduleRefresh()
    })
    // Native EventSource handles transient disconnects and reconnection.
    // Polling and query focus refresh remain active if SSE is unavailable.
  }

  function visibilityChanged() {
    if (document.visibilityState === 'hidden') disconnect()
    else connect()
  }

  document.addEventListener('visibilitychange', visibilityChanged)
  connect()
  return () => {
    disposed = true
    disconnect()
    document.removeEventListener('visibilitychange', visibilityChanged)
  }
}
