import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useTopNavLinks } from '@/hooks/use-top-nav-links'
import { useAuthStore } from '@/stores/auth-store'

function Navigation() { return <nav>{useTopNavLinks().map(item => <a key={item.href} href={item.href}>{item.title}</a>)}</nav> }
afterEach(() => { cleanup(); useAuthStore.getState().auth.reset() })
test('fixed public navigation does not restore retired links or external destinations from old configuration', () => {
  const client = new QueryClient()
  client.setQueryData(['status'], { HeaderNavModules: JSON.stringify({ pricing: { enabled: true }, rankings: { enabled: true }, docs: true }), docs_link: 'https://external.test/' })
  const view = render(<QueryClientProvider client={client}><Navigation /></QueryClientProvider>)
  for (let index = 0; index < 20; index++) view.rerender(<QueryClientProvider client={client}><Navigation /></QueryClientProvider>)
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: '账户中心' })).toHaveAttribute('href', '/account-lite/index.html')
  act(() => useAuthStore.getState().auth.setUser({ id: 1, username: 'synthetic-admin', role: 100 }))
  expect(screen.getByRole('link', { name: '管理后台' })).toHaveAttribute('href', '/dashboard/overview')
  client.clear()
})
