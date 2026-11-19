import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { StaticDataTable } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { TaskArtifactsCell } from '@/features/usage-logs/components/task-artifacts'
import { toIntlLocale } from '@/i18n/languages'

import { settlementCny, settlementLabels } from './amount'
import { getSettlement, type Settlement } from './api'
import { getOrderTask } from './task-records-api'

function TaskRecordResult(props: { order: Settlement; userId?: number }) {
  const { t } = useTranslation()
  const result = useQuery({
    queryKey: ['pikno-order-task', props.userId, props.order.order_id],
    queryFn: () => getOrderTask(props.order.order_id),
    retry: false,
    meta: { errorToast: false },
  })
  if (result.isPending) return <LoadingState />
  if (result.isError) {
    return (
      <ErrorState
        title={t('Unable to load generation result')}
        description={t(
          'Financial records remain available. Retry the result lookup separately.'
        )}
        onRetry={() => void result.refetch()}
      />
    )
  }
  if (props.order.generation_state !== 'succeeded') {
    return (
      <p className='text-muted-foreground text-sm'>
        {t(
          'No confirmed successful result is available. Funds follow the financial status shown above.'
        )}
      </p>
    )
  }
  if (!result.data) {
    return (
      <p className='text-muted-foreground text-sm'>
        {t(
          'No retained result is linked to this order. Synchronous image results are returned to PIKNO; historical records are not matched by guesswork.'
        )}
      </p>
    )
  }
  if (result.data.status !== 'SUCCESS') {
    return (
      <p className='text-muted-foreground text-sm'>
        {t(
          'The task result is not ready. Refresh to check again; this does not change charges.'
        )}
      </p>
    )
  }
  return <TaskArtifactsCell log={result.data} />
}

export function TaskRecordDetail(props: { id: string; userId?: number }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const detail = useQuery({
    queryKey: ['pikno-settlements', false, props.userId, 'detail', props.id],
    queryFn: () => getSettlement(false, props.id),
    retry: false,
  })
  if (detail.isPending) return <LoadingState />
  if (detail.isError) {
    return <ErrorState onRetry={() => void detail.refetch()} />
  }
  const order = detail.data.order
  return (
    <div className='flex flex-col gap-5'>
      <div className='flex min-w-0 items-center gap-2'>
        <code className='min-w-0 flex-1 break-all'>{order.order_id}</code>
        <CopyButton value={order.order_id} aria-label={t('Copy order ID')} />
      </div>
      <dl className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
        <div>
          <dt>{t('Model')}</dt>
          <dd className='break-all'>{order.model}</dd>
        </div>
        <div>
          <dt>{t('Time')}</dt>
          <dd>{new Date(order.created_at * 1000).toLocaleString(locale)}</dd>
        </div>
        <div>
          <dt>{t('Generation result')}</dt>
          <dd>
            {t(
              settlementLabels[order.generation_state] ?? order.generation_state
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Financial status')}</dt>
          <dd>
            <Badge variant='outline'>
              {t(
                settlementLabels[order.financial_state] ?? order.financial_state
              )}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>{t('Reserved funds')}</dt>
          <dd>{settlementCny(order.reserved_quota, locale)}</dd>
        </div>
        <div>
          <dt>{t('Net consumption')}</dt>
          <dd>{settlementCny(order.net_quota, locale)}</dd>
        </div>
        <div>
          <dt>{t('Total refunded')}</dt>
          <dd>{settlementCny(order.refunded_quota, locale)}</dd>
        </div>
      </dl>
      <section aria-label={t('Generation result')}>
        <h3 className='mb-2 font-medium'>{t('Generation result')}</h3>
        <TaskRecordResult order={order} userId={props.userId} />
      </section>
      <section aria-label={t('Financial timeline')}>
        <h3 className='mb-2 font-medium'>{t('Financial timeline')}</h3>
        <StaticDataTable
          data={detail.data.events}
          getRowKey={(event) => event.id}
          columns={[
            {
              id: 'time',
              header: t('Time'),
              cell: (event) =>
                new Date(event.created_at * 1000).toLocaleString(locale),
            },
            {
              id: 'action',
              header: t('Action'),
              cell: (event) =>
                t(settlementLabels[event.action] ?? event.action),
            },
            {
              id: 'delta',
              header: t('Available balance change'),
              cell: (event) => settlementCny(event.wallet_delta, locale),
            },
            {
              id: 'net',
              header: t('Net consumption'),
              cell: (event) => settlementCny(event.net_quota, locale),
            },
          ]}
        />
      </section>
    </div>
  )
}
