import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { ModelCardGrid } from '../components/model-card-grid'
import { ModelDetailsContent } from '../components/model-details'
import {
  PricingToolbar,
  type PricingToolbarProps,
} from '../components/pricing-toolbar'
import type { PricingModel } from '../types'

const model: PricingModel = {
  id: 1,
  model_name: 'gpt-image-2.5-flare',
  quota_type: 1,
  model_ratio: 1,
  completion_ratio: 1,
  model_price: 0.1 / 7.3,
  enable_groups: ['default'],
  group_ratio: { default: 1 },
}
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CNY',
      usdExchangeRate: 7.3,
    },
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  localStorage.clear()
})

it('keeps the CNY price and details action but makes no performance request for customer cards', async () => {
  const get = vi.spyOn(api, 'get')
  const clicked = vi.fn()
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={client}>
      <ModelCardGrid
        compact
        models={[model]}
        onModelClick={clicked}
        usdExchangeRate={7.3}
      />
    </QueryClientProvider>
  )
  expect(screen.getByText('¥0.1')).toBeVisible()
  expect(
    screen.queryByLabelText('Performance metrics for the last 24 hours')
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Pricing & API access' }))
  expect(clicked).toHaveBeenCalledWith(model.model_name)
  expect(get).not.toHaveBeenCalled()
})

it('keeps administrator performance requests and metrics available', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue({ data: { success: true, data: { models: [] } } })
  render(
    <QueryClientProvider client={client}>
      <ModelCardGrid models={[model]} onModelClick={vi.fn()} />
    </QueryClientProvider>
  )
  await waitFor(() => expect(get).toHaveBeenCalled())
  expect(
    screen.getByLabelText('Performance metrics for the last 24 hours')
  ).toBeVisible()
})

it('shows pricing and the verified R2 guide in customer details without requesting metrics', async () => {
  const get = vi.spyOn(api, 'get')
  const user = userEvent.setup()
  const root = createRootRoute({
    component: () => (
      <ModelDetailsContent
        compact
        model={model}
        groupRatio={{ default: 1 }}
        usableGroup={{ default: { desc: 'Default', ratio: 1 } }}
        endpointMap={{}}
        autoGroups={[]}
        priceRate={7.3}
        usdExchangeRate={7.3}
        tokenUnit='M'
        showRechargePrice
      />
    ),
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByRole('tab', { name: 'Overview' })
  expect(screen.getAllByText('¥0.1').length).toBeGreaterThan(0)
  expect(
    screen.queryByRole('tab', { name: 'Performance' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: 'API' }))
  expect(
    screen.getByText(/Upload reference media directly to R2/)
  ).toBeVisible()
  expect(
    screen.getByRole('link', { name: 'API documentation' })
  ).toHaveAttribute('href', '/developer')
  await user.click(screen.getByRole('button', { name: 'Copy API Base URL' }))
  expect(await navigator.clipboard.readText()).toBe(
    'https://www.piknoai.com/v1'
  )
  expect(get).not.toHaveBeenCalled()
})

it('hides recharge and token switches for image-only catalogs but keeps filters accessible', async () => {
  const noop = vi.fn()
  const props: PricingToolbarProps = {
    compact: true,
    models: [model],
    filteredCount: 1,
    sortBy: 'name',
    onSortChange: noop,
    tokenUnit: 'M',
    onTokenUnitChange: noop,
    showRechargePrice: false,
    onRechargePriceChange: noop,
    viewMode: 'card',
    onViewModeChange: noop,
    quotaTypeFilter: 'all',
    endpointTypeFilter: 'all',
    vendorFilter: 'all',
    groupFilter: 'all',
    tagFilter: 'all',
    onQuotaTypeChange: noop,
    onEndpointTypeChange: noop,
    onVendorChange: noop,
    onGroupChange: noop,
    onTagChange: noop,
    vendors: [],
    groups: ['default'],
    tags: [],
    hasActiveFilters: false,
    activeFilterCount: 0,
    onClearFilters: noop,
  }
  render(<PricingToolbar {...props} />)
  expect(screen.queryByLabelText('Price display mode')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Token unit')).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Filter' }))
  expect(await screen.findByRole('dialog')).toBeVisible()
  expect(screen.getByRole('button', { name: /default/ })).toBeVisible()
})
