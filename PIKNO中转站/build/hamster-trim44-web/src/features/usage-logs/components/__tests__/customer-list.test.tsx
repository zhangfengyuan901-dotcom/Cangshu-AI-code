import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { usageLogSchema } from '../../data/schema'
import { UsageLogsProvider } from '../usage-logs-provider'
import { UsageLogsTable } from '../usage-logs-table'

const clients: QueryClient[] = []
async function renderLogs(role: number, initialEntry = '/usage-logs/common') {
  useAuthStore
    .getState()
    .auth.setUser({ id: 12, username: 'qa_customer', role })
  const requests: string[] = []
  const record = usageLogSchema.parse({
    id: 1,
    user_id: 12,
    created_at: 1788840000,
    type: 2,
    content: '',
    model_name: 'gpt-image-2.5-flare',
    token_name: 'qa-key',
    quota: 5000,
    other: '{}',
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    requests.push(url)
    let data: unknown = { quota: 0, rpm: 0, tpm: 0 }
    if (url.startsWith('/api/log?') || url.startsWith('/api/log/self?')) {
      data = { items: [record], total: 1 }
    } else if (url === '/api/subscription/self') {
      data = { subscriptions: [] }
    } else if (
      url === '/api/subscription/admin/plans' ||
      url === '/api/group/'
    ) {
      data = []
    } else if (url === '/api/user/self/groups') {
      data = {}
    }
    return { data: { success: true, data } }
  })
  const root = createRootRoute()
  const auth = createRoute({ getParentRoute: () => root, id: '_authenticated' })
  const logs = createRoute({
    getParentRoute: () => auth,
    path: '/usage-logs/$section',
    component: () => (
      <UsageLogsProvider>
        <UsageLogsTable logCategory='common' />
      </UsageLogsProvider>
    ),
    validateSearch: (search: Record<string, unknown>) => search,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([logs])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findAllByText('gpt-image-2.5-flare')
  await waitFor(() => expect(client.isFetching()).toBe(0))
  return requests
}
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  localStorage.clear()
})

it('requests 20 rows for customers and keeps time, model, key, cost and details visible', async () => {
  const requests = await renderLogs(ROLE.USER)
  const request = requests.find((url) => url.startsWith('/api/log/self?')) ?? ''
  expect(
    new URL(request, 'https://qa.invalid').searchParams.get('page_size')
  ).toBe('20')
  for (const name of ['Time', 'Model', 'Token', 'Cost', 'Details']) {
    expect(screen.getByRole('columnheader', { name })).toBeVisible()
  }
  for (const name of ['Stream', 'Tokens', 'Timing']) {
    expect(screen.queryByRole('columnheader', { name })).not.toBeInTheDocument()
  }
  expect(screen.queryByText('RPM')).not.toBeInTheDocument()
  expect(screen.queryByText('TPM')).not.toBeInTheDocument()
})

it('keeps the administrator 100-row default and detailed columns', async () => {
  const requests = await renderLogs(ROLE.ADMIN)
  const request = requests.find((url) => url.startsWith('/api/log?')) ?? ''
  expect(
    new URL(request, 'https://qa.invalid').searchParams.get('page_size')
  ).toBe('100')
  expect(screen.getByRole('columnheader', { name: 'Timing' })).toBeVisible()
  expect(screen.getByText('RPM')).toBeVisible()
})

it('honors a customer page-size choice in the URL', async () => {
  const requests = await renderLogs(ROLE.USER, '/usage-logs/common?pageSize=50')
  const request = requests.find((url) => url.startsWith('/api/log/self?')) ?? ''
  expect(
    new URL(request, 'https://qa.invalid').searchParams.get('page_size')
  ).toBe('50')
})

it('allows customers to restore the hidden timing column', async () => {
  await renderLogs(ROLE.USER)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /View/ }))
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'Timing' }))
  expect(screen.getByRole('columnheader', { name: 'Timing' })).toBeVisible()
})
