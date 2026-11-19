import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const SECURITY_SECTION_NAV = [
  { id: 'rate-limit', titleKey: 'Rate Limiting' },
  { id: 'ssrf', titleKey: 'SSRF Protection' },
  { id: 'token-limits', titleKey: 'Token Limits' },
] as const
export const SECURITY_SECTION_IDS = SECURITY_SECTION_NAV.map((section) => section.id) as [
  (typeof SECURITY_SECTION_NAV)[number]['id'],
  ...(typeof SECURITY_SECTION_NAV)[number]['id'][],
]
export const SECURITY_DEFAULT_SECTION = 'rate-limit' as const
export function getSecuritySectionNavItems(t: TFunction) {
  return SECURITY_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/security/${section.id}`,
  }))
}
