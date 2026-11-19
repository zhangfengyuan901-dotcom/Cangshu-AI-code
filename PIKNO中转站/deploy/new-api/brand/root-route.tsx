/* Copyright (C) 2023-2026 QuantumNous. Licensed under GNU AGPL v3 or later.
 * PIKNO login-first entry, modified 2026-10-05.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/')({
  beforeLoad: ({ location }) => {
    const { auth } = useAuthStore.getState()
    throw redirect({
      href: `${auth.user ? '/dashboard' : '/sign-in'}${location.searchStr}`,
      replace: true,
    })
  },
})
