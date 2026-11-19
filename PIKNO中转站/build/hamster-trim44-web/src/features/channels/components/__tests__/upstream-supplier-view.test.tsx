/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { Channel } from '../../types'
import { ChannelsProvider } from '../channels-provider'
import { ChannelsTable } from '../channels-table'
import { UpstreamSupplierView } from '../upstream-supplier-view'

const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} }, zh: { translation: zh.translation } },
  initAsync: false,
})
const clients: QueryClient[] = []
const originalAuth = useAuthStore.getState().auth

const taggedConnection: Channel = {
  id: 1,
  type: 1,
  key: '',
  status: 1,
  name: 'Packy supplier connection',
  tag: 'PackyAPI · 图片生成',
  created_time: 0,
  test_time: 0,
  response_time: 0,
  other: '',
  balance: 0,
  balance_updated_time: 0,
  models: 'pikno-image-flare',
  group: 'image-standard',
  used_quota: 0,
  other_info: '',
  remark: '',
  max_input_tokens: 0,
  channel_info: {
    is_multi_key: false,
    multi_key_size: 0,
    multi_key_polling_index: 0,
    multi_key_mode: 'random',
  },
  settings: '{}',
}
const newConnection: Channel = {
  ...taggedConnection,
  id: 5,
  name: 'New unlabeled connection',
  tag: null,
}
const digitalConnection: Channel = {
  ...taggedConnection,
  id: 105,
  type: 61,
  name: 'Managed digital connection',
  tag: 'RH · 工具工作流',
  group: 'tool-standard',
  models: 'digital,pikno-tool-digital',
  setting: '{"task_plugin_key":"pikno-tools"}',
}
const depthConnection: Channel = {
  ...digitalConnection,
  id: 106,
  name: 'Managed depth connection',
  models: 'depth,pikno-tool-depth',
  status: 2,
}
const legacyConnection: Channel = {
  ...digitalConnection,
  id: 104,
  name: 'Historical mixed connection',
  group: 'video-standard',
  models: 'digital,depth',
}
let metadataFails = false
let emptyTools = false

beforeEach(async () => {
  await i18n.changeLanguage('en')
  digitalConnection.name = 'Managed digital connection'
  localStorage.clear()
  metadataFails = false
  emptyTools = false
  useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: 100 })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/api/channel' || url === '/api/channel/search') {
      const bySupplier = config?.params?.tag_mode === true
      const general = config?.params?.pikno_view === 'general'
      const items = bySupplier
        ? [taggedConnection]
        : [taggedConnection, newConnection]
      if (!general) {
        items.push(digitalConnection, depthConnection, legacyConnection)
      }
      return {
        data: {
          success: true,
          data: {
            items,
            total: items.length,
            type_counts: { 1: bySupplier ? 1 : 2 },
          },
        },
      }
    }
    if (url === '/api/pikno/rh-connections') {
      if (metadataFails) throw new Error('metadata unavailable')
      return {
        data: {
          success: true,
          data: {
            tools: emptyTools
              ? []
              : [
                  {
                    id: 105,
                    kind: 'digital-human',
                    name: digitalConnection.name,
                    status: 1,
                  },
                  {
                    id: 106,
                    kind: 'depth',
                    name: depthConnection.name,
                    status: 2,
                  },
                ],
            legacy: [{ id: 104, name: legacyConnection.name, status: 1 }],
          },
        },
      }
    }
    if (url === '/api/pikno/rh-config') {
      return {
        data: {
          success: true,
          data: {
            configured: true,
            version: 'test',
            enabled: true,
            ready: true,
            updated_at: '',
          },
        },
      }
    }
    return { data: { success: true, data: ['image-standard'] } }
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  useAuthStore.setState({ auth: originalAuth })
})

async function renderConnectionsPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  const root = createRootRoute()
  const auth = createRoute({ getParentRoute: () => root, id: '_authenticated' })
  const channelsRoute = createRoute({
    getParentRoute: () => auth,
    path: 'channels/',
    component: () => (
      <ChannelsProvider>
        <UpstreamSupplierView />
        <div data-testid='general-connections'>
          <ChannelsTable />
        </div>
      </ChannelsProvider>
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([channelsRoute])]),
    history: createMemoryHistory({ initialEntries: ['/channels/'] }),
  })
  await router.load()
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

