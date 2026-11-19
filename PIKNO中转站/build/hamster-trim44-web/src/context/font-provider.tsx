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
import type { fonts } from '@/config/fonts'
type Font = (typeof fonts)[number]
const fixedFont = { font: 'system' as Font, setFont: (_font: Font) => {}, resetFont: () => {} }
const FontContext = createContext(fixedFont)
export function FontProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement
    for (const value of Array.from(root.classList)) if (value.startsWith('font-')) root.classList.remove(value)
    root.classList.add('font-system')
  }, [])
  return <FontContext value={fixedFont}>{children}</FontContext>
}
// eslint-disable-next-line react-refresh/only-export-components
export const useFont = () => useContext(FontContext)
