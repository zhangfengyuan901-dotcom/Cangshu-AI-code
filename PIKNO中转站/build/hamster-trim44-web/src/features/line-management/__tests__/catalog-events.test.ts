import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { catalogEventRevision, subscribeToCatalogChanges } from '../catalog-events'

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []
  close = vi.fn()
  constructor(readonly url: string) {
    super()
    FakeEventSource.instances.push(this)
  }
  emit(revision: string) {
    this.dispatchEvent(new MessageEvent('catalog-change', { data: JSON.stringify({ revision }) }))
  }
}

let visible: DocumentVisibilityState
let dispose: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  FakeEventSource.instances = []
  visible = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible)
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('accepts revision-only metadata and rejects malformed or unsafe payloads', () => {
  expect(catalogEventRevision('{"revision":"abc"}')).toBe('abc')
  expect(catalogEventRevision('{"revision":7}')).toBe('7')
  for (const data of ['not-json', 'null', '[]', '{}', '{"revision":{}}', '{"revision":""}', '{"revision":-1}', '{"revision":"a\\nb"}', JSON.stringify({ revision: 'a'.repeat(129) })]) {
    expect(catalogEventRevision(data)).toBeNull()
  }
})

it('coalesces a burst of changes, deduplicates revisions and limits refresh frequency', () => {
  const refresh = vi.fn()
  dispose = subscribeToCatalogChanges(refresh)
  const source = FakeEventSource.instances[0]
  expect(source?.url).toBe('/api/pikno/catalog/events')
  source?.dispatchEvent(new Event('open'))
  for (let index = 0; index < 20; index++) source?.emit(String(index))
  vi.advanceTimersByTime(249)
  expect(refresh).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  source?.emit('19')
  vi.advanceTimersByTime(2100)
  expect(refresh).toHaveBeenCalledTimes(1)
  source?.emit('20')
  vi.advanceTimersByTime(250)
  expect(refresh).toHaveBeenCalledTimes(2)
  source?.emit('21')
  source?.dispatchEvent(new Event('open'))
  vi.advanceTimersByTime(1999)
  expect(refresh).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(1)
  expect(refresh).toHaveBeenCalledTimes(3)
})

it('disconnects while hidden, cancels queued work and refreshes after reconnect', () => {
  const refresh = vi.fn()
  dispose = subscribeToCatalogChanges(refresh)
  const first = FakeEventSource.instances[0]
  first?.emit('one')
  visible = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  expect(first?.close).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(60000)
  expect(refresh).not.toHaveBeenCalled()
  visible = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  const second = FakeEventSource.instances[1]
  expect(second).toBeDefined()
  second?.dispatchEvent(new Event('open'))
  vi.advanceTimersByTime(250)
  expect(refresh).toHaveBeenCalledOnce()
  dispose()
  second?.emit('two')
  vi.advanceTimersByTime(60000)
  expect(second?.close).toHaveBeenCalledOnce()
  expect(refresh).toHaveBeenCalledOnce()
})

it('does not connect a hidden page and tolerates unavailable EventSource', () => {
  visible = 'hidden'
  dispose = subscribeToCatalogChanges(vi.fn())
  expect(FakeEventSource.instances).toHaveLength(0)
  dispose()
  vi.stubGlobal('EventSource', undefined)
  expect(() => subscribeToCatalogChanges(vi.fn())()).not.toThrow()
})
