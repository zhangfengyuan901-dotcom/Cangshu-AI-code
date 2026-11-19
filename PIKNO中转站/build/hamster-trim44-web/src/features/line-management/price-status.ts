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
import type { LineConfig } from './types'

const adapterReasons: Record<string, string> = {
  capabilities_missing: '上游未提供完整的分辨率或时长范围',
  duration_contract_unknown: '上游时长格式尚未适配',
  protocol_not_supported: '上游任务协议尚未适配',
  prompt_contract_unknown: '上游提示词限制尚未适配',
}

export function billingUnitLabel(unit?: string): string {
  if (unit === 'second') return '每秒'
  if (unit === 'request') return '每次'
  if (unit === 'image') return '每张'
  return '单位待核对'
}

export function linePriceUnitLabel(config: LineConfig, unit?: string): string {
  if (config.billing_issue_code) return '单位待核对'
  return billingUnitLabel(config.billing_unit ?? unit)
}

export function adapterIssueLabel(code?: string): string {
  return code && Object.hasOwn(adapterReasons, code)
    ? adapterReasons[code]
    : '上游任务协议需要核对'
}

export function lineBillingBlocked(config: LineConfig): boolean {
  return Boolean(config.billing_issue_code) ||
    (config.billing_unit !== undefined && billingUnitLabel(config.billing_unit) === '单位待核对') ||
    config.prices.some((price) => billingUnitLabel(price.unit) === '单位待核对')
}
