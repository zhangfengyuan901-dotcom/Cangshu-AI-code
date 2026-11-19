import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { expect, test, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test.each(['clearCache', 'invalidate'] as const)(
  'an in-flight preload settles safely when %s retires its cache entry',
  async (operation) => {
    const started = deferred<void>()
    const release = deferred<string>()
    const root = createRootRoute()
    const safe = createRoute({ getParentRoute: () => root, path: '/safe' })
    let calls = 0
    const slow = createRoute({
      getParentRoute: () => root,
      path: '/slow',
      preloadGcTime: 0,
      loader: async () => {
        calls += 1
        started.resolve()
        return release.promise
      },
    })
    const router = createRouter({
      routeTree: root.addChildren([safe, slow]),
      history: createMemoryHistory({ initialEntries: ['/safe'] }),
      defaultPreload: false,
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await router.load()
    const unsubscribe = router.history.subscribe(() => { void router.load() })
    try {
      const preload = router.preloadRoute({ to: '/slow' })
      await started.promise
      expect(calls).toBe(1)
      if (operation === 'clearCache') {
        router.clearCache({ filter: match => match.routeId === slow.id })
      } else {
        await router.invalidate()
      }
      release.resolve('loaded-after-eviction')
      await preload
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/_nonReactive|TypeError/)
      expect(router.state.location.pathname).toBe('/safe')
      await router.navigate({ href: '/slow' })
      expect(router.state.location.pathname).toBe('/slow')
      expect(router.state.matches.at(-1)?.status).toBe('success')
      expect(router.state.matches.at(-1)?.loaderData).toBe('loaded-after-eviction')
    } finally {
      release.resolve('cleanup')
      unsubscribe()
      errors.mockRestore()
    }
  },
)