it('defaults to general connections and restores unlabeled connections after leaving supplier view', async () => {
  await renderConnectionsPage()
  const allConnections = await screen.findByRole('button', {
    name: 'General connections',
  })
  const bySupplier = screen.getByRole('button', { name: 'By supplier' })
  expect(allConnections).toHaveAttribute('aria-pressed', 'true')
  expect(
    (await screen.findAllByText('New unlabeled connection')).length
  ).toBeGreaterThan(0)

  await userEvent.click(bySupplier)
  expect(bySupplier).toHaveAttribute('aria-pressed', 'true')
  expect(localStorage.getItem('enable-tag-mode')).toBe('true')
  await waitFor(() =>
    expect(
      screen.queryByText('New unlabeled connection')
    ).not.toBeInTheDocument()
  )

  await userEvent.click(allConnections)
  expect(allConnections).toHaveAttribute('aria-pressed', 'true')
  expect(localStorage.getItem('enable-tag-mode')).toBe('false')
  expect(
    (await screen.findAllByText('New unlabeled connection')).length
  ).toBeGreaterThan(0)
})

it('keeps the selected supplier view after leaving and reopening the page', async () => {
  const page = await renderConnectionsPage()
  await userEvent.click(
    await screen.findByRole('button', { name: 'By supplier' })
  )
  page.unmount()

  await renderConnectionsPage()
  expect(
    await screen.findByRole('button', { name: 'By supplier' })
  ).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      '/api/channel',
      expect.objectContaining({
        params: expect.objectContaining({ tag_mode: true }),
      })
    )
  )
})

