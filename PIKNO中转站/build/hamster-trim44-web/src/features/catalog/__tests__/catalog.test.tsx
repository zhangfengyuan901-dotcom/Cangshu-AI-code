import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { CatalogAdmin } from '../admin'
import { getCatalog } from '../api'
import { CatalogList } from '../directory'
import { CatalogModelCard } from '../model-card'
import type { CatalogAdminResponse, CatalogModel } from '../types'

const model: CatalogModel = {
  id: 'sanbao/example',
  name: 'Example video',
  provider: 'sanbao',
  kind: 'video',
  upstream_available: true,
  resolutions: ['480p'],
  ratios: ['16:9'],
  durations: [4, 8],
  max_images: 5,
  max_videos: 1,
  max_audio: 0,
  prices: [
    { resolution: '480p', unit: 'second', retail_cny: 1.44, cost_cny: 0.72 },
  ],
  price_issue: false,
  reference_surcharge_cny: 0,
}
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  localStorage.clear()
})
function mount(content: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => content }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
function draftResponse(): CatalogAdminResponse {
  return {
    success: true,
    data: {
      revision: 'reviewed-state',
      published: null,
      previous: null,
      draft: {
        revision: 'draft',
        fetched_at: '2026-10-08T00:00:00Z',
        models: [model],
      },
      events: [],
    },
    changes: [{ id: model.id, kind: 'added', after: model }],
  }
}

it('shows a published customer model without provider or price data', () => {
  render(<CatalogModelCard model={model} onDetails={vi.fn()} />)
  expect(screen.getByText('Available')).toBeVisible()
  expect(screen.queryByText('¥1.44 / second')).not.toBeInTheDocument()
  expect(screen.queryByText(/^sanbao ·/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Upstream cost/)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /enable|activate|generate/i })
  ).not.toBeInTheDocument()
})
it('shows cost only in admin preview and marks unclear quotes', () => {
  render(
    <CatalogModelCard
      model={{ ...model, price_issue: true }}
      onDetails={vi.fn()}
      admin
    />
  )
  expect(screen.getByText('Pricing needs review')).toBeVisible()
  expect(screen.getByText(/Upstream cost \(CNY\): ¥0.72/)).toBeVisible()
})
it('marks removed upstream entries unavailable rather than hiding them', () => {
  render(
    <CatalogModelCard
      model={{ ...model, upstream_available: false }}
      onDetails={vi.fn()}
      admin
    />
  )
  expect(screen.getByText('Upstream unavailable')).toBeVisible()
  expect(screen.getByText(model.name)).toBeVisible()
})
it('paginates a long catalog and resets the page when searching', async () => {
  const user = userEvent.setup()
  mount(
    <CatalogList
      models={Array.from({ length: 13 }, (_, index) => ({
        ...model,
        id: `sanbao/${index}`,
        name: `Video ${index}`,
      }))}
    />
  )
  await screen.findByText('Video 0')
  expect(screen.queryByText('Video 12')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getByText('Video 12')).toBeVisible()
  await user.type(
    screen.getByRole('textbox', { name: 'Search models' }),
    'Video 0'
  )
  expect(screen.getByText('Video 0')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Next page' })
  ).not.toBeInTheDocument()
})
it('keeps provider filtering in the hidden diagnostic admin preview only', async () => {
  const user = userEvent.setup()
  mount(<CatalogList models={[model]} admin />)
  await screen.findByText(model.name)
  await user.click(screen.getByRole('button', { name: 'packy' }))
  expect(screen.getByText('No catalog models found')).toBeVisible()
})
it('opens parameter details with R2 guidance and closes with the accessible close control', async () => {
  const user = userEvent.setup()
  mount(<CatalogList models={[model]} />)
  await user.click(
    await screen.findByRole('button', { name: 'Parameters & access' })
  )
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(screen.getByText(/Published parameters supported/)).toBeVisible()
  expect(
    screen.getByText(/Upload reference media directly to R2/)
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})
it('rejects a failed catalog response rather than displaying it as successful data', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: false, message: 'Catalog unavailable' },
  })
  await expect(getCatalog()).rejects.toThrow('Catalog unavailable')
})
it('requires confirmation and submits the exact reviewed revision without channel or billing writes', async () => {
  const response = draftResponse()
  vi.spyOn(api, 'get').mockResolvedValue({ data: response })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      ...response,
      data: {
        ...response.data,
        revision: 'published-state',
        draft: null,
        published: response.data.draft,
      },
      changes: [],
    },
  })
  const user = userEvent.setup()
  mount(<CatalogAdmin />)
  const publish = await screen.findByRole('button', { name: 'Publish draft' })
  await waitFor(() => expect(publish).toBeEnabled())
  expect(
    screen.getByRole('button', { name: 'Rollback catalog' })
  ).toBeDisabled()
  await user.click(publish)
  expect(post).not.toHaveBeenCalled()
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'does not enable models'
  )
  await user.click(
    screen.getByRole('button', { name: 'Confirm catalog change' })
  )
  await waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/api/pikno/catalog/admin/publish',
      { revision: 'reviewed-state' },
      { timeout: 50000 }
    )
  )
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
  expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled()
})
it('shows changed prices and parameter limits before publication', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: draftResponse() })
  const user = userEvent.setup()
  mount(<CatalogAdmin />)
  const review = await screen.findByRole('button', { name: /Review changes/ })
  expect(review).toHaveAttribute('aria-expanded', 'false')
  await user.click(review)
  expect(review).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Added')).toBeVisible()
  expect(
    screen.getByText(/Reference limits: image \/ video \/ audio/)
  ).toBeVisible()
})
