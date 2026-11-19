import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { useSidebarData } from '../use-sidebar-data'
import { useTopNavLinks } from '../use-top-nav-links'

let client: QueryClient

function Navigation() {
  const sidebar = useSidebarData()
  const header = useTopNavLinks()
  return (
    <>
      <nav aria-label='Sidebar'>
        {sidebar.navGroups
          .flatMap((group) => group.items)
          .map(
            (item) =>
              item.url && (
                <a key={item.url} href={item.url}>
                  {item.title}
                </a>
              )
          )}
      </nav>
      <nav aria-label='Header'>
        {header.map((item) => (
          <a key={item.href} href={item.href}>
            {item.title}
          </a>
        ))}
      </nav>
    </>
  )
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  client.setQueryData(['status'], {
    HeaderNavModules: JSON.stringify({
      home: true,
      console: true,
      pricing: { enabled: true },
      rankings: { enabled: true },
      docs: true,
    }),
  })
  useAuthStore
    .getState()
    .auth.setUser({ id: 12, username: 'customer', role: 1 })
})

afterEach(() => {
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

test('a customer can find core features but not admin, charts, chat or rankings', () => {
  render(
    <QueryClientProvider client={client}>
      <Navigation />
    </QueryClientProvider>
  )
  for (const name of [
    '余额',
    '消费记录',
    '充值',
    'API Key',
  ]) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument()
  }
  expect(screen.queryByRole('link', { name: 'Available models' })).not.toBeInTheDocument()
  for (const name of [
    'Channels',
    '上游管理',
    'Users',
    'Dashboard',
    'Audit Logs',
    'Playground',
    'Chat',
    'Rankings',
    'Home',
    'Usage Logs',
    'Task Logs',
    'Settlements',
  ]) {
    expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
  }
  expect(screen.getByRole('link', { name: '消费记录' })).toHaveAttribute(
    'href',
    '/account-lite/index.html?tab=usage'
  )
})

test('switching to super-admin shows the simplified PIKNO management surface', () => {
  render(
    <QueryClientProvider client={client}>
      <Navigation />
    </QueryClientProvider>
  )
  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 1, username: 'piknoadmin', role: 100 })
  )
  for (const name of [
    'Line management',
    'Users',
    'Settlement review',
    'Audit Logs',
  ]) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument()
  }
  for (const name of [
    'Channels',
    'Models',
    'Catalog management',
    'Task Plugins',
    'System Settings',
    'Subscriptions',
    'Dashboard',
  ]) {
    expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
  }
  expect(
    screen.queryByRole('link', { name: 'Playground' })
  ).not.toBeInTheDocument()
})

test.each([ROLE.ADMIN, ROLE.SUPER_ADMIN])(
  'role %i can find upstream connections and loses the entry when switched to a customer',
  (role) => {
    useAuthStore
      .getState()
      .auth.setUser({ id: 1, username: 'piknoadmin', role })
    render(
      <QueryClientProvider client={client}>
        <Navigation />
      </QueryClientProvider>
    )

    expect(
      screen.getByRole('link', { name: '上游管理' })
    ).toHaveAttribute('href', '/channels')

    act(() =>
      useAuthStore
        .getState()
        .auth.setUser({ id: 12, username: 'customer', role: ROLE.USER })
    )
    expect(
      screen.queryByRole('link', { name: '上游管理' })
    ).not.toBeInTheDocument()
  }
)

test('disabled model catalog stays absent in both customer navigation areas', () => {
  client.setQueryData(['status'], {
    HeaderNavModules: JSON.stringify({ pricing: { enabled: false } }),
  })
  render(
    <QueryClientProvider client={client}>
      <Navigation />
    </QueryClientProvider>
  )
  expect(
    screen.queryByRole('link', { name: 'Available models' })
  ).not.toBeInTheDocument()
})
