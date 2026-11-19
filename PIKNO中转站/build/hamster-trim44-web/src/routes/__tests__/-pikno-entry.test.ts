import { afterEach, expect, test } from 'vitest'
import { Route } from '@/routes/index'
import { useAuthStore } from '@/stores/auth-store'

afterEach(() => useAuthStore.getState().auth.reset())

test.each([
  { signedIn: false, query: '', expected: '/sign-in' },
  { signedIn: false, query: '?aff=invite123', expected: '/sign-in' },
  { signedIn: true, query: '', expected: '/dashboard' },
  { signedIn: true, query: '?aff=invite123&redirect=%2Fpricing', expected: '/dashboard' },
])('root redirects signedIn=$signedIn query=$query to $expected', ({ signedIn, query, expected }) => {
  useAuthStore.getState().auth.setUser(signedIn ? { id: 10, username: 'customer', role: 1 } : null)
  const beforeLoad = Route.options.beforeLoad
  if (!beforeLoad) throw new Error('Missing entry guard')
  const search = Object.fromEntries(new URLSearchParams(query))
  try {
    beforeLoad({ location: { searchStr: query, search } } as Parameters<typeof beforeLoad>[0])
    expect.fail('Expected root redirect')
  } catch (error) {
    expect(error).toMatchObject({ options: { to: expected, search, replace: true } })
  }
})
