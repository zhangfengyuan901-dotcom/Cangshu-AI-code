import { expect, test } from 'vitest'

import { piknoStorefrontDestination } from '../pikno-storefront'

const accountPath = '/account-lite/index.html'

test.each([
  '/playground', '/chat/0', '/chat2link', '/subscriptions/', '/redemption-codes',
  '/models/deployments', '/catalog-management', '/rankings', '/rankings/',
  '/pricing', '/pricing/model-detail',
])('retired page %s opens the static customer account', (path) => {
  expect(piknoStorefrontDestination(path)).toBe(accountPath)
})

test.each([
  ['/wallet', 'topup'], ['/wallet/', 'topup'], ['/keys', 'keys'], ['/settlements', 'usage'],
])('legacy customer page %s opens its H5 tab', (path, tab) => {
  expect(piknoStorefrontDestination(path)).toBe(`${accountPath}?tab=${tab}`)
})

test.each(['/dashboard/models', '/dashboard/flow', '/dashboard/users'])(
  'retired analytics page %s uses the remaining overview',
  (path) => expect(piknoStorefrontDestination(path)).toBe('/dashboard/overview')
)

test.each([
  '/sign-in', '/sign-up', '/oauth/callback', '/security', '/line-management',
  '/settlement-admin', '/users', '/channels', '/task-plugins', '/catalog-admin',
  '/system-settings/billing/model-pricing', '/usage-logs/common', '/usage-logs/task',
  '/usage-logs/audit', '/dashboard/overview', '/models-extra', '/rankings-extra',
])('core maintenance page %s remains unchanged', (path) => {
  expect(piknoStorefrontDestination(path)).toBeUndefined()
})
