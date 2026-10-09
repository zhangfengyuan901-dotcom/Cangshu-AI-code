import { createFileRoute } from '@tanstack/react-router'

import { SettlementsPage } from '@/features/settlements'

export const Route = createFileRoute('/_authenticated/settlements')({
  component: SettlementsPage,
})
