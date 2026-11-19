export const FIXED_CNY_AMOUNTS = [50, 100, 200] as const

export function isFixedCnyAmount(amount: number): boolean {
  return FIXED_CNY_AMOUNTS.some((value) => value === amount)
}

export function isFixedCnyQuote(amount: number, quote: number): boolean {
  return isFixedCnyAmount(amount) && quote === amount
}
