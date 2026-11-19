import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { Route as RootRoute } from '@/routes/__root'
import { Route as SignInRoute } from '@/routes/(auth)/sign-in'
import { useAuthStore } from '@/stores/auth-store'

vi.mock('@/features/setup/api', () => ({ getSetupStatus: vi.fn(async () => ({ success: true, data: { status: true } })) }))
vi.mock('@/lib/auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth-session')>()),
  bootstrapAuthentication: vi.fn(async () => ({ kind: 'anonymous' as const })),
  resolveAuthentication: vi.fn(async () => ({ kind: 'anonymous' as const })),
}))

afterEach(() => { useAuthStore.getState().auth.reset(); vi.restoreAllMocks() })

const cases = [
  { name: 'signed-in sign-in guard', source: '/sign-in', search: { redirect: '/channels?view=card&count=2#models' }, signedIn: true, expected: '/channels', expectedSearch: { view: 'card', count: 2 }, expectedHash: 'models' },
  { name: 'legacy sign-in mapping', source: '/login', search: { aff: 'invite123', redirect: '/pricing?view=card#models' }, hash: 'entry', signedIn: false, expected: '/sign-in', expectedSearch: { aff: 'invite123', redirect: '/pricing?view=card#models' }, expectedHash: 'entry' },
] as const

function invoke(guard: unknown, context: unknown) {
  if (typeof guard !== 'function') throw new Error('Missing actual route guard')
  return Reflect.apply(guard, undefined, [context])
}

function harness(signedIn: boolean) {
  useAuthStore.getState().auth.setUser(signedIn ? { id: 10, username: 'synthetic-customer', role: 1 } : null)
  const queryClient = new QueryClient()
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ beforeLoad: (context) => invoke(RootRoute.options.beforeLoad, context) })
  const signIn = createRoute({ getParentRoute: () => root, path: '/sign-in', validateSearch: SignInRoute.options.validateSearch, beforeLoad: (context) => invoke(SignInRoute.options.beforeLoad, context) })
  const paths = ['/', '/login', '/rankings', '/models', '/channels', '/pricing', '/dashboard', '/dashboard/overview']
  const routes = paths.map((path) => createRoute({ getParentRoute: () => root, path }))
  const router = createRouter({ routeTree: root.addChildren([signIn, ...routes]), context: { queryClient }, history: createMemoryHistory({ initialEntries: ['/channels'] }), defaultPreload: 'intent', defaultPreloadStaleTime: 0 })
  let preloadCalls = 0
  let buildCalls = 0
  let preloadLimit = 8
  let buildLimit = 32
  const originalPreload = router.preloadRoute.bind(router)
  router.preloadRoute = async (options) => {
    if (++preloadCalls > preloadLimit) throw new Error('Repeated internal redirect preload')
    return originalPreload(options)
  }
  const originalBuild = router.buildLocation.bind(router)
  router.buildLocation = ((...args: Parameters<typeof originalBuild>) => {
    if (++buildCalls > buildLimit) throw new Error('Repeated internal redirect location build')
    return originalBuild(...args)
  }) as typeof router.buildLocation
  return { router, next: () => { preloadLimit = preloadCalls + 8; buildLimit = buildCalls + 32 }, counters: () => ({ preloadCalls, buildCalls }), cleanup: () => queryClient.clear() }
}

test.each(cases)('actual $name completes repeated intent preloads at its preserved target', async (item) => {
  const fixture = harness(item.signedIn)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await fixture.router.load()
    for (let iteration = 0; iteration < 20; iteration++) {
      fixture.next()
      // Legacy URLs deliberately are not part of generated file-route types.
      // Exercise the runtime preloader with those real incoming URLs.
      const matches = await Reflect.apply(fixture.router.preloadRoute, fixture.router, [
        { to: item.source, search: item.search, hash: 'hash' in item ? item.hash : '' },
      ]) as Awaited<ReturnType<typeof fixture.router.preloadRoute>>
      expect(matches?.at(-1)?.pathname).toBe(item.expected)
      expect(matches?.at(-1)?.search).toMatchObject(item.expectedSearch)
      expect(fixture.router.state.location.pathname).toBe('/channels')
    }
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/Repeated internal redirect/)
  } finally { fixture.cleanup() }
})

test.each(cases)('actual $name preserves path, query and hash on navigation', async (item) => {
  const fixture = harness(item.signedIn)
  await fixture.router.load()
  const unsubscribe = fixture.router.history.subscribe(() => { void fixture.router.load() })
  try {
    const hash = 'hash' in item ? `#${item.hash}` : ''
    await fixture.router.navigate({ href: item.source + fixture.router.options.stringifySearch(item.search) + hash })
    expect(fixture.router.state.location.pathname).toBe(item.expected)
    expect(fixture.router.state.location.search).toMatchObject(item.expectedSearch)
    expect(fixture.router.state.location.hash).toBe(item.expectedHash)
  } finally { unsubscribe(); fixture.cleanup() }
})
