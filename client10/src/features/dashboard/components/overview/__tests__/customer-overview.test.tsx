import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import {
  useSystemConfigStore,
  DEFAULT_CURRENCY_CONFIG,
} from '@/stores/system-config-store'

import { CustomerOverview } from '../customer-overview'

let client: QueryClient
let fail: boolean
let quota: number
const requests: string[] = []

beforeEach(() => {
  fail = false
  quota = 25000000
  requests.length = 0
  localStorage.clear()
  useAuthStore
    .getState()
    .auth.setUser({ id: 12, username: 'customer', role: 1 })
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CNY',
      usdExchangeRate: 1,
    },
  })
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  client.setQueryData(['status'], {
    announcements: [],
    announcements_enabled: true,
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    requests.push(url)
    if (url !== '/api/user/self') {
      throw new Error('Unexpected customer overview request')
    }
    if (fail) {
      return { data: { success: false, message: 'Temporarily unavailable' } }
    }
    return {
      data: {
        success: true,
        data: {
          id: 12,
          username: 'customer',
          quota,
          used_quota: 1000000,
          request_count: 20,
        },
      },
    }
  })
})

afterEach(() => {
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  localStorage.clear()
})

async function showOverview() {
  const router = createRouter({
    routeTree: createRootRoute({ component: CustomerOverview }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

test('shows CNY balances and core actions without fetching analytics, tokens or models', async () => {
  await showOverview()
  expect(await screen.findByText('¥50')).toBeInTheDocument()
  expect(screen.getByText('¥2')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add Funds' })).toHaveAttribute(
    'href',
    '/wallet'
  )
  expect(screen.getByRole('button', { name: 'Docs' })).toHaveAttribute(
    'href',
    '/developer'
  )
  expect(
    screen.queryByText('No announcements at this time')
  ).not.toBeInTheDocument()
  expect(requests).toEqual(['/api/user/self'])
})

test('failed balance lookup shows a retry state instead of a false zero and recovers on retry', async () => {
  fail = true
  await showOverview()
  expect(
    await screen.findByText('Unable to load account balance')
  ).toBeInTheDocument()
  expect(screen.queryByText('Current Balance')).not.toBeInTheDocument()
  fail = false
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('¥50')).toBeInTheDocument()
})

test('refresh updates the balance after a payment and handles zero normally', async () => {
  quota = 0
  await showOverview()
  await screen.findByText('¥0')
  quota = 50000000
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.getByText('¥100')).toBeInTheDocument())
})
