import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { RechargeFormCard } from '../components/recharge-form-card'
import { PaymentConfirmDialog } from '../components/dialogs/payment-confirm-dialog'

const props: ComponentProps<typeof RechargeFormCard> = {
  topupInfo: {
    fixed_cny_topup: true,
    enable_online_topup: true,
    enable_stripe_topup: false,
    enable_redemption: false,
    pay_methods: [{ type: 'alipay', name: 'Alipay' }, { type: 'wxpay', name: 'WeChat Pay' }],
    min_topup: 50,
    stripe_min_topup: 1,
    amount_options: [50, 100, 200],
    discount: {},
  },
  presetAmounts: [{ value: 50 }, { value: 100 }, { value: 200 }, { value: 999 }],
  selectedPreset: 50,
  onSelectPreset: vi.fn(),
  topupAmount: 50,
  onTopupAmountChange: vi.fn(),
  paymentAmount: 50,
  calculating: false,
  onPaymentMethodSelect: vi.fn(),
  paymentLoading: null,
  redemptionCode: '',
  onRedemptionCodeChange: vi.fn(),
  onRedeem: vi.fn(),
  redeeming: false,
  priceRatio: 7.3,
  usdExchangeRate: 7.3,
}

test('shows only the three CNY tiers and has no custom amount field even with USD conversion configured', async () => {
  render(<RechargeFormCard {...props} />)
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  expect(screen.queryByText('Custom Amount')).not.toBeInTheDocument()
  expect(screen.queryByText(/365|730|1460|999|\$/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /¥50\s*CNY balance credit/ })).toHaveAttribute('aria-pressed', 'true')
  const user = userEvent.setup()
  screen.getByRole('button', { name: /¥100\s*CNY balance credit/ }).focus()
  await user.keyboard('{Enter}')
  expect(props.onSelectPreset).toHaveBeenCalledWith({ value: 100 })
  expect(screen.getByRole('button', { name: /¥200\s*CNY balance credit/ })).toBeEnabled()
})

test.each([{ paymentAmount: 365 }, { calculating: true }, { topupInfo: { ...props.topupInfo!, fixed_cny_topup: false } }])('blocks checkout when the server quote or capability is not ready: %j', (override) => {
  render(<RechargeFormCard {...props} {...override} />)
  expect(screen.getByRole('button', { name: /^Alipay/ })).toBeDisabled()
})

test('confirmation displays CNY and refuses a mismatched quote', () => {
  render(<PaymentConfirmDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} topupAmount={50} paymentAmount={365} paymentMethod={{ type: 'alipay', name: 'Alipay' }} calculating={false} processing={false} usdExchangeRate={7.3} />)
  expect(screen.getByText('¥50')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Confirm Payment' })).toBeDisabled()
})
