const ACCOUNT_PATH = '/account-lite/index.html'

// Keep old bookmarks compatible without mounting retired product pages.
export function piknoStorefrontDestination(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, '') || '/'
  const accountTabs: Record<string, string> = {
    '/wallet': 'topup',
    '/keys': 'keys',
    '/settlements': 'usage',
  }
  if (accountTabs[path]) return `${ACCOUNT_PATH}?tab=${accountTabs[path]}`

  const retired = [
    '/playground', '/chat', '/chat2link', '/subscriptions', '/redemption-codes',
    '/models', '/catalog-management', '/rankings', '/pricing',
  ]
  if (retired.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return ACCOUNT_PATH
  }
  if (['/dashboard/models', '/dashboard/flow', '/dashboard/users'].includes(path)) {
    return '/dashboard/overview'
  }
}
