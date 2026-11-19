import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test } from 'vitest'

import { sanitizeAuthRedirect } from '@/features/auth/lib/auth-redirect'
import { useSystemConfig } from '@/hooks/use-system-config'
import { ACCOUNT_LITE_PATH, DEFAULT_LOGO, DEFAULT_SYSTEM_NAME } from '@/lib/constants'
import { internalRedirect } from '@/lib/internal-redirect'
import { useSystemConfigStore } from '@/stores/system-config-store'

afterEach(() => {
  cleanup()
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  window.localStorage.clear()
})

test('legacy service branding cannot replace the client name or logo; currency remains untouched', () => {
  const store = useSystemConfigStore.getState()
  const currency = { ...store.config.currency, quotaPerUnit: 7300000, usdExchangeRate: 7.3, quotaDisplayType: 'CNY' as const }
  store.setConfig({ systemName: 'PIKNO AI', logo: '/pikno-logo.png', currency })
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const result = renderHook(() => useSystemConfig(), { wrapper })
  expect(result.result.current.systemName).toBe(DEFAULT_SYSTEM_NAME)
  expect(result.result.current.logo).toBe(DEFAULT_LOGO)
  expect(result.result.current.currency).toEqual(currency)
  expect(useSystemConfigStore.getState().config.systemName).toBe('PIKNO AI')
  client.clear()
})

test('only the exact standalone account entry uses a document reload after safe redirect validation', () => {
  const origin = 'https://relay.example.com'
  const safe = sanitizeAuthRedirect(`https://relay.example.com${ACCOUNT_LITE_PATH}`, origin)
  expect(safe).toBe(ACCOUNT_LITE_PATH)
  if (safe === null) throw new Error('Account entry must be a safe internal redirect')
  expect(internalRedirect(safe).options).toMatchObject({ href: ACCOUNT_LITE_PATH, reloadDocument: true, replace: true })
  expect(internalRedirect('/pricing?view=card#models').options).toMatchObject({ to: '/pricing', search: { view: 'card' }, hash: 'models' })
  expect(() => internalRedirect(`${ACCOUNT_LITE_PATH}?other=1`)).toThrow('Invalid account destination')
  expect(internalRedirect(`${ACCOUNT_LITE_PATH}?tab=usage`).options).toMatchObject({ href: `${ACCOUNT_LITE_PATH}?tab=usage`, reloadDocument: true })
  expect(sanitizeAuthRedirect(`https://attacker.example${ACCOUNT_LITE_PATH}`, origin)).toBeNull()
  expect(sanitizeAuthRedirect(`//attacker.example${ACCOUNT_LITE_PATH}`, origin)).toBeNull()
})
