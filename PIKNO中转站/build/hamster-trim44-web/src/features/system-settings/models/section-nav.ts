import type { TFunction } from 'i18next'

// Route guards and sidebar metadata must not import settings forms.
export const MODELS_SECTION_NAV = [
  { id: 'global', titleKey: 'Global Model Configuration' },
  { id: 'gemini', titleKey: 'Gemini' },
  { id: 'claude', titleKey: 'Claude' },
  { id: 'grok', titleKey: 'Grok' },
  { id: 'model-deployment', titleKey: 'Model Deployment' },
] as const
export const MODELS_SECTION_IDS = MODELS_SECTION_NAV.map((section) => section.id) as [
  (typeof MODELS_SECTION_NAV)[number]['id'],
  ...(typeof MODELS_SECTION_NAV)[number]['id'][],
]
export const MODELS_DEFAULT_SECTION = 'global' as const
export function getModelsSectionNavItems(t: TFunction) {
  return MODELS_SECTION_NAV.map((section) => ({
    title: t(section.titleKey),
    url: `/system-settings/models/${section.id}`,
  }))
}
