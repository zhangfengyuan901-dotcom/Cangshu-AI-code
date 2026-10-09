import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { SettlementsPage } from '.'
import { parseSettlementCny, settlementCny } from './amount'
import {
  applySettlement,
  getSettlement,
  getSettlements,
  previewSettlement,
  type AdminSettlement,
} from './api'
import { SettlementReview } from './review'

vi.mock('./api', () => ({
  getSettlements: vi.fn(),
  getSettlement: vi.fn(),
  previewSettlement: vi.fn(),
  applySettlement: vi.fn(),
}))
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('@/features/auth/secure-verification', () => ({
  useSecureVerification: () => ({
    requestVerification: verify,
    isActive: false,
    dialogProps: {},
  }),
  SecureVerificationDialog: () => null,
}))

const order: AdminSettlement = {
  order_id: 'own-order',
  model: 'video',
  created_at: 100,
  generation_state: 'failed',
  financial_state: 'pending_review',
  reserved_quota: 1520000,
  net_quota: 0,
  refunded_quota: 0,
  version: 2,
  review_required: true,
  user_id: 2,
  price_mode: 'cost_x2',
  quote_quota: 1520000,
  account_ref: 'private-account',
  upstream_task_id: 'private-task',
  net_cost_quota: 0,
  charged_quota: 0,
  upstream_refunded_quota: 0,
  review_reason: 'internal-only',
  review_due_at: 200,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSettlements).mockResolvedValue({ items: [order], total: 1 })
  vi.mocked(getSettlement).mockResolvedValue({
    order,
    events: [
      {
        id: 1,
        action: 'reserve',
        wallet_delta: -1520000,
        net_quota: 0,
        reserved_quota: 1520000,
        financial_state: 'reserved',
        created_at: 100,
        reason: 'private reason',
        evidence: 'private receipt',
      },
    ],
  })
  vi.mocked(previewSettlement).mockResolvedValue({
    order_id: order.order_id,
    version: 2,
    digest: 'a'.repeat(64),
    before_reserved: 1520000,
    before_net: 0,
    after_reserved: 0,
    after_net: 760000,
    wallet_delta: 760000,
    state: 'settled',
    review_required: false,
  })
  verify.mockResolvedValue({ proof_token: 'one-time-proof' })
})

test('CNY parsing is exact and rejects fractional quota, negative, exponent and overflow', () => {
  expect(parseSettlementCny('0.000001')).toBe(1)
  expect(parseSettlementCny('0.76')).toBe(760000)
  expect(parseSettlementCny('2147.483647')).toBe(2147483647)
  for (const value of [
    '-1',
    '1e2',
    'NaN',
    '0.0000001',
    '2147.483648',
    '1,000',
    '',
  ]) {
    expect(parseSettlementCny(value)).toBeNaN()
  }
  expect(settlementCny(100000, 'en-US')).toMatch(/^¥0\.1/)
  expect(settlementCny(100000, 'en-US')).not.toContain('$')
})

test('customer sees own reservation and ledger without review controls or private evidence', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <SettlementsPage />
    </QueryClientProvider>
  )
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'own-order' }))
  await screen.findByText('Reserve funds')
  expect(getSettlements).toHaveBeenCalledWith(false, 1, false)
  expect(getSettlement).toHaveBeenCalledWith(false, 'own-order')
  expect(screen.getByText('Pending financial review')).toBeInTheDocument()
  for (const text of [
    'Review action',
    'Private review record',
    'private-account',
    'private receipt',
    'private reason',
    'internal-only',
  ]) {
    expect(screen.queryByText(text)).not.toBeInTheDocument()
  }
})

test('new video reviews need result evidence, not a billed cost; refunds retain cost evidence', async () => {
  render(
    <SettlementReview
      order={{ ...order, price_mode: 'video_success_quote' }}
      onComplete={vi.fn()}
    />
  )
  const user = userEvent.setup()
  await user.selectOptions(screen.getByLabelText('Review action'), 'failure')
  expect(
    screen.getByLabelText('Private receipt reference (no API keys)')
  ).toBeInTheDocument()
  expect(
    screen.queryByLabelText('Confirmed upstream debit (CNY)')
  ).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('Review action'), 'refund')
  expect(
    screen.getByLabelText('Confirmed upstream debit (CNY)')
  ).toBeInTheDocument()
  expect(
    screen.queryByLabelText('Cumulative customer refund (CNY)')
  ).not.toBeInTheDocument()
})

test.each([true, false])(
  'review requires preview and a transaction-bound proof; verification allowed=%s',
  async (allowed) => {
    verify.mockResolvedValue(allowed ? { proof_token: 'one-time-proof' } : null)
    const complete = vi.fn()
    render(<SettlementReview order={order} onComplete={complete} />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Review action'), 'failure')
    await user.type(
      screen.getByLabelText('Private receipt reference (no API keys)'),
      'receipt-hash'
    )
    await user.clear(screen.getByLabelText('Confirmed upstream debit (CNY)'))
    await user.type(
      screen.getByLabelText('Confirmed upstream debit (CNY)'),
      '0.76'
    )
    await user.type(
      screen.getByLabelText('Review reason'),
      'Confirmed upstream debit'
    )
    await user.click(
      screen.getByRole('button', { name: 'Preview settlement difference' })
    )
    await screen.findByRole('button', { name: 'Verify and submit' })
    expect(applySettlement).not.toHaveBeenCalled()
    expect(previewSettlement).toHaveBeenCalledWith(
      'own-order',
      expect.objectContaining({
        version: 2,
        action: 'failure',
        charged_quota: 760000,
      })
    )
    await user.click(screen.getByRole('button', { name: 'Verify and submit' }))
    await waitFor(() => expect(complete).toHaveBeenCalled())
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'pikno.settlement.review',
        context: { digest: 'a'.repeat(64) },
      })
    )
    if (allowed) {
      expect(applySettlement).toHaveBeenCalledWith(
        'own-order',
        vi.mocked(previewSettlement).mock.calls[0][1],
        'one-time-proof'
      )
    } else expect(applySettlement).not.toHaveBeenCalled()
  }
)
