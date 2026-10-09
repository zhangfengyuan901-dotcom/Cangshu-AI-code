import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTablePagination,
  StaticDataTable,
  type StaticDataTableColumn,
} from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { toIntlLocale } from '@/i18n/languages'

import { settlementCny, settlementLabels } from './amount'
import { getSettlement, getSettlements, type Settlement } from './api'
import { SettlementReview } from './review'

function SettlementDetail(props: { admin: boolean; id: string }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['pikno-settlements', props.admin, props.id],
    queryFn: () => getSettlement(props.admin, props.id),
    retry: false,
  })
  if (detail.isPending) return <LoadingState />
  if (detail.isError) {
    return <ErrorState onRetry={() => void detail.refetch()} />
  }
  const order = detail.data.order
  return (
    <Card>
      <CardHeader>
        <CardTitle className='break-all'>{order.order_id}</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-6'>
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
        {props.admin && 'price_mode' in order && (
          <>
            <dl className='grid gap-2 text-sm'>
              <dt>{t('Accepted quote')}</dt>
              <dd>{settlementCny(order.quote_quota, locale)}</dd>
              <dt>{t('Private upstream account fingerprint')}</dt>
              <dd className='break-all'>{order.account_ref}</dd>
              <dt>{t('Review status')}</dt>
              <dd>{order.review_reason || '—'}</dd>
              <dt>{t('Next review reminder')}</dt>
              <dd>
                {order.review_due_at
                  ? new Date(order.review_due_at * 1000).toLocaleString(locale)
                  : '—'}
              </dd>
            </dl>
            <SettlementReview
              key={`${order.order_id}-${order.version}`}
              order={order}
              onComplete={() =>
                void client.invalidateQueries({
                  queryKey: ['pikno-settlements'],
                })
              }
            />
            {detail.data.events
              .filter((event) => event.reason || event.evidence)
              .map((event) => (
                <details key={event.id}>
                  <summary>
                    {t('Private review record')} #{event.id}
                  </summary>
                  <p className='break-words'>{event.reason}</p>
                  <pre className='overflow-auto text-xs break-all whitespace-pre-wrap'>
                    {event.evidence}
                  </pre>
                </details>
              ))}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function SettlementsPage(props: { admin?: boolean }) {
  const admin = props.admin ?? false
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const [review, setReview] = useState(admin)
  const [selected, setSelected] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['pikno-settlements', admin, pagination.pageIndex, review],
    queryFn: () => getSettlements(admin, pagination.pageIndex + 1, review),
    retry: false,
  })
  const columns: StaticDataTableColumn<Settlement>[] = [
    {
      id: 'order',
      header: t('Order'),
      cell: (order) => (
        <Button variant='link' onClick={() => setSelected(order.order_id)}>
          {order.order_id}
        </Button>
      ),
    },
    { id: 'model', header: t('Model'), cell: (order) => order.model },
    {
      id: 'generation',
      header: t('Generation result'),
      cell: (order) =>
        t(settlementLabels[order.generation_state] ?? order.generation_state),
    },
    {
      id: 'state',
      header: t('Financial status'),
      cell: (order) => (
        <Badge variant='outline'>
          {t(settlementLabels[order.financial_state] ?? order.financial_state)}
        </Badge>
      ),
    },
    {
      id: 'reserved',
      header: t('Reserved funds'),
      cell: (order) => settlementCny(order.reserved_quota, locale),
    },
    {
      id: 'net',
      header: t('Net consumption'),
      cell: (order) => settlementCny(order.net_quota, locale),
    },
    {
      id: 'refund',
      header: t('Total refunded'),
      cell: (order) => settlementCny(order.refunded_quota, locale),
    },
  ]
  const table = useReactTable({
    data: query.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: query.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {admin ? t('Settlement review') : t('Settlements')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='flex flex-col gap-4'>
          <Alert>
            <AlertTitle>{t('Reservation is not final consumption')}</AlertTitle>
            <AlertDescription>
              {t(
                'New video orders charge the locked quote on confirmed success and release all reserved funds on confirmed failure. Unknown results remain reserved for follow-up. Flare costs CNY 0.10 per successful image. Historical orders keep their original rules.'
              )}
            </AlertDescription>
          </Alert>
          {admin && (
            <Field orientation='horizontal'>
              <Switch
                id='pending-only'
                checked={review}
                onCheckedChange={(value) => {
                  setReview(value)
                  setPagination({ pageIndex: 0, pageSize: 20 })
                  setSelected(null)
                }}
              />
              <FieldLabel htmlFor='pending-only'>
                {t('Only orders requiring review')}
              </FieldLabel>
            </Field>
          )}
          {query.isPending && <LoadingState />}
          {query.isError && <ErrorState onRetry={() => void query.refetch()} />}
          {query.data && (
            <>
              <StaticDataTable
                columns={columns}
                data={query.data.items}
                getRowKey={(row) => row.order_id}
                emptyContent={<EmptyState title={t('No settlement orders')} />}
              />
              <DataTablePagination table={table} compact />
            </>
          )}
          {selected && (
            <SettlementDetail key={selected} admin={admin} id={selected} />
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

export function SettlementAdminPage() {
  return <SettlementsPage admin />
}
