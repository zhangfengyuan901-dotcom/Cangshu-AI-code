import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Wallet } from '../index'

let client: QueryClient
const requests: string[] = []

beforeEach(() => {
  requests.length = 0
  localStorage.clear()
  useAuthStore
    .getState()
    .auth.setUser({ id: 12, username: 'customer', role: 1 })
  client = new QueryClient()
  client.setQueryData(['status'], {
    price: 1,
    quota_display_type: 'CNY',
    usd_exchange_rate: 1,
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    requests.push(url)
    if (url === '/api/user/self') {
      return { data: { success: true, data: { quota: 1000000 } } }
    }
    if (url === '/api/user/topup/info') {
      return {
        data: {
          success: true,
          data: {
            fixed_cny_topup: true,
            enable_online_topup: true,
            enable_redemption: false,
            min_topup: 50,
            amount_options: [50, 100, 200],
            discount: {},
            pay_methods: [
              { type: 'alipay', name: 'Alipay' },
              { type: 'wxpay', name: 'WeChat Pay' },
            ],
          },
        },
      }
    }
    if (url.startsWith('/api/user/topup/self?')) {
      return { data: { success: true, data: { items: [], total: 0 } } }
    }
    throw new Error('Unexpected customer wallet request')
  })
  vi.spyOn(api, 'post').mockImplementation(async (url, data) => {
    if (url !== '/api/user/amount') {
      throw new Error('No real payment may be created in this test')
    }
    const request = data as { amount: number }
    return { data: { success: true, data: String(request.amount) } }
  })
})

afterEach(() => {
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  localStorage.clear()
})

test('customer wallet offers fixed CNY checkout without requesting subscriptions, affiliate or unopened orders', async () => {
  render(
    <QueryClientProvider client={client}>
      <Wallet />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Alipay' })).toBeEnabled()
  )
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Have a Code?')).not.toBeInTheDocument()
  expect(
    screen.queryByText(/Redemption codes are disabled/)
  ).not.toBeInTheDocument()
  expect(requests.sort()).toEqual(['/api/user/self', '/api/user/topup/info'])
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: /¥100\s*CNY balance credit/ }))
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'WeChat Pay' }))
  expect(
    await screen.findByRole('button', { name: 'Confirm Payment' })
  ).toBeEnabled()
})

test('opening order history fetches only this customer’s orders', async () => {
  render(
    <QueryClientProvider client={client}>
      <Wallet />
    </QueryClientProvider>
  )
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'Order History' }))
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  await waitFor(() =>
    expect(
      requests.some((url) => url.startsWith('/api/user/topup/self?'))
    ).toBe(true)
  )
  expect(requests.some((url) => url.startsWith('/api/user/topup?'))).toBe(false)
})
