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
import axios, { type AxiosAdapter } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AuthBundle } from '@/stores/auth-store'

const originalAdapter = axios.defaults.adapter
const bundle: AuthBundle = {
  access_token: 'test-access-token',
  token_type: 'Bearer',
  access_expires_at: 9_999_999_999,
  user: { id: 42, username: 'test-user', role: 1 },
  session: {
    sid: 'test-session',
    current: true,
    login_method: 'password',
    ip: '127.0.0.1',
    user_agent: 'test',
    created_at: 100,
    last_active_at: 100,
    expires_at: 9_999_999_999,
  },
}

const pendingResponses: Array<() => void> = []

class ControlledRefreshXHR {
  static sent: ControlledRefreshXHR[] = []
  timeout = 0
  status = 0
  statusText = ''
  responseText = ''
  withCredentials = false
  onloadend: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onerror: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  open() {}
  setRequestHeader() {}
  getAllResponseHeaders() {
    return 'content-type: application/json\r\n'
  }
  send() {
    ControlledRefreshXHR.sent.push(this)
    if (this.timeout > 0) {
      this.timer = setTimeout(() => this.ontimeout?.(), this.timeout)
    }
    pendingResponses.push(() => this.respond(503, {}))
  }
  abort() {
    clearTimeout(this.timer)
    this.onabort?.()
  }
  respond(status: number, data: unknown) {
    clearTimeout(this.timer)
    this.status = status
    this.statusText = status === 200 ? 'OK' : 'Unavailable'
    this.responseText = JSON.stringify(data)
    this.onloadend?.()
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('navigator', {})
})

afterEach(async () => {
  for (const resolve of pendingResponses.splice(0)) resolve()
  await vi.runAllTimersAsync()
  axios.defaults.adapter = originalAdapter
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('a stalled refresh exits within its deadline and a later refresh can succeed without signing out', async () => {
  ControlledRefreshXHR.sent = []
  vi.stubGlobal('XMLHttpRequest', ControlledRefreshXHR)
  axios.defaults.adapter = 'xhr'
  const { refreshAuthentication } = await import('../auth-session')
  const { useAuthStore } = await import('@/stores/auth-store')
  useAuthStore.getState().auth.setBundle(bundle)
  const settled = vi.fn()
  const first = refreshAuthentication().then(settled)

  await vi.advanceTimersByTimeAsync(15_000)

  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'transient_error' })
  )
  await first
  expect(useAuthStore.getState().auth.session?.sid).toBe(bundle.session.sid)
  expect(useAuthStore.getState().auth.accessToken).toBe(bundle.access_token)
  expect(ControlledRefreshXHR.sent).toHaveLength(1)
  const recovered = refreshAuthentication()
  await vi.advanceTimersByTimeAsync(0)
  expect(ControlledRefreshXHR.sent).toHaveLength(2)
  ControlledRefreshXHR.sent[1].respond(200, { success: true, data: bundle })
  await expect(recovered).resolves.toMatchObject({ kind: 'authenticated' })
})

it('a blocked cross-tab refresh lock stops waiting without sending a parallel refresh and can be acquired later', async () => {
  let blocked = true
  const request = vi.fn(
    (
      name: string,
      options: LockOptions,
      callback: LockGrantedCallback<unknown>
    ) => {
      if (!blocked) {
        return Promise.resolve(callback({ name, mode: 'exclusive' } as Lock))
      }
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true }
        )
        pendingResponses.push(() => resolve(undefined))
      })
    }
  )
  vi.stubGlobal('navigator', { locks: { request } })
  const adapter = vi.fn<AxiosAdapter>(async (config) => ({
    status: 200,
    statusText: 'OK',
    data: { success: true, data: bundle },
    headers: {},
    config,
  }))
  axios.defaults.adapter = adapter
  const { refreshAuthentication } = await import('../auth-session')
  const { useAuthStore } = await import('@/stores/auth-store')
  useAuthStore.getState().auth.setBundle(bundle)
  const settled = vi.fn()
  const first = refreshAuthentication().then(settled)

  await vi.advanceTimersByTimeAsync(15_000)

  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'transient_error' })
  )
  await first
  expect(adapter).not.toHaveBeenCalled()
  expect(request.mock.calls[0][1]).toMatchObject({ mode: 'exclusive' })
  expect(request.mock.calls[0][1].steal).not.toBe(true)
  expect(useAuthStore.getState().auth.session?.sid).toBe(bundle.session.sid)
  blocked = false
  await expect(refreshAuthentication()).resolves.toMatchObject({
    kind: 'authenticated',
  })
  expect(adapter).toHaveBeenCalledTimes(1)
})

it('a queued refresh timeout cannot reset a newer authenticated session', async () => {
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, options: LockOptions) =>
        new Promise((resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true }
          )
          pendingResponses.push(() => resolve(undefined))
        }),
    },
  })
  const { applyAuthBundle, refreshAuthentication } =
    await import('../auth-session')
  const { useAuthStore } = await import('@/stores/auth-store')
  const settled = vi.fn()
  const first = refreshAuthentication().then(settled)
  const newerBundle = {
    ...bundle,
    session: { ...bundle.session, sid: 'newer-session' },
  }
  applyAuthBundle(newerBundle, false)

  await vi.advanceTimersByTimeAsync(15_000)

  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'transient_error' })
  )
  await first
  expect(useAuthStore.getState().auth.session?.sid).toBe('newer-session')
  expect(useAuthStore.getState().auth.bootstrapState).toBe('complete')
})

it('acquiring the refresh lock cancels only the queue deadline while the in-flight refresh keeps its own deadline', async () => {
  let lockSignal: AbortSignal | undefined
  vi.stubGlobal('navigator', {
    locks: {
      request: (
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>
      ) =>
        new Promise((resolve, reject) => {
          lockSignal = options.signal
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true }
          )
          setTimeout(
            () => resolve(callback({ name, mode: 'exclusive' } as Lock)),
            14_999
          )
          pendingResponses.push(() => resolve(undefined))
        }),
    },
  })
  ControlledRefreshXHR.sent = []
  vi.stubGlobal('XMLHttpRequest', ControlledRefreshXHR)
  axios.defaults.adapter = 'xhr'
  const { refreshAuthentication } = await import('../auth-session')
  const settled = vi.fn()
  const refresh = refreshAuthentication().then(settled)

  await vi.advanceTimersByTimeAsync(14_999)
  expect(ControlledRefreshXHR.sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(lockSignal?.aborted).toBe(false)
  expect(settled).not.toHaveBeenCalled()
  ControlledRefreshXHR.sent[0].respond(200, { success: true, data: bundle })
  await refresh
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'authenticated' })
  )
})
