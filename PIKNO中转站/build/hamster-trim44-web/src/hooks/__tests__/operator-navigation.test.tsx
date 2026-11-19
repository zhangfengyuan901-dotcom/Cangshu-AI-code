import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { useIsSidebarModuleVisible } from '../use-sidebar-config'
import { useSidebarView } from '../use-sidebar-view'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: '/dashboard/overview' }),
}))

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

function navigationFor(role: number, hidden = false, canConfigure = false) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  clients.push(client)
  const legacy = hidden ? JSON.stringify({ admin: { enabled: false, channel: false }, console: { enabled: false }, personal: { enabled: false } }) : ''
  client.setQueryData(['status'], { SidebarModulesAdmin: legacy })
  useAuthStore.getState().auth.setUser({
    id: 12, username: 'synthetic-operator', role,
    permissions: { sidebar_settings: canConfigure }, sidebar_modules: legacy,
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return renderHook(() => ({
    view: useSidebarView(),
    upstream: useIsSidebarModuleVisible('/channels'),
    lines: useIsSidebarModuleVisible('/line-management'),
  }), { wrapper: Wrapper }).result
}

test.each([100, 200])('root role %i retains both operator links with legacy disabled configuration', role => {
  const result = navigationFor(role, true)
  const items = result.current.view.navGroups.flatMap(group => group.items)
  expect(items).toContainEqual(expect.objectContaining({ title: '上游管理', url: '/channels' }))
  expect(items).toContainEqual(expect.objectContaining({ title: 'Line management', url: '/line-management' }))
  expect(result.current.upstream).toBe(true)
  expect(result.current.lines).toBe(true)
})

test.each([false, true])('legacy operator user preferences cannot hide upstream links (sidebar editor permission %s)', canConfigure => {
  const result = navigationFor(100, true, canConfigure)
  expect(result.current.view.navGroups.flatMap(group => group.items).map(item => item.url)).toEqual(expect.arrayContaining(['/channels', '/line-management']))
})

test('admin role 10 retains upstream management without gaining line-management permission', () => {
  const result = navigationFor(10, true, true)
  const urls = result.current.view.navGroups.flatMap(group => group.items).map(item => item.url)
  expect(urls).toContain('/channels')
  expect(urls).not.toContain('/line-management')
  expect(result.current.upstream).toBe(true)
  expect(result.current.lines).toBe(false)
})

test.each([0, 1, 9])('role %i never sees either operator link', role => {
  const result = navigationFor(role)
  const urls = result.current.view.navGroups.flatMap(group => group.items).map(item => item.url)
  expect(urls).not.toContain('/channels')
  expect(urls).not.toContain('/line-management')
  expect(result.current.upstream).toBe(false)
  expect(result.current.lines).toBe(false)
})

test('the fix leaves unrelated configured visibility unchanged', () => {
  const result = navigationFor(100, true)
  const urls = result.current.view.navGroups.flatMap(group => group.items).map(item => item.url)
  expect(urls).not.toContain('/users')
  expect(urls).not.toContain('/security')
  expect(urls).not.toContain('/usage-logs/common')
})
