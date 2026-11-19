import { createFileRoute, redirect } from '@tanstack/react-router'

// Legacy bookmarks leave the operator bundle and open the native account page.
export const Route = createFileRoute('/_authenticated/settlements')({
  beforeLoad: () => {
    throw redirect({
      href: '/account-lite/index.html?tab=usage',
      reloadDocument: true,
      replace: true,
    })
  },
  component: () => null,
})
