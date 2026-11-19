import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const SITE_SECTION_NAV = [
  { id: 'system-info', titleKey: 'System Information' },
  { id: 'notice', titleKey: 'System Notice' },
] as const
export const SITE_SECTION_IDS = SITE_SECTION_NAV.map((section) => section.id) as [
  (typeof SITE_SECTION_NAV)[number]['id'],
  ...(typeof SITE_SECTION_NAV)[number]['id'][],
]
export const SITE_DEFAULT_SECTION = 'system-info' as const
export function getSiteSectionNavItems(t: TFunction) {
  return SITE_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/site/${section.id}`,
  }))
}
