import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { routerNavigationOptions } from '@/lib/router-navigation'

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function harness() {
  const beforeLoad = vi.fn()
  const loader = vi.fn(async () => 'ready')
  const root = createRootRoute({ component: Outlet })
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <main>
        <h1>Home fixture</h1>
        <Link to='/pricing' preloadDelay={0}>Models fixture</Link>
      </main>
    ),
  })
  const models = createRoute({
    getParentRoute: () => root,
    path: '/pricing',
    beforeLoad,
    loader,
    component: () => <h1>Models loaded</h1>,
  })
  const router = createRouter({
    routeTree: root.addChildren([home, models]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    ...routerNavigationOptions,
  })
  const preload = vi.spyOn(router, 'preloadRoute')
  const view = render(<RouterProvider router={router} />)
  return { router, beforeLoad, loader, preload, view }
}

test.each(['hover', 'focus', 'touch'] as const)(
  'application navigation policy keeps %s from loading a destination',
  async (intent) => {
    const fixture = harness()
    const link = await screen.findByRole('link', { name: 'Models fixture' })
    await act(async () => {
      if (intent === 'hover') fireEvent.mouseEnter(link)
      if (intent === 'focus') fireEvent.focus(link)
      if (intent === 'touch') fireEvent.touchStart(link)
      // Intent handlers enqueue their work; allow it to start before checking.
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(fixture.preload).not.toHaveBeenCalled()
    expect(fixture.beforeLoad).not.toHaveBeenCalled()
    expect(fixture.loader).not.toHaveBeenCalled()
    expect(fixture.router.state.location.pathname).toBe('/')
  },
)

test('application navigation policy preserves click, back and forward loading', async () => {
  const fixture = harness()
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const link = await screen.findByRole('link', { name: 'Models fixture' })
  expect(fixture.loader).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(link) })
  await screen.findByRole('heading', { name: 'Models loaded' })
  expect(fixture.beforeLoad).toHaveBeenCalled()
  expect(fixture.loader).toHaveBeenCalled()
  expect(fixture.preload).not.toHaveBeenCalled()

  await act(async () => { fixture.router.history.back() })
  await screen.findByRole('heading', { name: 'Home fixture' })
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe('/'))

  await act(async () => { fixture.router.history.forward() })
  await screen.findByRole('heading', { name: 'Models loaded' })
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe('/pricing'))
  expect(fixture.preload).not.toHaveBeenCalled()
  expect(errors.mock.calls.flat().join(' ')).not.toMatch(/_nonReactive|Maximum update depth/)
})
