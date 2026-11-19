import { afterEach, expect, test, vi } from 'vitest'

import { Route as ChannelsRoute } from '@/routes/_authenticated/channels/index'
import { Route as LinesRoute } from '@/routes/_authenticated/line-management'
import { useAuthStore } from '@/stores/auth-store'

vi.mock('@/features/channels', () => ({ Channels: () => null }))
vi.mock('@/features/line-management', () => ({ LineManagement: () => null }))

afterEach(() => useAuthStore.setState(useAuthStore.getInitialState(), true))

test.each([
  { role: 0, upstream: false, lines: false },
  { role: 1, upstream: false, lines: false },
  { role: 10, upstream: true, lines: false },
  { role: 99, upstream: true, lines: false },
  { role: 100, upstream: true, lines: true },
  { role: 200, upstream: true, lines: true },
])('operator page guards retain permissions for role $role', ({ role, upstream, lines }) => {
  useAuthStore.getState().auth.setUser(role ? { id: 12, username: 'synthetic-operator', role } : null)
  for (const [route, allowed] of [[ChannelsRoute, upstream], [LinesRoute, lines]] as const) {
    const beforeLoad = route.options.beforeLoad
    if (!beforeLoad) throw new Error('Missing operator access guard')
    // These guards read the current account, not their route-specific context.
    const invoke = () => beforeLoad({} as never)
    if (allowed) expect(invoke).not.toThrow()
    else {
      try {
        invoke()
        expect.fail('Expected forbidden redirect')
      } catch (error) {
        expect(error).toMatchObject({ options: { to: '/403' } })
      }
    }
  }
})
