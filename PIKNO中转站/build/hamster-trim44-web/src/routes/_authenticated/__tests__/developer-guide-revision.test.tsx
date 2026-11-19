import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Route } from '../developer'

// The component, React Query, shared API and Axios XHR adapter stay real.
// Only the browser network boundary is controlled; no server is contacted.
class GuideXHR {
  static sent: GuideXHR[] = []
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

  open(_method: string, url: string): void {
    this.url = url
  }
  setRequestHeader(): void {}
  getAllResponseHeaders(): string {
    return 'content-type: text/markdown\r\n'
  }
  send(): void {
    GuideXHR.sent.push(this)
  }
  abort(): void {
    this.onabort?.()
  }
  respond(status: number, text: string): void {
    this.status = status
    this.statusText = status === 200 ? 'OK' : 'Unavailable'
    this.responseText = text
    this.onloadend?.()
  }
}

const originalAdapter = api.defaults.adapter
const ApiGuide = Route.options.component as ComponentType
let client: QueryClient

beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', GuideXHR)
  api.defaults.adapter = 'xhr'
  GuideXHR.sent = []
  useAuthStore.getState().auth.reset('complete')
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
})

afterEach(async () => {
  cleanup()
  await client.cancelQueries()
  client.clear()
  for (const request of GuideXHR.sent) request.respond(503, '')
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset('complete')
  vi.unstubAllGlobals()
})

it('fetches and shows the redacted release document instead of a fresh old document query cache', async () => {
  client.setQueryData(
    ['pikno-api-guide'],
    '# PIKNO old document\n\nOld supplier content'
  )
  render(
    <QueryClientProvider client={client}>
      <ApiGuide />
    </QueryClientProvider>
  )

  expect(screen.queryByText('Old supplier content')).not.toBeInTheDocument()
  await waitFor(() => expect(GuideXHR.sent).toHaveLength(1))
  const requestURL = new URL(GuideXHR.sent[0].url, window.location.origin)
  expect(requestURL.pathname).toBe('/developer-guide.md')
  expect(requestURL.searchParams.get('revision')).toBe('client34-20261016')

  await act(async () => {
    GuideXHR.sent[0].respond(
      200,
      '# 仓鼠AI API 接入说明\n\n## 客户价格与工具权限'
    )
  })
  expect(
    await screen.findByRole('heading', { name: '客户价格与工具权限' })
  ).toBeVisible()
  expect(screen.queryByText('Old supplier content')).not.toBeInTheDocument()
})

it('keeps the release URL when the document fails and the user retries through the shared error state', async () => {
  render(
    <QueryClientProvider client={client}>
      <ApiGuide />
    </QueryClientProvider>
  )
  await waitFor(() => expect(GuideXHR.sent).toHaveLength(1))
  expect(
    new URL(GuideXHR.sent[0].url, window.location.origin).searchParams.get(
      'revision'
    )
  ).toBe('client34-20261016')

  await act(async () => {
    GuideXHR.sent[0].respond(503, '')
  })
  expect(await screen.findByText('Unable to load API docs')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(GuideXHR.sent).toHaveLength(2))
  expect(GuideXHR.sent[1].url).toBe(GuideXHR.sent[0].url)

  await act(async () => {
    GuideXHR.sent[1].respond(200, '# 仓鼠AI API 接入说明\n\n## 读取恢复')
  })
  expect(await screen.findByRole('heading', { name: '读取恢复' })).toBeVisible()
  expect(screen.queryByText('Unable to load API docs')).not.toBeInTheDocument()
})
