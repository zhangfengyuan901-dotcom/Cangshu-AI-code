import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { getLobeIcon, getLobeIconNames } from '../lobe-icon'
import { ReactIconByName } from '@/components/react-icon-by-name'

test('retains explicit vendor icons, bounded catalog and custom icons', () => {
  const { rerender } = render(getLobeIcon('Claude.Color.size={32}.role="img".aria-label="Claude icon"'))
  expect(screen.getByRole('img', { name: 'Claude icon' })).toHaveAttribute('width', '32')
  rerender(getLobeIcon('SGLang', 24))
  expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute('width', '24')
  expect(getLobeIconNames()).toContain('OpenAI')
  expect(getLobeIconNames().length).toBeLessThan(20)
})
test('unknown vendor names render a neutral badge and cannot pick module paths', () => {
  const { rerender } = render(getLobeIcon('UnusedVendor.Color', 30))
  expect(screen.getByText('U')).toHaveStyle({ width: '30px', height: '30px' })
  rerender(getLobeIcon('../private', 24))
  expect(screen.getByText('.')).toBeVisible()
  rerender(getLobeIcon('constructor', 24))
  expect(screen.getByText('C')).toBeVisible()
})
test('payment icons keep common providers and a neutral fallback', () => {
  const { container, rerender } = render(<ReactIconByName name='SiAlipay' />)
  expect(container.querySelector('svg')).not.toBeNull()
  rerender(<ReactIconByName name='UnknownPackIcon' />)
  expect(container.querySelector('svg')).not.toBeNull()
  rerender(<ReactIconByName />)
  expect(container.querySelector('svg')).toBeNull()
})
test('icon source does not contain a computed package import or catalog context', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../lobe-icon.tsx'), 'utf8')
  const payments = readFileSync(resolve(import.meta.dirname, '../../components/react-icon-by-name.tsx'), 'utf8')
  expect(source).not.toContain('import(')
  expect(source).not.toContain('/es/toc')
  expect(payments).not.toContain('import(')
})
