import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const OPERATIONS_SECTION_NAV = [
  { id: 'behavior', titleKey: 'System Behavior' },
  { id: 'alerts', titleKey: 'Monitoring & Alerts' },
  { id: 'email', titleKey: 'SMTP Email' },
  { id: 'worker', titleKey: 'Worker Proxy' },
  { id: 'logs', titleKey: 'Log Maintenance' },
  { id: 'performance', titleKey: 'Performance' },
  { id: 'update-checker', titleKey: 'System maintenance' },
] as const
export const OPERATIONS_SECTION_IDS = OPERATIONS_SECTION_NAV.map((section) => section.id) as [
  (typeof OPERATIONS_SECTION_NAV)[number]['id'],
  ...(typeof OPERATIONS_SECTION_NAV)[number]['id'][],
]
export const OPERATIONS_DEFAULT_SECTION = 'behavior' as const
export function getOperationsSectionNavItems(t: TFunction) {
  return OPERATIONS_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/operations/${section.id}`,
  }))
}
