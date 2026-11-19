import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createAppQueryClient } from '@/lib/query-client'

import { getCatalog } from '../api'
import { CatalogDirectory, CatalogList } from '../directory'
import type { CatalogModel, CatalogSnapshot } from '../types'

vi.mock('../api', () => ({ getCatalog: vi.fn() }))
vi.mock('@/components/layout/components/public-layout', () => ({
  PublicLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const model: CatalogModel = {
  id: 'example-video', name: 'Example video', kind: 'video',
  resolutions: ['720p'], ratios: ['16:9'], durations: [5],
  max_images: 1, max_videos: 0, max_audio: 0,
}
const snapshot: CatalogSnapshot = {
  revision: 'first', fetched_at: '2026-10-22T00:00:00Z', models: [model],
}
const navigateToError = vi.fn()
let client: ReturnType<typeof createAppQueryClient>

beforeEach(() => {
  vi.stubGlobal('EventSource', undefined)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  navigateToError.mockReset()
  client = createAppQueryClient(navigateToError)
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(content: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => content }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

it.each([429, 500, 503])('keeps a %s catalog failure inside the page without global error navigation', async (status) => {
  vi.mocked(getCatalog).mockRejectedValueOnce({ response: { status } })
  mount(<CatalogDirectory />)
  expect(await screen.findByText('Unable to load model catalog')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Available models' })).toBeVisible()
  expect(navigateToError).not.toHaveBeenCalled()
  expect(getCatalog).toHaveBeenCalledOnce()
})

it('retains old data as unverified after timeout and replaces it after a bounded retry', async () => {
  client.setQueryData(['pikno-catalog'], snapshot)
  vi.mocked(getCatalog)
    .mockRejectedValueOnce({ code: 'ECONNABORTED' })
    .mockResolvedValueOnce({ ...snapshot, revision: 'second', models: [] })
  mount(<CatalogDirectory />)
  await waitFor(() => expect(client.getQueryState(['pikno-catalog'])?.status).toBe('error'))
  expect(screen.getByText(model.name)).toBeVisible()
  expect(screen.getByText('待更新')).toBeVisible()
  expect(screen.queryByText('Available', { exact: true })).not.toBeInTheDocument()
  expect(screen.getByText('目录待更新，当前内容仅供参考。')).toBeVisible()
  expect(navigateToError).not.toHaveBeenCalled()
  const errorAt = client.getQueryState(['pikno-catalog'])?.errorUpdatedAt ?? Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(errorAt + 11_000)
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('No catalog models found')).toBeVisible()
  expect(screen.queryByText(model.name)).not.toBeInTheDocument()
  expect(screen.queryByText('目录待更新，当前内容仅供参考。')).not.toBeInTheDocument()
  expect(getCatalog).toHaveBeenCalledTimes(2)
})

it('marks a previously loaded directory unverified while the browser is offline', async () => {
  vi.mocked(getCatalog).mockResolvedValueOnce(snapshot)
  mount(<CatalogDirectory />)
  expect(await screen.findByText('Available', { exact: true })).toBeVisible()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  await act(async () => { window.dispatchEvent(new Event('offline')) })
  expect(screen.getByText(model.name)).toBeVisible()
  expect(screen.getByText('待更新')).toBeVisible()
  expect(screen.queryByText('Available', { exact: true })).not.toBeInTheDocument()
})

it('removes open details when a refreshed directory removes that model', async () => {
  let replaceModels: ((models: CatalogModel[]) => void) | undefined
  function Harness() {
    const [models, setModels] = useState([model])
    replaceModels = setModels
    return <CatalogList models={models} />
  }
  mount(<Harness />)
  await userEvent.click(await screen.findByRole('button', { name: 'Parameters & access' }))
  expect(screen.getByRole('dialog')).toBeVisible()
  await act(async () => replaceModels?.([]))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText(model.name)).not.toBeInTheDocument()
  await act(async () => replaceModels?.([model]))
  expect(screen.getByText(model.name)).toBeVisible()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
