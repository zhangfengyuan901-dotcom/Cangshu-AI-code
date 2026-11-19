import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const CONTENT_SECTION_NAV = [
  { id: 'dashboard', titleKey: 'Data Dashboard' },
  { id: 'announcements', titleKey: 'Announcements' },
  { id: 'api-info', titleKey: 'API Addresses' },
  { id: 'faq', titleKey: 'FAQ' },
  { id: 'uptime-kuma', titleKey: 'Uptime Kuma' },
] as const
export const CONTENT_SECTION_IDS = CONTENT_SECTION_NAV.map((section) => section.id) as [
  (typeof CONTENT_SECTION_NAV)[number]['id'],
  ...(typeof CONTENT_SECTION_NAV)[number]['id'][],
]
export const CONTENT_DEFAULT_SECTION = 'dashboard' as const
export function getContentSectionNavItems(t: TFunction) {
  return CONTENT_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/content/${section.id}`,
  }))
}
