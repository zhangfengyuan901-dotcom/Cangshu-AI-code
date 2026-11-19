import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { TaskLog } from '@/features/usage-logs/types'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { Settlement } from '../api'
import { getOrderTask } from '../task-records-api'
import { TaskRecordsPage } from '../task-records-page'

let client: QueryClient
let order: Settlement
let task: TaskLog
let resultFails: boolean
let listFails: boolean
let empty: boolean
let duplicate: boolean
const calls: string[] = []

beforeEach(() => {
  resultFails = false
  listFails = false
  empty = false
  duplicate = false
  calls.length = 0
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore
    .getState()
    .auth.setUser({ id: 12, role: 1, username: 'customer' })
  order = {
    order_id: 'public-task-1',
    model: 'pikno-video-example',
    created_at: 100,
    generation_state: 'succeeded',
    financial_state: 'settled',
    reserved_quota: 0,
    net_quota: 5500000,
    refunded_quota: 0,
    version: 2,
    review_required: false,
  }
  task = {
    id: 1,
    user_id: 12,
    task_id: order.order_id,
    platform: 'pikno-sanbao',
    action: 'GENERATE',
    channel_id: 0,
    group: 'video',
    quota: 5500000,
    submit_time: 100,
    status: 'SUCCESS',
  }
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    calls.push(url)
    if (url === '/api/pikno/settlements/self') {
      if (listFails) throw new Error('List unavailable')
      const page = config?.params.page ?? 1
      return {
        data: {
          success: true,
          data: {
            items: empty
              ? []
              : [
                  {
                    ...order,
                    order_id: page === 1 ? order.order_id : 'second-page',
                  },
                ],
            total: empty ? 0 : 21,
          },
        },
      }
    }
    if (url.startsWith('/api/pikno/settlements/self/')) {
      return {
        data: {
          success: true,
          data: {
            order: {
              ...order,
              account_ref: 'private-account',
              upstream_task_id: 'private-upstream-id',
            },
            events: [
              {
                id: 1,
                action: 'reserve',
                wallet_delta: -5500000,
                net_quota: 0,
                reserved_quota: 5500000,
                financial_state: 'reserved',
                created_at: 100,
                reason: 'private-review-reason',
                evidence: 'private-receipt',
              },
              {
                id: 2,
                action: 'success',
                wallet_delta: 0,
                net_quota: 5500000,
                reserved_quota: 0,
                financial_state: 'settled',
                created_at: 101,
              },
            ],
          },
        },
      }
    }
    if (url === '/api/task/self') {
      if (resultFails) throw new Error('Task unavailable')
      return {
        data: {
          success: true,
          data: {
            items: duplicate ? [task, task] : [task],
            total: duplicate ? 2 : 1,
          },
        },
      }
    }
    if (url === '/api/task/public-task-1/artifacts') {
      return {
        data: { success: true, data: { task_id: task.task_id, artifacts: [] } },
      }
    }
    throw new Error('Unexpected request')
  })
  vi.spyOn(api, 'post')
})

afterEach(() => {
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

async function showRecords() {
  const router = createRouter({
    routeTree: createRootRoute({ component: TaskRecordsPage }),
    history: createMemoryHistory(),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

test('opening a successful order shows its own result and financial timeline without private evidence or writes', async () => {
  await showRecords()
  const user = userEvent.setup()
  const button = await screen.findByRole('button', { name: order.order_id })
  expect(calls).toEqual(['/api/pikno/settlements/self'])
  expect(
    screen.getByRole('button', { name: 'Historical billing logs' })
  ).toHaveAttribute('href', '/usage-logs/common')
  await user.click(button)
  await screen.findByRole('button', { name: 'Artifacts' })
  expect(api.get).toHaveBeenCalledWith('/api/task/self', {
    params: { task_id: order.order_id, p: 1, page_size: 2 },
  })
  const timeline = screen.getByRole('region', { name: 'Financial timeline' })
  expect(within(timeline).getByText('Reserve funds')).toBeInTheDocument()
  expect(
    within(timeline).getByText('Confirm successful settlement')
  ).toBeInTheDocument()
  expect(within(timeline).getByText('¥-5.5')).toBeInTheDocument()
  for (const text of [
    'private-account',
    'private-upstream-id',
    'private-review-reason',
    'private-receipt',
    'Review action',
  ]) {
    expect(screen.queryByText(text)).not.toBeInTheDocument()
  }
  expect(calls).not.toContain('/api/task/public-task-1/artifacts')
  await user.click(screen.getByRole('button', { name: 'Artifacts' }))
  await screen.findByRole('dialog', { name: 'Artifacts' })
  await waitFor(() =>
    expect(calls).toContain('/api/task/public-task-1/artifacts')
  )
  expect(api.post).not.toHaveBeenCalled()
})

test('a failed result lookup keeps the financial timeline and can retry independently', async () => {
  resultFails = true
  await showRecords()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: order.order_id }))
  await screen.findByText('Unable to load generation result')
  expect(
    screen.getByRole('region', { name: 'Financial timeline' })
  ).toBeInTheDocument()
  resultFails = false
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Artifacts' })
  expect(api.post).not.toHaveBeenCalled()
})

test.each(['failed', 'unknown'])(
  'a %s generation keeps recorded funds and does not offer a successful result',
  async (state) => {
    order = {
      ...order,
      generation_state: state,
      financial_state: state === 'failed' ? 'refunded' : 'pending_review',
      reserved_quota: state === 'failed' ? 0 : 5500000,
      net_quota: 0,
      refunded_quota: state === 'failed' ? 5500000 : 0,
    }
    await showRecords()
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: order.order_id }))
    await screen.findByText(
      'No confirmed successful result is available. Funds follow the financial status shown above.'
    )
    expect(
      screen.queryByRole('button', { name: 'Artifacts' })
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByText(
        state === 'failed' ? 'Refunded' : 'Pending financial review'
      )
    ).toHaveLength(2)
    expect(api.post).not.toHaveBeenCalled()
  }
)

