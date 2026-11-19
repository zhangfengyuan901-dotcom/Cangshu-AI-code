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
import type { LineConfig, LineSyncOverview, LineSyncStatus } from './types'
import { adapterIssueLabel } from './price-status'
import { isRetiredUpstream } from '@/lib/retired-upstreams'

const providerNames = { sanbao: '三宝（已下架）', canseedream: 'CanSeeDream' }
const states = {
  ready: '同步正常', error: '同步失败，正在重试',
  stale: '目录未能及时验证', syncing: '正在同步',
}
const pauseReasons: Record<string, string> = {
  disabled: '上游已关闭此线路',
  missing: '连续三次有效同步未发现此线路',
  stale: '超过十分钟未能验证上游目录',
  adapter_invalid: '模型适配能力需要核对',
  price_changed: '计费方式或价格规格需要核对',
  schema_changed: '上游规格或客户售价需要核对',
  runtime_not_ready: '当前运行版本尚未就绪',
}
const costReasons: Record<string, string> = {
  missing_cost: '上游未提供成本',
  invalid_cost: '上游成本数值无效',
  conflicting_cost: '上游成本字段相互冲突',
  invalid_exchange_rate: '上游积分换算比例无效',
  reference_cost_unknown: '参考素材附加成本不明确',
}
const billingReasons: Record<string, string> = {
  unknown_billing_unit: '上游未声明计费单位，暂不能开放',
  invalid_billing_unit: '上游计费单位无效，暂不能开放',
  unknown_price_spec: '上游未声明有效价格规格，暂不能开放',
}

function reasonLabel(reasons: Record<string, string>, code: string, fallback: string): string {
  return Object.hasOwn(reasons, code) ? reasons[code] : fallback
}
function time(value: number) {
  return Number.isSafeInteger(value) && value > 0
    ? new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '尚无成功记录'
}

export function SyncOverview({ status }: { status?: LineSyncOverview | null }) {
  if (!status) return null
  return <section aria-label='线路自动同步状态' className='space-y-3 rounded-lg border p-4 text-sm'>
    <p className='font-medium'>{status.enabled ? '自动同步已启用' : '自动同步未启用'}</p>
    <p className='text-muted-foreground'>每分钟检查上游。新增线路需手动开放，客户售价保持不变。</p>
    <div className='grid gap-3 sm:grid-cols-2'>
      {status.providers.filter((provider) => !isRetiredUpstream(provider.provider)).map((provider) => <div key={provider.provider} className='rounded-md border p-3'>
        <p>{providerNames[provider.provider] ?? '视频服务'} · {states[provider.state] ?? '状态待确认'}</p>
        <p className='text-muted-foreground mt-1 text-xs'>上次验证：{time(provider.last_verified_at)}</p>
      </div>)}
    </div>
  </section>
}

export function LineSyncNotices({ status, config }: { status?: LineSyncStatus | null; config?: LineConfig | null }) {
  if (!status && !config) return null
  const costIssue = status?.cost_issue_code ?? config?.cost_issue_code ?? ''
  const billingIssue = status?.billing_issue_code ?? config?.billing_issue_code ?? ''
  const adapterIssue = status?.adapter_issue ?? ''
  let pauseReason = reasonLabel(pauseReasons, status?.pause_reason ?? '', '线路状态需要核对')
  if (status?.pause_reason === 'adapter_invalid') {
    pauseReason = adapterIssueLabel(adapterIssue)
  } else if (status?.pause_reason === 'billing_unknown' || (status?.pause_reason === 'price_changed' && billingIssue)) {
    pauseReason = reasonLabel(billingReasons, billingIssue, '计费单位或价格规格需要核对，暂不能开放')
  }
  return <div className='space-y-2 text-xs' aria-live='polite'>
    {status?.paused && <p className='text-destructive rounded-md border p-3'>
      已暂停新任务：{pauseReason}。已提交任务继续查询原结果。
    </p>}
    {costIssue && <p className='rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900'>
      成本提醒：{reasonLabel(costReasons, costIssue, '上游成本信息需要核对')}。客户售价保持不变。
    </p>}
    {status?.cost_changed && <p className='rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900'>
      上游成本有变化，客户售价保持不变，请核对。
    </p>}
    {!status?.paused && billingIssue && <p className='text-destructive'>
      {reasonLabel(billingReasons, billingIssue, '计费单位或价格规格需要核对，暂不能开放')}。
    </p>}
    {!status?.paused && adapterIssue && <p className='text-destructive'>
      {adapterIssueLabel(adapterIssue)}。
    </p>}
    {!status?.paused && !billingIssue && !costIssue && status?.price_issue && <p className='text-destructive'>
      价格或计费单位需要核对。
    </p>}
  </div>
}
