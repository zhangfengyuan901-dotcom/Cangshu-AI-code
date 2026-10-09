import { createFileRoute, redirect } from '@tanstack/react-router'

import { CatalogAdmin } from '@/features/catalog/admin'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/catalog-admin')({
  beforeLoad: () => {
    if ((useAuthStore.getState().auth.user?.role ?? 0) < ROLE.SUPER_ADMIN) {
      throw redirect({ to: '/403' })
    }
  },
  component: CatalogAdmin,
})
