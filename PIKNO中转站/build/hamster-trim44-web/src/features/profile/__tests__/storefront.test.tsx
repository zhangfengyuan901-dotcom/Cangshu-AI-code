import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Profile } from '../index'

vi.mock('@/hooks/use-status', () => ({
  useStatus: () => ({ status: { checkin_enabled: true } }),
}))
vi.mock('../components/checkin-calendar-card', () => ({
  CheckinCalendarCard: () => {
    throw new Error('Retired check-in feature mounted')
  },
}))
vi.mock('../components/profile-header', () => ({
  ProfileHeader: ({ profile }: { profile: { username: string } | null }) => (
    <div>{profile?.username}</div>
  ),
}))
vi.mock('../components/profile-settings-card', () => ({
  ProfileSettingsCard: () => <div>Account settings</div>,
}))
vi.mock('../components/language-preferences-card', () => ({
  LanguagePreferencesCard: () => <div>Language preferences</div>,
}))
vi.mock('../components/sidebar-modules-card', () => ({
  SidebarModulesCard: () => null,
}))

afterEach(() => {
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

test('profile retains account settings without language, navigation decoration, or check-in', async () => {
  const requests: string[] = []
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    requests.push(path)
    if (path !== '/api/user/self') throw new Error('Unexpected profile request')
    return {
      data: {
        success: true,
        data: { id: 12, username: 'storefront-customer', role: 1 },
      },
    }
  })
  useAuthStore
    .getState()
    .auth.setUser({ id: 12, username: 'storefront-customer', role: 1 })
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <Profile />
    </QueryClientProvider>
  )
  expect(await screen.findByText('storefront-customer')).toBeInTheDocument()
  expect(screen.getByText('Account settings')).toBeInTheDocument()
  expect(screen.queryByText('Language preferences')).not.toBeInTheDocument()
  expect(requests).toEqual(['/api/user/self'])
  client.clear()
})
