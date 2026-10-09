import { afterEach, expect, test } from 'vitest'
import { Route } from '@/routes/index'
import { useAuthStore } from '@/stores/auth-store'

afterEach(() => useAuthStore.getState().auth.reset())

test.each([
  { signedIn: false, query: '', expected: '/sign-in' },
  { signedIn: false, query: '?aff=invite123', expected: '/sign-in?aff=invite123' },
  { signedIn: true, query: '', expected: '/dashboard' },
])('root redirects signedIn=$signedIn query=$query to $expected', ({ signedIn, query, expected }) => {
  useAuthStore.getState().auth.setUser(signedIn ? { id: 10, username: 'customer', role: 1 } : null)
  const beforeLoad = Route.options.beforeLoad!
  try {
    beforeLoad({ location: { searchStr: query } } as Parameters<typeof beforeLoad>[0])
    expect.fail('Expected root redirect')
  } catch (error) {
    expect(error).toMatchObject({ options: { href: expected, replace: true } })
  }
})
