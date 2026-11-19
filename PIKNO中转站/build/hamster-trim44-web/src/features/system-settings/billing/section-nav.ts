import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const BILLING_SECTION_NAV = [
  { id: 'quota', titleKey: 'Quota Settings' },
  { id: 'currency', titleKey: 'Currency & Display' },
  { id: 'model-pricing', titleKey: 'Model Pricing' },
  { id: 'group-pricing', titleKey: 'Group Pricing' },
  { id: 'payment', titleKey: 'Payment Gateway' },
] as const
export const BILLING_SECTION_IDS = BILLING_SECTION_NAV.map((section) => section.id) as [
  (typeof BILLING_SECTION_NAV)[number]['id'],
  ...(typeof BILLING_SECTION_NAV)[number]['id'][],
]
export const BILLING_DEFAULT_SECTION = 'quota' as const
export function getBillingSectionNavItems(t: TFunction) {
  return BILLING_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/billing/${section.id}`,
  }))
}
