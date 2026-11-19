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
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getCatalog } from '@/features/catalog/api'
import { CatalogDirectory } from '@/features/catalog/directory'
import { useAuthStore } from '@/stores/auth-store'

import { api } from '../http-client'
import { getModuleAccessForGuard } from '../nav-modules'
import { createAppQueryClient } from '../query-client'

// Keep the real guard, QueryClient retryer, HTTP client, and Axios XHR adapter.
// Only the unresponsive browser network is controlled by the test clock.
class UnresponsiveStatusXHR {
  static sent: UnresponsiveStatusXHR[] = []
  timeout = 0
  status = 0
  statusText = ''
  responseText = ''
  withCredentials = false
  onloadend: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onerror: (() => void) | null = null
  url = ''
  private timer: ReturnType<typeof setTimeout> | undefined

  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader() {}
  getAllResponseHeaders() {
    return 'content-type: application/json\r\n'
  }
  send() {
    UnresponsiveStatusXHR.sent.push(this)
    if (this.timeout > 0) {
      this.timer = setTimeout(() => this.ontimeout?.(), this.timeout)
    }
  }
  abort() {
    clearTimeout(this.timer)
    this.onabort?.()
  }
  respond(status = 503, data: unknown = {}) {
    clearTimeout(this.timer)
    this.status = status
    this.statusText = status === 200 ? 'OK' : 'Unavailable'
    this.responseText = JSON.stringify(data)
    this.onloadend?.()
  }
}

const originalAdapter = api.defaults.adapter
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('DEV', false)
  vi.stubGlobal('XMLHttpRequest', UnresponsiveStatusXHR)
  api.defaults.adapter = 'xhr'
  UnresponsiveStatusXHR.sent = []
  useAuthStore.getState().auth.reset('complete')
  client = createAppQueryClient()
  client.setQueryData(
    ['status'],
    { HeaderNavModules: { pricing: { enabled: true, requireAuth: false } } },
    { updatedAt: Date.now() - 600_000 }
  )
})

afterEach(async () => {
  cleanup()
  await client.cancelQueries()
  client.clear()
  for (const request of UnresponsiveStatusXHR.sent) request.respond()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset('complete')
  vi.clearAllTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('returns fail-closed within a 10-second navigation status deadline when stale status cannot refresh', async () => {
  const start = Date.now()
  let settledAt: number | undefined
  const guard = getModuleAccessForGuard(client, 'pricing').then((access) => {
    settledAt = Date.now() - start
    return access
  })

  await vi.advanceTimersByTimeAsync(9_999)
  expect(settledAt).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(settledAt).toBe(10_000)
  expect(await guard).toEqual({ enabled: false, requireAuth: true })
  await vi.advanceTimersByTimeAsync(155_000)
  expect(UnresponsiveStatusXHR.sent).toHaveLength(1)
})

it('uses fresh status without network traffic and preserves an auth-required module flag', async () => {
  client.setQueryData(['status'], {
    HeaderNavModules: { pricing: { enabled: true, requireAuth: true } },
  })
  expect(await getModuleAccessForGuard(client, 'pricing')).toEqual({
    enabled: true,
    requireAuth: true,
  })
  expect(UnresponsiveStatusXHR.sent).toHaveLength(0)
})

it('refreshes stale status successfully without relaxing module access flags', async () => {
  const guard = getModuleAccessForGuard(client, 'pricing')
  await vi.advanceTimersByTimeAsync(0)
  expect(UnresponsiveStatusXHR.sent).toHaveLength(1)
  UnresponsiveStatusXHR.sent[0].respond(200, {
    success: true,
    data: {
      HeaderNavModules: { pricing: { enabled: false, requireAuth: true } },
    },
  })
  expect(await guard).toEqual({ enabled: false, requireAuth: true })
})

it('a rejected public status request fails closed without refreshing authentication', async () => {
  let access: unknown
  const guard = getModuleAccessForGuard(client, 'pricing').then((value) => {
    access = value
    return value
  })
  await vi.advanceTimersByTimeAsync(0)
  UnresponsiveStatusXHR.sent[0].respond(401, { success: false })
  await vi.advanceTimersByTimeAsync(0)
  expect(access).toEqual({ enabled: false, requireAuth: true })
  expect(await guard).toEqual(access)
  expect(UnresponsiveStatusXHR.sent).toHaveLength(1)
})

it('ends an unresponsive catalog read at 10 seconds and allows a later successful read', async () => {
  let outcome: unknown
  const first = getCatalog().catch((error: unknown) => {
    outcome = error
    return error
  })
  await vi.advanceTimersByTimeAsync(9_999)
  expect(outcome).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(outcome).toMatchObject({ code: 'ECONNABORTED' })
  await first
  const recovered = getCatalog()
  await vi.advanceTimersByTimeAsync(0)
  expect(UnresponsiveStatusXHR.sent).toHaveLength(2)
  UnresponsiveStatusXHR.sent[1].respond(200, {
    success: true,
    data: { revision: 'test', fetched_at: '2026-10-14', models: [] },
  })
  expect((await recovered).models).toEqual([])
})

it('shows a catalog error after its deadline and respects backoff before a manual recovery', async () => {
  client.setQueryData(['status'], {
    HeaderNavModules: { pricing: { enabled: true, requireAuth: false } },
  })
  client.setQueryData(['notice'], { success: true, data: '' })
  const router = createRouter({
    routeTree: createRootRoute({ component: CatalogDirectory }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RouterProvider, { router })
    )
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(UnresponsiveStatusXHR.sent).toHaveLength(1)
  expect(UnresponsiveStatusXHR.sent[0].timeout).toBe(10_000)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(client.getQueryState(['pikno-catalog'])?.status).toBe('error')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(screen.getByText('Unable to load model catalog')).toBeVisible()
  const catalogRequests = () =>
    UnresponsiveStatusXHR.sent.filter((request) =>
      request.url.endsWith('/api/pikno/catalog')
    )
  expect(catalogRequests()).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9998)
  })
  expect(catalogRequests()).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(catalogRequests()).toHaveLength(2)
  await act(async () => {
    catalogRequests()[1].respond(200, {
      success: true,
      data: { revision: 'test', fetched_at: '2026-10-14', models: [] },
    })
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByText('No catalog models found')).toBeVisible()
})
