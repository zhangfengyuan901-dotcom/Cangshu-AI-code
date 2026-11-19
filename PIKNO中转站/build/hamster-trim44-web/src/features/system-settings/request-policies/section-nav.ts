import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const POLICY_SECTION_NAV = [
  { id: 'filtering', titleKey: 'Request checks' },
  { id: 'routing', titleKey: 'Sessions and retries' },
  { id: 'health', titleKey: 'Channel health' },
] as const
export const POLICY_SECTION_IDS = POLICY_SECTION_NAV.map((section) => section.id) as [
  (typeof POLICY_SECTION_NAV)[number]['id'],
  ...(typeof POLICY_SECTION_NAV)[number]['id'][],
]
export const POLICY_DEFAULT_SECTION = 'routing' as const
export function getPolicySectionNavItems(t: TFunction) {
  return POLICY_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/request-policies/${section.id}`,
  }))
}
