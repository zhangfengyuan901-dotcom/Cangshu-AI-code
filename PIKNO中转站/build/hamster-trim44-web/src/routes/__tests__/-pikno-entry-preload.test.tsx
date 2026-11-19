import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { Route as EntryRoute } from '@/routes/index'
import { useAuthStore } from '@/stores/auth-store'

afterEach(() => {
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
})

type EntryContext = Parameters<NonNullable<typeof EntryRoute.options.beforeLoad>>[0]

function harness(signedIn: boolean) {
  useAuthStore.getState().auth.setUser(
    signedIn ? { id: 10, username: 'synthetic-customer', role: 1 } : null
  )
  let entryCalls = 0
  let destinationCalls = 0
  let preloadCalls = 0
  let buildCalls = 0
  let preloadLimit = 8
  let buildLimit = 32
  const root = createRootRoute()
  const beforeLoad = EntryRoute.options.beforeLoad
  if (!beforeLoad) throw new Error('Missing entry guard')
  const entry = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: (context) => {
      entryCalls++
      return beforeLoad(context as unknown as EntryContext)
    },
  })
  const destinations = ['/sign-in', '/dashboard'].map((path) => createRoute({
    getParentRoute: () => root,
    path,
    beforeLoad: () => { destinationCalls++ },
  }))
  const pricing = createRoute({ getParentRoute: () => root, path: '/pricing' })
  const router = createRouter({
    routeTree: root.addChildren([entry, ...destinations, pricing]),
    history: createMemoryHistory({ initialEntries: ['/pricing?aff=invite123&redirect=%2Fpricing'] }),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
  const originalPreload = router.preloadRoute.bind(router)
  router.preloadRoute = async (options) => {
    if (++preloadCalls > preloadLimit) throw new Error('Repeated redirect preload')
    return originalPreload(options)
  }
  const originalBuild = router.buildLocation.bind(router)
  router.buildLocation = ((...args: Parameters<typeof originalBuild>) => {
    if (++buildCalls > buildLimit) throw new Error('Repeated redirect location build')
    return originalBuild(...args)
  }) as typeof router.buildLocation
  return {
    router,
    next: () => { preloadLimit = preloadCalls + 8; buildLimit = buildCalls + 32 },
    counters: () => ({ entryCalls, destinationCalls, preloadCalls, buildCalls }),
  }
}

test.each([false, true])('actual entry guard terminates intent preload signedIn=%s', async (signedIn) => {
  const fixture = harness(signedIn)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  await fixture.router.load()
  for (let index = 0; index < 20; index++) {
    fixture.next()
    const before = fixture.counters()
    const matches = await fixture.router.preloadRoute({ to: '/' })
    const after = fixture.counters()
    expect(after.entryCalls - before.entryCalls).toBe(1)
    expect(after.destinationCalls - before.destinationCalls).toBe(1)
    expect(matches?.at(-1)?.pathname).toBe(signedIn ? '/dashboard' : '/sign-in')
    // Router versions may follow the redirect within the same preload call.
    expect(after.preloadCalls - before.preloadCalls).toBeGreaterThan(0)
    expect(after.preloadCalls - before.preloadCalls).toBeLessThanOrEqual(2)
    expect(fixture.router.state.location.pathname).toBe('/pricing')
  }
  expect(errors.mock.calls.flat().join(' ')).not.toMatch(/Repeated redirect/)
})

test.each([false, true])('actual entry guard resolves internal navigation and preserves query signedIn=%s', async (signedIn) => {
  const fixture = harness(signedIn)
  await fixture.router.load()
  const unsubscribe = fixture.router.history.subscribe(() => { void fixture.router.load() })
  try {
    await fixture.router.navigate({ to: '/', search: true })
    expect(fixture.router.state.location.pathname).toBe(signedIn ? '/dashboard' : '/sign-in')
    expect(fixture.router.state.location.search).toMatchObject({ aff: 'invite123', redirect: '/pricing' })
    expect(fixture.counters().entryCalls).toBe(1)
  } finally {
    unsubscribe()
  }
})
