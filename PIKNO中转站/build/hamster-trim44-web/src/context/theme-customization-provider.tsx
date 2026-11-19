/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { createContext, useContext, useEffect } from 'react'
import {
  DEFAULT_THEME_CUSTOMIZATION,
  type ContentLayout,
  type ThemeFont,
  type ThemePreset,
  type ThemeRadius,
  type ThemeScale,
} from '@/lib/theme-customization'

const fixedCustomization = {
  defaults: DEFAULT_THEME_CUSTOMIZATION,
  customization: DEFAULT_THEME_CUSTOMIZATION,
  setPreset: (_value: ThemePreset) => {},
  setFont: (_value: ThemeFont) => {},
  setRadius: (_value: ThemeRadius) => {},
  setScale: (_value: ThemeScale) => {},
  setContentLayout: (_value: ContentLayout) => {},
  resetCustomization: () => {},
}
const ThemeCustomizationContext = createContext(fixedCustomization)

export function ThemeCustomizationProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const body = document.body
    for (const name of ['preset', 'radius', 'scale']) body.removeAttribute(`data-theme-${name}`)
    body.setAttribute('data-theme-font', 'sans')
    body.setAttribute('data-theme-content-layout', 'full')
  }, [])
  return <ThemeCustomizationContext value={fixedCustomization}>{children}</ThemeCustomizationContext>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useThemeCustomization() { return useContext(ThemeCustomizationContext) }
