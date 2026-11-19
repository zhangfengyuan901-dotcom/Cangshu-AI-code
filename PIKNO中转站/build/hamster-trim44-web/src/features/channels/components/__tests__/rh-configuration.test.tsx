import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { PiknoRHConfigDialog } from '../pikno-rh-config-dialog'

const { requestVerification } = vi.hoisted(() => ({
  requestVerification: vi.fn(),
}))

vi.mock('@/features/auth/secure-verification', () => ({
  useSecureVerification: () => ({
    requestVerification,
    isActive: false,
    dialogProps: {},
  }),
  SecureVerificationDialog: () => null,
}))

const rhKey = 'rh_test_123456789012345678901234'
const rhKeyHash =
  'e8e1faf2ca93c6c05b80d59adc996d07ed2076f89ab99e1decc2c4673764934a'

let queryClient: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  requestVerification.mockResolvedValue({ proof_token: 'single-use-proof' })
})

function view() {
  return (
    <QueryClientProvider client={queryClient}>
      <PiknoRHConfigDialog open onOpenChange={() => {}} />
    </QueryClientProvider>
  )
}

test('saving binds step-up to the Key hash and clears every client-side Key value', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        configured: false,
        enabled: false,
        ready: false,
        version: '',
        updated_at: '',
      },
    },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        configured: true,
        enabled: true,
        ready: true,
        version: 'a'.repeat(32),
        updated_at: '2026-10-13T00:00:00.000Z',
        authorization_valid: true,
      },
    },
  })
  const user = userEvent.setup()
  render(view())

  const input = await screen.findByLabelText('RH API Key')
  await user.type(input, rhKey)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Verify and save to cloud' })
    ).toBeEnabled()
  )
  await user.click(
    screen.getByRole('button', { name: 'Verify and save to cloud' })
  )

  await waitFor(() => expect(input).toHaveValue(''))
  expect(requestVerification).toHaveBeenCalledWith({
    scope: 'pikno.rh.configure',
    context: { key_hash: rhKeyHash, expected_version: '' },
    title: 'Verify RH configuration change',
  })
  expect(post).toHaveBeenCalledWith(
    '/api/pikno/rh-config',
    { api_key: rhKey, expected_version: '' },
    expect.objectContaining({
      singleUseAuthorization: true,
      headers: { 'X-Security-Proof': 'single-use-proof' },
    })
  )

  const retainedState = JSON.stringify(
    queryClient.getMutationCache().getAll().map((mutation) => mutation.state)
  )
  expect(retainedState).not.toContain(rhKey)
  expect(localStorage.getItem(rhKey)).toBeNull()
  expect(JSON.stringify(localStorage)).not.toContain(rhKey)
  expect(JSON.stringify(sessionStorage)).not.toContain(rhKey)
  expect(document.body.innerHTML).not.toContain(rhKey)
})

test('failed saves replace request errors and the read-only check never runs a workflow', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        configured: true,
        enabled: true,
        ready: true,
        version: 'b'.repeat(32),
        updated_at: '2026-10-13T00:00:00.000Z',
      },
    },
  })
  const post = vi.spyOn(api, 'post').mockImplementation((url) => {
    if (url === '/api/pikno/rh-config') {
      return Promise.reject(new Error(`unsafe request body: ${rhKey}`))
    }
    return Promise.resolve({
      data: {
        success: true,
        data: {
          configured: true,
          enabled: true,
          ready: true,
          version: 'b'.repeat(32),
          updated_at: '2026-10-13T00:00:00.000Z',
          authorization_valid: true,
        },
      },
    })
  })
  const user = userEvent.setup()
  render(view())

  const input = await screen.findByLabelText('RH API Key')
  await user.type(input, rhKey)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Verify and save to cloud' })
    ).toBeEnabled()
  )
  await user.click(
    screen.getByRole('button', { name: 'Verify and save to cloud' })
  )
  await screen.findByText('Refresh status before trying again. A failed configuration check does not submit a generation task.')
  await waitFor(() => expect(input).toHaveValue(''))

  const retainedState = JSON.stringify(
    queryClient.getMutationCache().getAll().map((mutation) => mutation.state)
  )
  expect(retainedState).not.toContain(rhKey)
  expect(document.body.innerHTML).not.toContain(rhKey)

  await user.click(
    screen.getByRole('button', { name: 'Check saved RH authorization' })
  )
  await screen.findByText(
    'Read-only RH authorization passed. Workflow execution is not yet verified.'
  )
  expect(post).toHaveBeenCalledWith(
    '/api/pikno/rh-config/check',
    undefined,
    expect.objectContaining({ skipBusinessError: true })
  )
  expect(
    post.mock.calls.some(([url]) => String(url).includes('workflow'))
  ).toBe(false)
})
