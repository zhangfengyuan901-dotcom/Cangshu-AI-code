import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const AUTH_SECTION_NAV = [
  { id: 'basic-auth', titleKey: 'Basic Authentication' },
  { id: 'oauth', titleKey: 'OAuth Integrations' },
  { id: 'passkey', titleKey: 'Passkey Authentication' },
  { id: 'bot-protection', titleKey: 'Bot Protection' },
  { id: 'custom-oauth', titleKey: 'Custom OAuth' },
] as const
export const AUTH_SECTION_IDS = AUTH_SECTION_NAV.map((section) => section.id) as [
  (typeof AUTH_SECTION_NAV)[number]['id'],
  ...(typeof AUTH_SECTION_NAV)[number]['id'][],
]
export const AUTH_DEFAULT_SECTION = 'basic-auth' as const
export function getAuthSectionNavItems(t: TFunction) {
  return AUTH_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/auth/${section.id}`,
  }))
}
