import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { AUTH_SECTION_IDS } from '../auth/section-nav'
import { BILLING_SECTION_IDS } from '../billing/section-nav'
import { CONTENT_SECTION_IDS } from '../content/section-nav'
import { SITE_SECTION_IDS } from '../site/section-nav'

test('menu and route metadata exclude retired configuration sections', () => {
  expect(BILLING_SECTION_IDS).not.toContain('checkin')
  expect(CONTENT_SECTION_IDS).not.toContain('chat')
  expect(CONTENT_SECTION_IDS).not.toContain('drawing')
  expect(SITE_SECTION_IDS).toEqual(['system-info', 'notice'])
  expect(AUTH_SECTION_IDS).toEqual(expect.arrayContaining(['basic-auth', 'oauth', 'passkey']))
})
test('route guards and sidebar metadata do not import any settings form registry', () => {
  const nav = readFileSync(resolve(import.meta.dirname, '../../../components/layout/config/system-settings.config.ts'), 'utf8')
  expect(nav).not.toContain('section-registry')
  for (const folder of ['auth', 'billing', 'content', 'models', 'operations', 'request-policies', 'security', 'site']) {
    const source = readFileSync(resolve(import.meta.dirname, `../${folder}/section-nav.ts`), 'utf8')
    expect(source).not.toContain('section-registry')
    expect(source).not.toContain('.tsx')
  }
})