test('synchronous image orders explain that the original response was not retained and skip task lookup', async () => {
  order = {
    ...order,
    order_id: 'req_image-1',
    model: 'pikno-image-flare',
    net_quota: 100000,
  }
  await showRecords()
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: order.order_id }))
  await screen.findByText(
    'No retained result is linked to this order. Synchronous image results are returned to PIKNO; historical records are not matched by guesswork.'
  )
  expect(calls).not.toContain('/api/task/self')
  expect(screen.getAllByText('¥0.1')).toHaveLength(2)
})

test('duplicate, mismatched and missing task identifiers never produce an inferred result', async () => {
  duplicate = true
  expect(await getOrderTask(order.order_id)).toBeNull()
  duplicate = false
  task = { ...task, task_id: 'different-task' }
  expect(await getOrderTask(order.order_id)).toBeNull()
  vi.mocked(api.get).mockResolvedValueOnce({
    data: { success: true, data: { items: [], total: 0 } },
  })
  expect(await getOrderTask(order.order_id)).toBeNull()
})

test('a server-declared task query failure is not treated as an empty successful result', async () => {
  vi.mocked(api.get).mockResolvedValueOnce({
    data: { success: false, message: 'Task lookup failed' },
  })
  await expect(getOrderTask(order.order_id)).rejects.toThrow(
    'Task lookup failed'
  )
})

test('a successful task whose result was discarded shows the existing explanation instead of a preview', async () => {
  task = { ...task, result_discarded: true }
  await showRecords()
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: order.order_id }))
  await screen.findByText('Result not retained')
  expect(
    screen.queryByRole('button', { name: 'Artifacts' })
  ).not.toBeInTheDocument()
  expect(calls).not.toContain('/api/task/public-task-1/artifacts')
})

test('a long order ID stays actionable and changing pages clears its selected detail', async () => {
  order = {
    ...order,
    order_id:
      'public-task-with-a-long-but-valid-identifier-for-the-mobile-records-list',
  }
  task = { ...task, task_id: order.order_id }
  await showRecords()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: order.order_id }))
  await screen.findByText('Task details')
  await user.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() =>
    expect(screen.queryByText('Task details')).not.toBeInTheDocument()
  )
  await user.click(screen.getByRole('button', { name: 'Go to next page' }))
  await screen.findByRole('button', { name: 'second-page' })
  expect(screen.queryByText('Task details')).not.toBeInTheDocument()
  expect(api.get).toHaveBeenCalledWith('/api/pikno/settlements/self', {
    params: { page: 2, review: false },
  })
})

test('refresh updates the selected order and result without submitting a settlement', async () => {
  task = { ...task, status: 'IN_PROGRESS' }
  await showRecords()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: order.order_id }))
  await screen.findByText(
    'The task result is not ready. Refresh to check again; this does not change charges.'
  )
  task = { ...task, status: 'SUCCESS' }
  order = {
    ...order,
    financial_state: 'partially_refunded',
    net_quota: 2750000,
    refunded_quota: 2750000,
  }
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('button', { name: 'Artifacts' })
  expect(screen.getAllByText('Partially refunded')).toHaveLength(2)
  expect(screen.getAllByText('¥2.75')).toHaveLength(4)
  expect(api.post).not.toHaveBeenCalled()
})

test('switching accounts clears selected details and does not reuse another account list cache', async () => {
  await showRecords()
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: order.order_id }))
  await screen.findByText('Task details')
  empty = true
  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 13, role: 1, username: 'other-customer' })
  )
  await screen.findByText('No settlement orders')
  expect(screen.queryByText('Task details')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: order.order_id })
  ).not.toBeInTheDocument()
})

test('empty records and a list error use existing empty and retry states', async () => {
  listFails = true
  await showRecords()
  await screen.findByRole('button', { name: 'Retry' })
  listFails = false
  empty = true
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No settlement orders')
  expect(calls).not.toContain('/api/task/self')
})
