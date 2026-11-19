import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { startCatalogRefresh } from '../refresh'

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
let online: boolean
let dispose: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  visible = 'visible'
  online = true
  FakeEventSource.instances = []
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible)
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup() {
  const state = { isFetching: false, lastSuccessAt: Date.now(), lastErrorAt: 0, error: undefined as unknown }
  const read = vi.fn(async () => {
    state.lastSuccessAt = Date.now()
  })
  const onUnverified = vi.fn()
  const onVerified = vi.fn()
  const controller = startCatalogRefresh({ read, state: () => state, onUnverified, onVerified })
  dispose = controller.dispose
  return { state, read, onUnverified, onVerified, controller }
}

it('checks the first SSE revision once, even when the initial GET completed first', async () => {
  const { read, onUnverified } = setup()
  const source = FakeEventSource.instances[0]
  source.dispatchEvent(new Event('open'))
  source.emit('first')
  source.emit('first')
  source.dispatchEvent(new Event('open'))
  expect(onUnverified).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1999)
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledOnce()
  source.emit('first')
  source.dispatchEvent(new Event('open'))
  await vi.advanceTimersByTimeAsync(5000)
  expect(read).toHaveBeenCalledOnce()
})

it('does not join a GET started before a changed revision and coalesces the burst after it', async () => {
  const { state, read } = setup()
  state.isFetching = true
  for (let index = 0; index < 50; index++) FakeEventSource.instances[0].emit(String(index))
  await vi.advanceTimersByTimeAsync(3000)
  expect(read).not.toHaveBeenCalled()
  state.isFetching = false
  state.lastSuccessAt = Date.now()
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenCalledOnce()
})

it('preserves a newer revision received during a read and verifies it with one follow-up', async () => {
  const { state, read, onVerified } = setup()
  let finish: (() => void) | undefined
  read.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finish = () => { state.lastSuccessAt = Date.now(); resolve() }
  }))
  const source = FakeEventSource.instances[0]
  source.emit('one')
  await vi.advanceTimersByTimeAsync(2000)
  expect(read).toHaveBeenCalledOnce()
  source.emit('two')
  source.emit('three')
  await vi.advanceTimersByTimeAsync(1000)
  finish?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(onVerified).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(read).toHaveBeenCalledTimes(2)
  expect(onVerified).toHaveBeenCalledOnce()
})

it('refreshes visible pages every minute when SSE is unavailable', async () => {
  vi.stubGlobal('EventSource', undefined)
  const { read } = setup()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60_250)
  expect(read).toHaveBeenCalledTimes(2)
})

it('merges focus and reconnect bursts into one read and keeps fresh focus silent', async () => {
  const { read } = setup()
  for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(3000)
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(57_000)
  for (let i = 0; i < 20; i++) {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
  }
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenCalledOnce()
})

it('stops hidden/offline reads, closes streams and cleans all listeners and timers on disposal', async () => {
  const { read, controller } = setup()
  const source = FakeEventSource.instances[0]
  source.emit('one')
  visible = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  expect(source.close).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(read).not.toHaveBeenCalled()
  online = false
  visible = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).not.toHaveBeenCalled()
  online = true
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenCalledOnce()
  expect(FakeEventSource.instances).toHaveLength(2)
  controller.dispose()
  source.emit('late')
  window.dispatchEvent(new Event('online'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(read).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('honors Retry-After on an initial 429 and manual retries cannot bypass the deadline', async () => {
  const { state, read, controller } = setup()
  state.lastErrorAt = Date.now()
  state.error = { response: { status: 429, headers: { 'retry-after': '120' } } }
  for (let i = 0; i < 10; i++) controller.refresh()
  await vi.advanceTimersByTimeAsync(119_999)
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledOnce()
})

it('rechecks an initial query failure that arrives just before a queued SSE read', async () => {
  const { state, read } = setup()
  state.isFetching = true
  FakeEventSource.instances[0].emit('first')
  await vi.advanceTimersByTimeAsync(2001)
  state.isFetching = false
  state.lastErrorAt = Date.now()
  state.error = { response: { status: 429, headers: { 'retry-after': '120' } } }
  await vi.advanceTimersByTimeAsync(119_999)
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledOnce()
})

it('does not mark retained data verified when a paused query settles without reading', async () => {
  const { read, onVerified, onUnverified, controller } = setup()
  read.mockImplementationOnce(async () => {})
  controller.refresh()
  await vi.advanceTimersByTimeAsync(2000)
  expect(read).toHaveBeenCalledOnce()
  expect(onVerified).not.toHaveBeenCalled()
  expect(onUnverified).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(read).toHaveBeenCalledTimes(2)
  expect(onVerified).toHaveBeenCalledOnce()
})

it('backs off failed reads and restores verified state after recovery', async () => {
  const { read, onUnverified, onVerified, controller } = setup()
  read.mockRejectedValueOnce({ response: { status: 503 } })
  read.mockRejectedValueOnce({ code: 'ECONNABORTED' })
  controller.refresh()
  await vi.advanceTimersByTimeAsync(2000)
  expect(read).toHaveBeenCalledOnce()
  expect(onUnverified).toHaveBeenCalledOnce()
  expect(onVerified).not.toHaveBeenCalled()
  for (let i = 0; i < 20; i++) controller.refresh()
  await vi.advanceTimersByTimeAsync(9999)
  expect(read).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(19_999)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(3)
  expect(onVerified).toHaveBeenCalledOnce()
})

it('bounds a server cooldown, accepts HTTP dates and ignores invalid Retry-After values', async () => {
  const { state, read, controller } = setup()
  state.lastErrorAt = Date.now()
  state.error = { response: { headers: { 'retry-after': new Date(Date.now() + 3_700_000).toUTCString() } } }
  controller.refresh()
  await vi.advanceTimersByTimeAsync(3_599_999)
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledOnce()
  state.lastErrorAt = Date.now() + 1
  state.error = { response: { headers: { 'retry-after': 'not-a-date' } } }
  controller.refresh()
  await vi.advanceTimersByTimeAsync(10_001)
  expect(read).toHaveBeenCalledTimes(2)
})

it('backs off stream reconnection while polling remains available and ignores closed streams', async () => {
  const { onUnverified, controller } = setup()
  const first = FakeEventSource.instances[0]
  first.dispatchEvent(new Event('error'))
  expect(first.close).toHaveBeenCalledOnce()
  expect(onUnverified).toHaveBeenCalledOnce()
  first.emit('late')
  await vi.advanceTimersByTimeAsync(4999)
  expect(FakeEventSource.instances).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(FakeEventSource.instances).toHaveLength(2)
  FakeEventSource.instances[1].dispatchEvent(new Event('error'))
  await vi.advanceTimersByTimeAsync(9999)
  expect(FakeEventSource.instances).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(FakeEventSource.instances).toHaveLength(3)
  controller.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
