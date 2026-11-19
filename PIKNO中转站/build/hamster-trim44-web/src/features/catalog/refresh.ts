import { catalogEventRevision } from '@/features/line-management/catalog-events'

const pollMs = 60_000
const minimumReadMs = 2000
const burstMs = 250
const maximumWaitMs = 60 * 60_000

interface CatalogReadState {
  isFetching: boolean
  lastSuccessAt: number
  lastErrorAt: number
  error: unknown
}

interface CatalogRefreshOptions {
  read: () => Promise<unknown>
  state: () => CatalogReadState
  onUnverified: () => void
  onVerified: () => void
}

function retryAfterMs(error: unknown, now: number): number {
  if (error == null || typeof error !== 'object') return 0
  const response = (error as { response?: { headers?: Record<string, unknown> } }).response
  const value = response?.headers?.['retry-after']
  if (typeof value !== 'string' && typeof value !== 'number') return 0
  const text = String(value).trim()
  const delay = /^\d+(?:\.\d+)?$/.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now
  return Number.isFinite(delay) ? Math.min(maximumWaitMs, Math.max(0, delay)) : 0
}

// One coordinator owns reads, timers and the public revision subscription.
// It never changes the server's line availability or billing decisions.
export function startCatalogRefresh(options: CatalogRefreshOptions) {
  let disposed = false
  let source: EventSource | null = null
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let lastRevision: string | null = null
  let generation = 0
  let inFlight = false
  let requested = false
  let lastStartedAt = Date.now()
  let nextReadAt = 0
  let lastSeenErrorAt = 0
  let failures = 0
  let streamFailures = 0

  const active = () => !disposed && document.visibilityState !== 'hidden' && navigator.onLine !== false

  function clearTimers() {
    if (readTimer != null) clearTimeout(readTimer)
    if (pollTimer != null) clearTimeout(pollTimer)
    if (reconnectTimer != null) clearTimeout(reconnectTimer)
    readTimer = pollTimer = reconnectTimer = null
  }

  function recordFailure(error: unknown, at: number) {
    failures += 1
    nextReadAt = Math.max(nextReadAt, at + Math.max(
      Math.min(pollMs, 10_000 * 2 ** Math.min(failures - 1, 3)),
      retryAfterMs(error, at)
    ))
    options.onUnverified()
  }

  function observeFailure() {
    const state = options.state()
    if (state.error == null || state.lastErrorAt <= lastSeenErrorAt) return
    lastSeenErrorAt = state.lastErrorAt
    recordFailure(state.error, state.lastErrorAt)
  }

  function scheduleRead() {
    if (!active() || inFlight || !requested || readTimer != null) return
    observeFailure()
    const delay = Math.max(burstMs, nextReadAt - Date.now(), lastStartedAt + minimumReadMs - Date.now())
    readTimer = setTimeout(() => {
      readTimer = null
      void runRead()
    }, delay)
  }

  function armPoll() {
    if (pollTimer != null) clearTimeout(pollTimer)
    pollTimer = null
    if (!active()) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      requestRefresh()
      armPoll()
    }, pollMs)
  }

  async function runRead() {
    if (!active() || inFlight || !requested) return
    // The initial query can fail between scheduling and running this timer.
    // Recheck its cooldown before issuing the queued revision read.
    observeFailure()
    if (Date.now() < Math.max(nextReadAt, lastStartedAt + minimumReadMs)) {
      scheduleRead()
      return
    }
    // A changed revision arriving during the initial query must be read after
    // that query, rather than joining a response started before the change.
    if (options.state().isFetching) {
      scheduleRead()
      return
    }
    requested = false
    inFlight = true
    lastStartedAt = Date.now()
    const startedGeneration = generation
    try {
      await options.read()
      // refetchQueries can settle without a new read when a query is paused.
      // Retained data is not proof that this attempt verified the directory.
      if (options.state().lastSuccessAt < lastStartedAt) {
        throw new Error('Catalog read has not been verified')
      }
      failures = 0
      nextReadAt = 0
      if (!disposed && startedGeneration === generation) options.onVerified()
      armPoll()
    } catch (error) {
      if (disposed) return
      lastSeenErrorAt = options.state().lastErrorAt
      recordFailure(error, Date.now())
      requested = true
    } finally {
      inFlight = false
      scheduleRead()
    }
  }

  function requestRefresh(changed = false) {
    if (disposed) return
    if (changed) {
      generation += 1
      options.onUnverified()
    }
    // Focus/manual/poll callers share an existing read. A new revision is the
    // only reason to queue another read after one already in progress.
    if (!changed && (inFlight || options.state().isFetching)) return
    requested = true
    scheduleRead()
  }

  function disconnect() {
    source?.close()
    source = null
  }

  function connect() {
    if (!active() || source || reconnectTimer != null || typeof EventSource === 'undefined') return
    try {
      const current = new EventSource('/api/pikno/catalog/events')
      source = current
      current.addEventListener('open', () => {
        if (source === current) streamFailures = 0
      })
      current.addEventListener('catalog-change', (event) => {
        if (disposed || source !== current) return
        const revision = catalogEventRevision((event as MessageEvent<string>).data)
        if (revision == null || revision === lastRevision) return
        lastRevision = revision
        // GET and SSE revisions use different public formats. Even the first
        // event needs one follow-up read; it cannot prove an earlier GET
        // included that state. Repeated open/identical events do not reread.
        requestRefresh(true)
      })
      current.addEventListener('error', () => {
        if (disposed || source !== current) return
        disconnect()
        options.onUnverified()
        retryStream()
      })
    } catch {
      retryStream()
    }
  }

  function retryStream() {
    if (!active() || reconnectTimer != null) return
    const delay = Math.min(pollMs, 5000 * 2 ** Math.min(streamFailures++, 4))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function resumed() {
    if (!active()) {
      clearTimers()
      disconnect()
      if (navigator.onLine === false) options.onUnverified()
      return
    }
    connect()
    armPoll()
    const state = options.state()
    if (state.error != null || Date.now() - state.lastSuccessAt >= pollMs) {
      requestRefresh()
    }
    scheduleRead()
  }

  function online() {
    resumed()
    requestRefresh()
  }

  document.addEventListener('visibilitychange', resumed)
  window.addEventListener('focus', resumed)
  window.addEventListener('online', online)
  window.addEventListener('offline', resumed)
  connect()
  armPoll()
  if (navigator.onLine === false) options.onUnverified()

  return {
    refresh: () => requestRefresh(),
    dispose() {
      disposed = true
      clearTimers()
      disconnect()
      document.removeEventListener('visibilitychange', resumed)
      window.removeEventListener('focus', resumed)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', resumed)
    },
  }
}
