import { createFileRoute, redirect } from '@tanstack/react-router'

import { SettlementAdminPage } from '@/features/settlements'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/settlement-admin')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (user?.role !== ROLE.SUPER_ADMIN || user.username !== 'piknoadmin') {
      throw redirect({ to: '/403' })
    }
  },
  component: SettlementAdminPage,
})
