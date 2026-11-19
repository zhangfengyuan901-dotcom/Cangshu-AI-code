/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import axios from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { api } from '../http-client'

// Only the browser's network boundary is replaced. Axios dispatch, timeout
// rejection, cancellation, interceptors, and GET sharing all run normally.
class ControlledXHR {
  static sent: ControlledXHR[] = []

  timeout = 0
  status = 0
  statusText = ''
  responseText = ''
  withCredentials = false
  onloadend: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onerror: (() => void) | null = null
  method = ''
  private timer: ReturnType<typeof setTimeout> | undefined

  open(method: string) {
    this.method = method
  }

  setRequestHeader() {}

  getAllResponseHeaders() {
    return 'content-type: application/json\r\n'
  }

  send() {
    ControlledXHR.sent.push(this)
    if (this.timeout > 0) {
      this.timer = setTimeout(() => this.ontimeout?.(), this.timeout)
    }
  }

  abort() {
    clearTimeout(this.timer)
    this.onabort?.()
  }

  respond(status = 200, data: unknown = { success: true }) {
    clearTimeout(this.timer)
    this.status = status
    this.statusText = status === 200 ? 'OK' : 'Unavailable'
    this.responseText = JSON.stringify(data)
    this.onloadend?.()
  }
}

const originalAdapter = api.defaults.adapter
let pathNumber = 0

function nextPath() {
  return `/api/test/read-deadline-${++pathNumber}`
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('XMLHttpRequest', ControlledXHR)
  ControlledXHR.sent = []
  api.defaults.adapter = 'xhr'
  useAuthStore.getState().auth.reset('complete')
})

afterEach(() => {
  for (const request of ControlledXHR.sent) request.respond()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset('complete')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('ends an unanswered default GET at 30 seconds and permits a fresh request', async () => {
  const path = nextPath()
  let outcome: unknown
  const first = api.get(path).catch((error: unknown) => {
    outcome = error
    return error
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledXHR.sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(29_999)
  expect(outcome).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(outcome).toMatchObject({ code: 'ECONNABORTED' })
  expect(await first).toMatchObject({ code: 'ECONNABORTED' })
  expect(ControlledXHR.sent).toHaveLength(1)

  const second = api.get(path)
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledXHR.sent).toHaveLength(2)
  ControlledXHR.sent[1].respond(200, { success: true, data: 'recovered' })
  expect((await second).data.data).toBe('recovered')
})

it('uses the explicit GET deadline instead of the default', async () => {
  let outcome: unknown
  const request = api
    .get(nextPath(), { timeout: 45_000 })
    .catch((error: unknown) => {
      outcome = error
      return error
    })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(outcome).toBeUndefined()
  await vi.advanceTimersByTimeAsync(14_999)
  expect(outcome).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(await request).toMatchObject({ code: 'ECONNABORTED' })
  expect(ControlledXHR.sent).toHaveLength(1)
})

it('shares duplicate GETs with the same deadline and releases both on timeout', async () => {
  const path = nextPath()
  const first = api.get(path, { timeout: 25 })
  const second = api.get(path, { timeout: 25 })
  const results = Promise.allSettled([first, second])
  expect(second).toBe(first)
  await vi.advanceTimersByTimeAsync(24)
  expect(ControlledXHR.sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await results).toEqual([
    {
      status: 'rejected',
      reason: expect.objectContaining({ code: 'ECONNABORTED' }),
    },
    {
      status: 'rejected',
      reason: expect.objectContaining({ code: 'ECONNABORTED' }),
    },
  ])
})

it('does not share the same GET across different deadlines', async () => {
  const path = nextPath()
  const short = api.get(path, { timeout: 25 }).catch((error: unknown) => error)
  const long = api.get(path, { timeout: 100 })
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledXHR.sent).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(25)
  expect(await short).toMatchObject({ code: 'ECONNABORTED' })
  ControlledXHR.sent[1].respond(200, { success: true, data: 'long request' })
  expect((await long).data.data).toBe('long request')
})

it('keeps an AbortSignal consumer independent from shared GET consumers', async () => {
  const path = nextPath()
  const controller = new AbortController()
  const canceled = api
    .get(path, { signal: controller.signal })
    .catch((error: unknown) => error)
  const survivor = api.get(path)
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledXHR.sent).toHaveLength(2)
  controller.abort()
  expect(axios.isCancel(await canceled)).toBe(true)
  ControlledXHR.sent[1].respond(200, { success: true, data: 'survived' })
  expect((await survivor).data.data).toBe('survived')
})

it('keeps a CancelToken consumer independent from shared GET consumers', async () => {
  const path = nextPath()
  const source = axios.CancelToken.source()
  const survivor = api.get(path)
  const canceled = api
    .get(path, { cancelToken: source.token })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledXHR.sent).toHaveLength(2)
  source.cancel()
  expect(axios.isCancel(await canceled)).toBe(true)
  ControlledXHR.sent[0].respond(200, { success: true, data: 'survived' })
  expect((await survivor).data.data).toBe('survived')
})

it('applies the read deadline when GET sharing is explicitly disabled', async () => {
  const path = nextPath()
  const first = api
    .get(path, { disableDuplicate: true })
    .catch((error: unknown) => error)
  const second = api
    .get(path, { disableDuplicate: true })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledXHR.sent).toHaveLength(2)
  expect(ControlledXHR.sent.map((request) => request.timeout)).toEqual([
    30_000, 30_000,
  ])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await first).toMatchObject({ code: 'ECONNABORTED' })
  expect(await second).toMatchObject({ code: 'ECONNABORTED' })
})

it('leaves mutation deadlines unchanged and never replays a timed out mutation', async () => {
  const path = nextPath()
  const untimed = api.post(path, {})
  await vi.advanceTimersByTimeAsync(30_000)
  expect(ControlledXHR.sent).toHaveLength(1)
  expect(ControlledXHR.sent[0].timeout).toBe(0)
  ControlledXHR.sent[0].respond()
  await untimed

  const timed = api
    .post(path, {}, { timeout: 25 })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(25)
  expect(await timed).toMatchObject({ code: 'ECONNABORTED' })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(ControlledXHR.sent).toHaveLength(2)
})
