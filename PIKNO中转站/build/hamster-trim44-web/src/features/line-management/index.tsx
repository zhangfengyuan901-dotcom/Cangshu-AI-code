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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Pencil, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { handleServerError } from '@/lib/handle-server-error'

import { actOnLine, getLines, syncLines, updateLine } from './api'
import type { LineConfig, LineRecord } from './types'
import { adapterIssueLabel, lineBillingBlocked, linePriceUnitLabel } from './price-status'
import { LineSyncNotices, SyncOverview } from './sync-status'
import { subscribeToCatalogChanges } from './catalog-events'
import { filterLineScope, isArchivedLine, isRetiredLine, lineScopeCounts, type LineScope } from './line-scope'

const queryKey = ['pikno-lines-admin']

function quotaToCNY(quota: number) {
  return (quota / 1_000_000).toFixed(6).replace(/\.?0+$/, '')
}

function cnyToQuota(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) {
    return null
  }
  const [whole, fraction = ''] = normalized.split('.')
  const quota = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > 2_147_483_647) {
    return null
  }
  return quota
}

function lineBlockingReasons(line: LineRecord): string[] {
  if (!line.draft && line.published?.enabled) return []
  return line.blocking_reasons.filter((reason) =>
    reason !== '尚未勾选开放线路' && reason !== '缺少线路草稿'
  ).map((reason) => {
    if (reason === '任务适配器未声明该上游模型' || reason === '任务适配器未启用') {
      return adapterIssueLabel(line.sync?.adapter_issue)
    }
    if (reason === '该快照的任务适配器尚未就绪') return '当前运行版本尚未就绪，请稍后重试'
    return reason
  })
}

