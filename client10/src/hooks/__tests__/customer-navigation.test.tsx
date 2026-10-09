import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'

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
    'Overview',
    'API Keys',
    'Usage Logs',
    'Task Logs',
    'Wallet',
    'Profile',
    'Security & Access',
  ]) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument()
  }
  expect(
    screen.getAllByRole('link', { name: 'Models & Pricing' })
  ).toHaveLength(2)
  for (const name of [
    'Channels',
    'Users',
    'Dashboard',
    'Audit Logs',
    'Playground',
    'Chat',
    'Rankings',
    'Home',
  ]) {
    expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
  }
})

test('switching to super-admin restores management while chat remains hidden', () => {
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
  for (const name of ['Channels', 'Users', 'System Settings', 'Dashboard']) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument()
  }
  expect(
    screen.queryByRole('link', { name: 'Playground' })
  ).not.toBeInTheDocument()
})

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
    screen.queryByRole('link', { name: 'Models & Pricing' })
  ).not.toBeInTheDocument()
})
