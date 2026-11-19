import { formatLocalCurrencyAmount } from '@/lib/currency'

export const imageUsagePriceMode = 'pikno-image-usage-cny-v1'

// Ledger amounts are CNY quota, never USD or the current display exchange rate.
export function settlementCny(quota: number, locale?: string) {
  return `¥${formatLocalCurrencyAmount(quota / 1_000_000, {
    showSymbol: false,
    locale,
    digitsLarge: 6,
    digitsSmall: 6,
    abbreviate: false,
    compact: false,
    minimumNonZero: 0,
  })}`
}
export function parseSettlementCny(value: string): number {
  if (!/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(value)) return Number.NaN
  const [whole, fraction = ''] = value.split('.')
  const quota = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  return quota <= 2_147_483_647 ? quota : Number.NaN
}
export const settlementLabels: Record<string, string> = {
  reserved: 'Funds reserved',
  pending_review: 'Pending financial review',
  settled: 'Settled',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
  succeeded: 'Generation succeeded',
  failed: 'Generation failed',
  unknown: 'Result unconfirmed',
  reserve: 'Reserve funds',
  observe: 'Result received',
  bind: 'Task linked',
  success: 'Confirm successful settlement',
  failure: 'Confirm failed settlement',
  waive: 'Release reserved funds',
  refund: 'Record upstream refund',
  reminder: 'Review reminder',
  acknowledge: 'Acknowledge conflict without changing charges',
}
