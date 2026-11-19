import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ThemeProvider, useTheme } from '@/context/theme-provider'
import { ThemeCustomizationProvider, useThemeCustomization } from '@/context/theme-customization-provider'
import { DirectionProvider, useDirection } from '@/context/direction-provider'
import { FontProvider, useFont } from '@/context/font-provider'
import { LayoutProvider, useLayout } from '@/context/layout-provider'

function Fixture() {
  const theme = useTheme()
  const customization = useThemeCustomization()
  const direction = useDirection()
  const font = useFont()
  const layout = useLayout()
  return <>
    <output aria-label='fixed preferences'>{[theme.theme, customization.customization.preset, direction.dir, font.font, layout.variant, layout.collapsible].join('/')}</output>
    <button onClick={() => {
      theme.setTheme('dark'); customization.setPreset('rose-garden'); customization.setFont('serif')
      direction.setDir('rtl'); font.setFont('inter'); layout.setVariant('floating')
    }}>Legacy control</button>
  </>
}
function Providers() {
  return <ThemeProvider><ThemeCustomizationProvider><DirectionProvider><FontProvider><LayoutProvider><Fixture /></LayoutProvider></FontProvider></DirectionProvider></ThemeCustomizationProvider></ThemeProvider>
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

test('ignores legacy preferences without deleting unrelated data or writing theme state', () => {
  localStorage.setItem('newapi:theme:v1:mode', 'dark')
  localStorage.setItem('newapi:theme:v1:preset', 'rose-garden')
  localStorage.setItem('hamster-pending-key-operation', '{"id":12}')
  document.cookie = 'dir=rtl; path=/'
  document.documentElement.classList.add('dark')
  document.body.setAttribute('data-theme-preset', 'rose-garden')
  const write = vi.spyOn(localStorage, 'setItem')
  render(<Providers />)
  expect(screen.getByLabelText('fixed preferences')).toHaveTextContent('light/default/ltr/system/inset/icon')
  expect(document.documentElement).toHaveClass('light')
  expect(document.documentElement).not.toHaveClass('dark')
  expect(document.documentElement).toHaveAttribute('dir', 'ltr')
  expect(document.body).not.toHaveAttribute('data-theme-preset')
  expect(document.body).toHaveAttribute('data-theme-font', 'sans')
  expect(document.body).toHaveAttribute('data-theme-content-layout', 'full')
  screen.getByText('Legacy control').click()
  expect(screen.getByLabelText('fixed preferences')).toHaveTextContent('light/default/ltr/system/inset/icon')
  expect(localStorage.getItem('hamster-pending-key-operation')).toBe('{"id":12}')
  expect(write).not.toHaveBeenCalled()
})

test('fixed preferences render when local storage and media queries are unavailable', () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })
  vi.spyOn(window, 'matchMedia').mockImplementation(() => { throw new Error('media unavailable') })
  render(<Providers />)
  expect(screen.getByLabelText('fixed preferences')).toHaveTextContent('light/default/ltr/system/inset/icon')
})
