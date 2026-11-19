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
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ChannelsPrimaryButtons } from '../channels-primary-buttons'
import { ChannelsProvider } from '../channels-provider'

const originalAuth = useAuthStore.getState().auth
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})
let client: QueryClient

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: 100 })
})

afterEach(() => {
  cleanup()
  client.clear()
  localStorage.clear()
  useAuthStore.setState({ auth: originalAuth })
  vi.restoreAllMocks()
})

function renderActions() {
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ChannelsProvider>
          <ChannelsPrimaryButtons />
        </ChannelsProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

it('does not expose all-channel mutation or test actions from the general connection view', async () => {
  renderActions()
  expect(screen.getByRole('button', { name: /Create Channel/ })).toBeEnabled()
  expect(
    screen.getByRole('button', { name: 'Connection view options' })
  ).toHaveClass('sm:hidden')
  await userEvent.click(screen.getByRole('button', { expanded: false }))
  const menu = await screen.findByRole('menu')
  for (const name of [
    'Test All Channels',
    'Update All Balances',
    'Detect All Upstream Updates',
    'Apply All Upstream Updates',
    'Repair Channel Consistency',
    'Delete All Disabled',
  ]) {
    expect(within(menu).queryByText(name)).not.toBeInTheDocument()
  }
})

it('retains mobile view toggles without making any server writes or all-channel requests', async () => {
  const get = vi.spyOn(api, 'get')
  const post = vi.spyOn(api, 'post')
  const put = vi.spyOn(api, 'put')
  const remove = vi.spyOn(api, 'delete')
  renderActions()
  await userEvent.click(screen.getByRole('button', { expanded: false }))
  const menu = await screen.findByRole('menu')
  await userEvent.click(
    within(menu).getByRole('menuitemcheckbox', { name: 'Tag Mode' })
  )
  expect(localStorage.getItem('enable-tag-mode')).toBe('true')
  expect(get).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})