it('allows keyboard selection of supplier view without writing channel configuration', async () => {
  const post = vi.spyOn(api, 'post')
  const put = vi.spyOn(api, 'put')
  const remove = vi.spyOn(api, 'delete')
  await renderConnectionsPage()
  const bySupplier = await screen.findByRole('button', { name: 'By supplier' })
  bySupplier.focus()
  await userEvent.keyboard('{Enter}')

  expect(bySupplier).toHaveAttribute('aria-pressed', 'true')
  expect(post).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

it('keeps managed tools and legacy bridge out of the paginated general list', async () => {
  await renderConnectionsPage()
  await screen.findByText('New unlabeled connection')
  const general = within(screen.getByTestId('general-connections'))
  expect(general.queryByText(digitalConnection.name)).not.toBeInTheDocument()
  expect(general.queryByText(depthConnection.name)).not.toBeInTheDocument()
  expect(general.queryByText(legacyConnection.name)).not.toBeInTheDocument()
  expect(api.get).toHaveBeenCalledWith(
    '/api/channel',
    expect.objectContaining({
      params: expect.objectContaining({ pikno_view: 'general' }),
    })
  )
})

it('shows both RH tool statuses on entry without opening a dialog or loading credentials', async () => {
  const post = vi.spyOn(api, 'post')
  const put = vi.spyOn(api, 'put')
  const remove = vi.spyOn(api, 'delete')
  await renderConnectionsPage()
  const panel = within(await screen.findByRole('region', { name: 'RH 工具线路' }))
  expect(await panel.findByText(digitalConnection.name)).toBeInTheDocument()
  expect(panel.getByText(depthConnection.name)).toBeInTheDocument()
  expect(panel.getByText('Enabled')).toBeInTheDocument()
  expect(panel.getByText('Disabled')).toBeInTheDocument()
  expect(panel.queryByText(legacyConnection.name)).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('三宝 · 视频生成')).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/api/pikno/rh-config')
  expect(post).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

it('retries RH panel failures without hiding general connections or writing configuration', async () => {
  metadataFails = true
  const post = vi.spyOn(api, 'post')
  await renderConnectionsPage()
  const panel = within(await screen.findByRole('region', { name: 'RH 工具线路' }))
  expect(await panel.findByText('RH connection status unavailable')).toBeInTheDocument()
  expect(await screen.findByText('New unlabeled connection')).toBeInTheDocument()
  expect(panel.queryByText('metadata unavailable')).not.toBeInTheDocument()
  expect(panel.queryByText('Enabled')).not.toBeInTheDocument()
  metadataFails = false
  await userEvent.click(panel.getByRole('button', { name: 'Retry' }))
  expect(await panel.findByText(digitalConnection.name)).toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

it('keeps an empty RH panel distinct from a failed or enabled connection', async () => {
  emptyTools = true
  await renderConnectionsPage()
  const panel = within(await screen.findByRole('region', { name: 'RH 工具线路' }))
  expect(await panel.findByText('No managed RH tool connections')).toBeInTheDocument()
  expect(panel.queryByText('Enabled')).not.toBeInTheDocument()
  expect(panel.queryByText('RH connection status unavailable')).not.toBeInTheDocument()
})

it('shows RH status and line navigation for role 200 but preserves the exact root credential rule', async () => {
  useAuthStore.getState().auth.setUser({ id: 3, username: 'higher-root', role: 200 })
  await renderConnectionsPage()
  const panel = within(await screen.findByRole('region', { name: 'RH 工具线路' }))
  expect(await panel.findByText(digitalConnection.name)).toBeInTheDocument()
  await userEvent.click(panel.getByRole('button', { name: 'RH tools and credentials' }))
  const dialog = await screen.findByRole('dialog', { name: 'RH tools and credentials' })
  expect(within(dialog).getByRole('link', { name: 'Manage tool lines' })).toHaveAttribute('href', '/line-management')
  expect(within(dialog).queryByRole('button', { name: 'Manage cloud RH credential' })).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/api/pikno/rh-config')
})

it('does not render or request RH metadata for a customer role', async () => {
  useAuthStore.getState().auth.setUser({ id: 4, username: 'customer', role: 1 })
  await renderConnectionsPage()
  await screen.findByText('New unlabeled connection')
  expect(screen.queryByRole('region', { name: 'RH 工具线路' })).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith('/api/pikno/rh-connections')
  expect(api.get).not.toHaveBeenCalledWith('/api/pikno/rh-config')
})

it('opens one RH detail entry with read-only tool status and collapsed historical connection', async () => {
  const post = vi.spyOn(api, 'post')
  await renderConnectionsPage()
  const entry = await screen.findByRole('button', {
    name: 'RH tools and credentials',
  })
  entry.focus()
  await userEvent.keyboard('{Enter}')
  const dialog = await screen.findByRole('dialog', {
    name: 'RH tools and credentials',
  })
  expect(
    await within(dialog).findByText(digitalConnection.name)
  ).toBeInTheDocument()
  expect(within(dialog).getByText(depthConnection.name)).toBeInTheDocument()
  expect(within(dialog).getByText('Disabled')).toBeInTheDocument()
  expect(within(dialog).queryByLabelText('RH API Key')).not.toBeInTheDocument()
  expect(
    within(dialog).getByRole('link', { name: 'Manage tool lines' })
  ).toHaveAttribute('href', '/line-management')
  const advanced = within(dialog).getByRole('button', {
    name: 'Advanced / historical connection',
  })
  expect(advanced).toHaveAttribute('aria-expanded', 'false')
  expect(
    within(dialog).queryByText(legacyConnection.name)
  ).not.toBeInTheDocument()
  await userEvent.click(advanced)
  expect(advanced).toHaveAttribute('aria-expanded', 'true')
  expect(within(dialog).getByText(legacyConnection.name)).toBeInTheDocument()
  expect(
    within(dialog).queryByRole('button', { name: 'Edit' })
  ).not.toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

it('keeps RH status readable for administrators without exposing the root credential entry', async () => {
  useAuthStore.getState().auth.setUser({ id: 2, username: 'admin', role: 10 })
  await renderConnectionsPage()
  await userEvent.click(
    await screen.findByRole('button', { name: 'RH tools and credentials' })
  )
  const dialog = await screen.findByRole('dialog', {
    name: 'RH tools and credentials',
  })
  expect(
    await within(dialog).findByText(digitalConnection.name)
  ).toBeInTheDocument()
  expect(
    within(dialog).queryByRole('button', { name: 'Manage cloud RH credential' })
  ).not.toBeInTheDocument()
  expect(
    within(dialog).queryByRole('link', { name: 'Manage tool lines' })
  ).not.toBeInTheDocument()
})

it('retries failed read-only metadata without exposing raw errors or hiding the general list', async () => {
  metadataFails = true
  await renderConnectionsPage()
  await userEvent.click(
    await screen.findByRole('button', { name: 'RH tools and credentials' })
  )
  const dialog = await screen.findByRole('dialog', {
    name: 'RH tools and credentials',
  })
  expect(
    await within(dialog).findByText('RH connection status unavailable')
  ).toBeInTheDocument()
  expect(
    within(dialog).queryByText('metadata unavailable')
  ).not.toBeInTheDocument()
  metadataFails = false
  await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
  expect(
    await within(dialog).findByText(digitalConnection.name)
  ).toBeInTheDocument()
})

it('shows an empty state when no managed tool exists and keeps history available', async () => {
  emptyTools = true
  await renderConnectionsPage()
  await userEvent.click(
    await screen.findByRole('button', { name: 'RH tools and credentials' })
  )
  const dialog = await screen.findByRole('dialog', {
    name: 'RH tools and credentials',
  })
  expect(
    await within(dialog).findByText('No managed RH tool connections')
  ).toBeInTheDocument()
  await userEvent.click(
    within(dialog).getByRole('button', {
      name: 'Advanced / historical connection',
    })
  )
  expect(within(dialog).getByText(legacyConnection.name)).toBeInTheDocument()
})

it('uses the general scope for filtered search instead of revealing hidden RH connections', async () => {
  await renderConnectionsPage()
  await userEvent.type(
    screen.getByPlaceholderText('Filter by model...'),
    'custom-model'
  )
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      '/api/channel/search',
      expect.objectContaining({
        params: expect.objectContaining({
          model: 'custom-model',
          pikno_view: 'general',
        }),
      })
    )
  )
  const general = within(screen.getByTestId('general-connections'))
  expect(general.queryByText(digitalConnection.name)).not.toBeInTheDocument()
  expect(general.queryByText(legacyConnection.name)).not.toBeInTheDocument()
})

it('reuses the protected cloud credential dialog and returns to details when dismissed', async () => {
  const post = vi.spyOn(api, 'post')
  await renderConnectionsPage()
  await userEvent.click(
    await screen.findByRole('button', { name: 'RH tools and credentials' })
  )
  const details = await screen.findByRole('dialog', {
    name: 'RH tools and credentials',
  })
  await userEvent.click(
    within(details).getByRole('button', { name: 'Manage cloud RH credential' })
  )
  const credential = await screen.findByRole('dialog', {
    name: 'RH dedicated configuration',
  })
  expect(within(credential).getByLabelText('RH API Key')).toHaveValue('')
  expect(
    within(credential).getByRole('button', { name: 'Verify and save to cloud' })
  ).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  expect(
    await screen.findByRole('dialog', { name: 'RH tools and credentials' })
  ).toBeInTheDocument()
  expect(screen.queryByLabelText('RH API Key')).not.toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})

it('updates RH entry and customer group guidance when switching to Chinese', async () => {
  await i18n.changeLanguage('zh')
  await renderConnectionsPage()
  expect(
    await screen.findByRole('button', { name: 'RH 工具与凭据' })
  ).toBeInTheDocument()
  expect(screen.getByText('CanSeeDream · 视频生成')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'RH 工具与凭据' }))
  const dialog = await screen.findByRole('dialog', { name: 'RH 工具与凭据' })
  expect(await within(dialog).findByText('黑白深度视频')).toBeInTheDocument()
  expect(
    within(dialog).getByRole('button', { name: '高级／历史连接' })
  ).toHaveAttribute('aria-expanded', 'false')
})

it('uses wrapping and responsive columns for long connection names', async () => {
  digitalConnection.name = 'Long-RH-tool-connection-name-'.repeat(12)
  await renderConnectionsPage()
  await userEvent.click(
    await screen.findByRole('button', { name: 'RH tools and credentials' })
  )
  const dialog = await screen.findByRole('dialog', {
    name: 'RH tools and credentials',
  })
  const name = await within(dialog).findByText(digitalConnection.name)
  expect(name.parentElement).toHaveClass('min-w-0', 'break-words')
  const tool = within(dialog).getByRole('heading', {
    name: 'Digital human',
  }).parentElement
  expect(tool).toHaveClass('min-w-0')
  expect(tool?.parentElement).toHaveClass('grid', 'min-w-0', 'sm:grid-cols-2')
})