function LineEditor(props: {
  line: LineRecord
  pending: boolean
  onClose: () => void
  onSave: (input: Parameters<typeof updateLine>[0]) => void
}) {
  const { t } = useTranslation()
  const source = props.line.draft ?? props.line.published
  const [name, setName] = useState(source?.name ?? '')
  const [prices, setPrices] = useState(
    source?.prices.map((price) => quotaToCNY(price.retail_quota)) ?? []
  )
  const parsedPrices = prices.map(cnyToQuota)
  const valid =
    source != null &&
    name.trim().length > 0 &&
    source.prices.length > 0 &&
    !lineBillingBlocked(source) &&
    parsedPrices.every((price) => price != null)

  if (!source) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={t('Edit line')}
      description={t(
        'Save a draft first. The active line changes only after publication.'
      )}
      footer={
        <>
          <Button
            variant='outline'
            disabled={props.pending}
            onClick={props.onClose}
          >
            {t('Cancel')}
          </Button>
          <Button
            disabled={!valid || props.pending}
            onClick={() => {
              if (!valid) return
              props.onSave({
                public_model: props.line.public_model,
                expected_version: props.line.version,
                name: name.trim(),
                prices: source.prices.map((price, index) => ({
                  resolution: price.resolution,
                  unit: price.unit,
                  retail_quota: parsedPrices[index] as number,
                })),
              })
            }}
          >
            {t('Save draft')}
          </Button>
        </>
      }
    >
      <div className='space-y-5'>
        <div className='space-y-2'>
          <Label htmlFor='line-name'>{t('Display name')}</Label>
          <Input
            id='line-name'
            value={name}
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className='space-y-3'>
          <h3 className='text-sm font-medium'>{t('Retail price')}</h3>
          {source.prices.map((price, index) => (
            <div
              key={`${price.resolution}-${price.unit}`}
              className='grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr] sm:items-end'
            >
              <div className='text-sm'>
                <p className='font-medium'>{price.resolution}</p>
                <p className='text-muted-foreground text-xs'>
                  {t('计费单位')}：{t(linePriceUnitLabel(source, price.unit))}
                </p>
                <p className='text-muted-foreground text-xs'>
                  {price.cost_cny != null && Number.isFinite(price.cost_cny) && price.cost_cny >= 0
                    ? `${t('Upstream cost')}: ¥${price.cost_cny} / ${t(linePriceUnitLabel(source, price.unit))}`
                    : t('成本待核对')}
                </p>
              </div>
              <div className='space-y-1'>
                <Label htmlFor={`line-price-${index}`}>
                  {t('Customer price (CNY)')}
                </Label>
                <Input
                  id={`line-price-${index}`}
                  inputMode='decimal'
                  value={prices[index] ?? ''}
                  aria-invalid={cnyToQuota(prices[index] ?? '') == null}
                  onChange={(event) => {
                    const next = [...prices]
                    next[index] = event.target.value
                    setPrices(next)
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

function LinePriceList({ config }: { config: LineConfig }) {
  const { t } = useTranslation()
  return (
    <div className='space-y-1 text-sm'>
      <p className='text-muted-foreground text-xs'>{t('客户售价')}</p>
      {(config.billing_unit !== undefined || config.billing_issue_code) && (
        <p className='text-muted-foreground text-xs'>
          {t('计费单位')}：{t(linePriceUnitLabel(config))}
        </p>
      )}
      {config.prices.map((price) => (
        <div
          key={`${price.resolution}-${price.unit}`}
          className='flex justify-between gap-3'
        >
          <span className='text-muted-foreground'>{price.resolution}</span>
          <span className='font-mono'>
            ¥{quotaToCNY(price.retail_quota)} / {t(linePriceUnitLabel(config, price.unit))}
          </span>
        </div>
      ))}
    </div>
  )
}

function LineCard(props: {
  line: LineRecord
  pending: boolean
  onEdit: () => void
  onConfirm: (action: 'publish' | 'disable' | 'rollback') => void
}) {
  const { t } = useTranslation()
  const visible = props.line.draft ?? props.line.published
  const retired = isRetiredLine(props.line)
  const open = props.line.published?.enabled === true
  const paused = props.line.sync?.paused === true
  const hasPendingChanges = props.line.has_pending_changes ?? props.line.draft != null
  const blockingReasons = lineBlockingReasons(props.line)
  const billingBlocked = visible != null && (
    lineBillingBlocked(visible) || Boolean(props.line.sync?.billing_issue_code)
  )
  let status = t('未开放')
  if (isArchivedLine(props.line)) {
    status = t('已下架')
  } else if (paused) {
    status = t('已暂停')
  } else if (open) {
    status = t('已开放')
  }
  if (!visible) {
    return null
  }
  return (
    <Card className='min-w-0 gap-3'>
      <CardHeader className='space-y-3'>
        <div className='flex items-start justify-between gap-2'>
          <CardTitle className='min-w-0 break-words'>{visible.name}</CardTitle>
          <Badge variant={open && !paused && !retired ? 'default' : 'outline'}>{status}</Badge>
        </div>
        <div className='flex min-w-0 items-center gap-2'>
          <code className='min-w-0 text-xs break-all'>
            {props.line.public_model}
          </code>
          <CopyButton
            value={props.line.public_model}
            tooltip={t('Copy model name')}
          />
        </div>
        <p className='text-muted-foreground text-xs'>
          {visible.kind === 'image' ? t('Image') : t('Video')} ·{' '}
          {visible.upstream_available && visible.channel_id > 0
            ? '已绑定上游连接'
            : '未绑定可用连接'}
        </p>
      </CardHeader>
      <CardContent className='flex-1 space-y-4'>
        {retired
          ? <p className='text-muted-foreground text-xs'>三宝线路已下架，仅保留历史配置。</p>
          : <LineSyncNotices status={props.line.sync} config={visible} />}
        <LinePriceList config={visible} />
        <div className='text-muted-foreground space-y-1 text-xs'>
          <p>
            {t('Resolutions')}: {visible.resolutions.join(', ') || '—'}
          </p>
          {visible.kind === 'video' && (
            <p>
              {t('Duration (seconds)')}: {visible.durations.join(', ') || '—'}
            </p>
          )}
        </div>
        {!retired && props.line.published && !hasPendingChanges && !paused && (
          <p className='text-muted-foreground text-xs'>
            {open ? t('已开放，无待生效更改') : t('未开放，无待生效更改')}
          </p>
        )}
        {!retired && blockingReasons.length > 0 && (
          <div className='border-destructive/30 bg-destructive/5 rounded-lg border p-3'>
            <p className='text-destructive text-xs font-medium'>
              {t('Cannot publish')}
            </p>
            <ul className='text-muted-foreground mt-1 list-disc space-y-1 pl-4 text-xs'>
              {blockingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {!retired && (hasPendingChanges || !open) && props.line.can_publish && !billingBlocked && (
          <p className='text-success flex items-center gap-1 text-xs'>
            <CheckCircle2 className='size-4' /> {t('Configuration is ready')}
          </p>
        )}
        <div className='flex flex-wrap gap-2 border-t pt-3'>
          {!retired && <Button
            size='sm'
            variant='outline'
            disabled={props.pending}
            onClick={props.onEdit}
          >
            <Pencil /> {t('Edit')}
          </Button>}
          {!retired && (hasPendingChanges || !open) && (
            <Button
              size='sm'
              disabled={props.pending || !props.line.can_publish || billingBlocked}
              onClick={() => props.onConfirm('publish')}
            >
              {open ? t('应用更改') : t('开放线路')}
            </Button>
          )}
          {open && (
            <Button
              size='sm'
              variant='destructive'
              disabled={props.pending}
              onClick={() => props.onConfirm('disable')}
            >
              {t('Disable line')}
            </Button>
          )}
          {!retired && props.line.previous && (
            <Button
              size='sm'
              variant='outline'
              disabled={props.pending}
              onClick={() => props.onConfirm('rollback')}
            >
              <RotateCcw /> {t('Rollback')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function LineManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey,
    queryFn: getLines,
    staleTime: 0,
    retry: 1,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  useEffect(() => subscribeToCatalogChanges(() => {
    void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false })
  }), [queryClient])
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<LineScope>('manageable')
  const [editing, setEditing] = useState<LineRecord | null>(null)
  const [confirmation, setConfirmation] = useState<{
    action: 'publish' | 'disable' | 'rollback'
    line: LineRecord
  } | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey })
  const syncMutation = useMutation({
    mutationFn: syncLines,
    onSuccess: (response) => {
      queryClient.setQueryData(queryKey, response)
      toast.success(t('Upstream lines synchronized'))
    },
    onError: (error) => handleServerError(error),
  })
  const updateMutation = useMutation({
    mutationFn: updateLine,
    onSuccess: () => {
      setEditing(null)
      void refresh()
      toast.success(t('Draft saved'))
    },
    onError: (error) => handleServerError(error),
  })
  const actionMutation = useMutation({
    mutationFn: ({
      action,
      line,
    }: {
      action: 'publish' | 'disable' | 'rollback'
      line: LineRecord
    }) => actOnLine(action, line),
    onSuccess: () => {
      setConfirmation(null)
      void refresh()
      toast.success(t('Line status updated'))
    },
    onError: (error) => {
      setConfirmation(null)
      handleServerError(error)
      void refresh()
    },
  })
  const lines = useMemo(() => query.data?.data.lines ?? [], [query.data])
  const counts = useMemo(() => lineScopeCounts(lines), [lines])
  const filtered = useMemo(() => filterLineScope(lines, scope, search), [lines, scope, search])
  const pending =
    syncMutation.isPending ||
    updateMutation.isPending ||
    actionMutation.isPending
  let confirmationTitle = '开放线路'
  if (confirmation?.line.published?.enabled) {
    confirmationTitle = '应用更改'
  }
  if (confirmation?.action === 'disable') {
    confirmationTitle = 'Disable line'
  } else if (confirmation?.action === 'rollback') {
    confirmationTitle = 'Rollback'
  }
  const confirmationDescription =
    confirmation?.action === 'disable'
      ? 'New requests will stop immediately. Submitted tasks can still finish settlement.'
      : 'This atomically changes customer visibility, routing, and the price used by new tasks. Existing tasks keep their original quote.'

  return (
    <SectionPageLayout stackActionsOnMobile>
      <SectionPageLayout.Title>{t('Line management')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          disabled={pending}
          onClick={() => syncMutation.mutate(undefined)}
        >
          <RefreshCw className={syncMutation.isPending ? 'animate-spin' : ''} />
          {t('Sync upstream lines')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-5'>
          <SyncOverview status={query.data?.data.sync} />
          <p className='text-muted-foreground text-sm'>
            {t('新增线路请设置客户售价后开放；已开放线路自动同步，客户售价保持不变。')}
          </p>
          <div className='flex flex-wrap gap-2'>
            <Input
              className='w-full sm:max-w-sm'
              value={search}
              placeholder={t('Search lines')}
              aria-label={t('Search lines')}
              onChange={(event) => setSearch(event.target.value)}
            />
            {(['manageable', 'archived', 'all'] as const).map((value) => (
              <Button
                key={value}
                variant={scope === value ? 'default' : 'outline'}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {t({ manageable: '可管理', archived: '已下架', all: '全部' }[value])} ({counts[value]})
              </Button>
            ))}
          </div>
          {query.isPending && <Skeleton className='h-72 w-full' />}
          {query.isError && (
            <ErrorState
              title={t('Unable to load lines')}
              onRetry={() => void query.refetch()}
            />
          )}
          {!query.isPending && !query.isError && filtered.length === 0 && (
            <EmptyState
              title={t('No lines found')}
              description={t(
                'Synchronize upstream lines or change the filter.'
              )}
            />
          )}
          {filtered.length > 0 && (
            <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
              {filtered.map((line) => (
                <LineCard
                  key={line.public_model}
                  line={line}
                  pending={pending}
                  onEdit={() => setEditing(line)}
                  onConfirm={(action) => setConfirmation({ action, line })}
                />
              ))}
            </div>
          )}
        </div>
        {editing && (
          <LineEditor
            key={`${editing.public_model}-${editing.version}`}
            line={editing}
            pending={updateMutation.isPending}
            onClose={() => setEditing(null)}
            onSave={(input) => updateMutation.mutate(input)}
          />
        )}
        <ConfirmDialog
          open={confirmation != null}
          onOpenChange={(open) => !open && setConfirmation(null)}
          title={t(confirmationTitle)}
          desc={t(confirmationDescription)}
          destructive={confirmation?.action === 'disable'}
          confirmText={t('Confirm operation')}
          isLoading={actionMutation.isPending}
          handleConfirm={() => {
            if (confirmation) actionMutation.mutate(confirmation)
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
