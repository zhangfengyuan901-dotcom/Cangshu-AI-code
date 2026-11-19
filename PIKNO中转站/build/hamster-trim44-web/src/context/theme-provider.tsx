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

type Theme = 'dark' | 'light' | 'system'
type ThemeProviderProps = { children: React.ReactNode; defaultTheme?: Theme; storageKey?: string }
const fixedTheme = {
  defaultTheme: 'light' as Theme,
  resolvedTheme: 'light' as 'light' | 'dark',
  theme: 'light' as Theme,
  setTheme: (_theme: Theme) => {},
  resetTheme: () => {},
}
const ThemeContext = createContext(fixedTheme)

export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  }, [])
  return <ThemeContext value={fixedTheme}>{children}</ThemeContext>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => useContext(ThemeContext)
