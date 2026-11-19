import { defaultParseSearch, redirect } from '@tanstack/react-router'

import { ACCOUNT_LITE_PATH } from '@/lib/constants'

const internalOrigin = 'https://internal-redirect.invalid'

// Callers supply a validated same-origin path. Keeping its parts in router
// options lets intent preloads follow the same target as ordinary navigation.
export function internalRedirect(href: string) {
  const target = new URL(href, internalOrigin)
  if (target.origin !== internalOrigin || /[\\\r\n]/.test(href)) throw new Error('Invalid internal destination')
  if (target.pathname === ACCOUNT_LITE_PATH) {
    const tab = target.searchParams.get('tab')
    const hash = target.hash
    const cleanSearch = target.search === '' || target.searchParams.size === 1 && ['balance', 'usage', 'topup', 'keys'].includes(tab || '')
    if (!cleanSearch || !['', '#balance', '#consumption', '#recharge', '#keys'].includes(hash)) throw new Error('Invalid account destination')
    return redirect({ href: target.pathname + target.search + target.hash, reloadDocument: true, replace: true })
  }
  return redirect({
    to: target.pathname,
    search: defaultParseSearch(target.search),
    hash: target.hash.slice(1),
    replace: true,
  })
}
