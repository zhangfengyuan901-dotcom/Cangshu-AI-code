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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { LineSyncNotices, SyncOverview } from '../sync-status'
import type { LineSyncStatus } from '../types'

afterEach(cleanup)
const status = (extra: Partial<LineSyncStatus> = {}): LineSyncStatus => ({
  snapshot_hash: 'private-snapshot', last_seen_at: 0, missing_count: 0,
  paused: false, pause_reason: '', cost_changed: false, cost_changed_at: 0,
  adapter_issue: '', price_issue: false, ...extra,
})
it('keeps older servers compatible without inventing synchronization status', () => {
  const result = render(<><SyncOverview /><LineSyncNotices /></>)
  expect(result.container.textContent).toBe('')
})
it('shows provider freshness without exposing raw errors or snapshot identifiers', () => {
  render(<SyncOverview status={{ enabled: true, interval_seconds: 60, missing_threshold: 3, stale_seconds: 600,
    providers: [{ provider: 'canseedream', state: 'error', snapshot_hash: 'private-snapshot', last_attempt_at: 0,
      last_verified_at: 0, next_attempt_at: 0, error_code: 'private-raw-error' }] }} />)
  expect(screen.getByText('自动同步已启用')).toBeVisible()
  expect(screen.getByText(/尚无成功记录/)).toBeVisible()
  expect(screen.getByText(/同步失败，正在重试/)).toBeVisible()
  expect(document.body.textContent).not.toMatch(/private-snapshot|private-raw-error/)
})
it('a cost change warns without claiming the customer price changed or the line paused', () => {
  render(<LineSyncNotices status={status({ cost_changed: true })} />)
  expect(screen.getByText('上游成本有变化，客户售价保持不变，请核对。')).toBeVisible()
  expect(screen.queryByText(/已暂停新任务/)).toBeNull()
})

it('does not advertise the retired Sanbao feed in the active supplier overview', () => {
  render(<SyncOverview status={{ enabled: true, interval_seconds: 60, missing_threshold: 3, stale_seconds: 600,
    providers: ['sanbao', 'canseedream'].map((provider) => ({ provider: provider as 'sanbao' | 'canseedream',
      state: 'ready', snapshot_hash: '', last_attempt_at: 0, last_verified_at: 0, next_attempt_at: 0, error_code: '' })) }} />)
  expect(screen.getByText('CanSeeDream · 同步正常')).toBeVisible()
  expect(document.body.textContent).not.toMatch(/三宝|视频服务 A/)
})
it('a pause preserves the historical task-query promise and never echoes raw reasons', () => {
  render(<LineSyncNotices status={status({ paused: true, pause_reason: 'private-raw-error' })} />)
  expect(screen.getByText(/已暂停新任务.*已提交任务继续查询原结果/)).toBeVisible()
  expect(document.body.textContent).not.toContain('private-raw-error')
})
it('ambiguous price and adapter fields remain fixed operator-facing notices', () => {
  render(<LineSyncNotices status={status({ price_issue: true, adapter_issue: 'private-raw-error' })} />)
  expect(screen.getByText('价格或计费单位需要核对。')).toBeVisible()
  expect(document.body.textContent).not.toContain('private-raw-error')
})

it.each([
  ['missing_cost', '上游未提供成本'],
  ['invalid_cost', '上游成本数值无效'],
  ['conflicting_cost', '上游成本字段相互冲突'],
  ['invalid_exchange_rate', '上游积分换算比例无效'],
  ['reference_cost_unknown', '参考素材附加成本不明确'],
])('reports %s as a cost warning without inventing a pause or billing failure', (code, message) => {
  render(<LineSyncNotices status={status({ cost_issue_code: code, billing_unit: 'second', price_issue: true })} />)
  expect(screen.getByText(`成本提醒：${message}。客户售价保持不变。`)).toBeVisible()
  expect(screen.queryByText(/已暂停新任务|价格或计费单位需要核对/)).toBeNull()
  expect(document.body.textContent).not.toContain(code)
})

it.each([
  ['unknown_billing_unit', '上游未声明计费单位，暂不能开放'],
  ['invalid_billing_unit', '上游计费单位无效，暂不能开放'],
  ['unknown_price_spec', '上游未声明有效价格规格，暂不能开放'],
])('explains %s without guessing its missing contract', (code, message) => {
  render(<LineSyncNotices status={status({ paused: true, pause_reason: 'billing_unknown', billing_issue_code: code })} />)
  expect(screen.getByText(`已暂停新任务：${message}。已提交任务继续查询原结果。`)).toBeVisible()
  expect(document.body.textContent).not.toContain(code)
})

it('shows a concrete protocol pause and a safe fallback for unknown adapter codes', () => {
  const rendered = render(<LineSyncNotices status={status({ paused: true, pause_reason: 'adapter_invalid', adapter_issue: 'protocol_not_supported' })} />)
  expect(screen.getByText(/已暂停新任务：上游任务协议尚未适配/)).toBeVisible()
  rendered.rerender(<LineSyncNotices status={status({ paused: true, pause_reason: 'adapter_invalid', adapter_issue: 'private-raw-protocol-code' })} />)
  expect(screen.getByText(/已暂停新任务：上游任务协议需要核对/)).toBeVisible()
  expect(document.body.textContent).not.toContain('private-raw-protocol-code')
})

it('a schema pause covers specifications and customer prices rather than claiming an API format change', () => {
  render(<LineSyncNotices status={status({ paused: true, pause_reason: 'schema_changed' })} />)
  expect(screen.getByText(/上游规格或客户售价需要核对/)).toBeVisible()
  expect(document.body.textContent).not.toContain('接口格式')
})

it.each(['__proto__', 'constructor', 'toString'])('unknown inherited names such as %s still produce safe fixed text', (code) => {
  render(<LineSyncNotices status={status({ paused: true, pause_reason: 'adapter_invalid', adapter_issue: code, cost_issue_code: code, billing_issue_code: code })} />)
  expect(screen.getByText(/已暂停新任务：上游任务协议需要核对/)).toBeVisible()
  expect(screen.getByText('成本提醒：上游成本信息需要核对。客户售价保持不变。')).toBeVisible()
  expect(document.body.textContent).not.toContain(code)
})
