import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTablePagination,
  StaticDataTable,
  type StaticDataTableColumn,
} from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'
import { useAuthStore } from '@/stores/auth-store'

import { settlementCny, settlementLabels } from './amount'
import { getSettlements, type Settlement } from './api'
import { TaskRecordDetail } from './task-records-detail'

export function TaskRecordsPage() {
  const userId = useAuthStore((state) => state.auth.user?.id)
  return <CustomerTaskRecords key={userId} userId={userId} />
}

function CustomerTaskRecords(props: { userId?: number }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const [selected, setSelected] = useState<string | null>(null)
  const query = useQuery({
    queryKey: [
      'pikno-settlements',
      false,
      props.userId,
      'list',
      pagination.pageIndex,
    ],
    queryFn: () => getSettlements(false, pagination.pageIndex + 1, false),
    retry: false,
  })
  const refreshRecords = () => {
    void client.invalidateQueries({
      queryKey: ['pikno-settlements', false, props.userId],
    })
    void client.invalidateQueries({
      queryKey: ['pikno-order-task', props.userId],
    })
  }
  const columns: StaticDataTableColumn<Settlement>[] = [
    {
      id: 'order',
      header: t('Order'),
      cell: (order) => (
        <Button
          variant='link'
          className='h-auto max-w-64 break-all whitespace-normal'
          onClick={() => setSelected(order.order_id)}
        >
          {order.order_id}
        </Button>
      ),
    },
    {
      id: 'time',
      header: t('Time'),
      cell: (order) => new Date(order.created_at * 1000).toLocaleString(locale),
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
    onPaginationChange: (update) => {
      setSelected(null)
      setPagination(update)
    },
  })
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Task records')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          disabled={query.isFetching}
          onClick={refreshRecords}
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
                'View generation results and financial records together. Unconfirmed results remain reserved for administrator review; refreshing records never changes charges.'
              )}
            </AlertDescription>
          </Alert>
          <div className='flex flex-wrap gap-2'>
            <Button
              variant='outline'
              size='sm'
              render={
                <Link
                  to='/usage-logs/$section'
                  params={{ section: 'common' }}
                />
              }
            >
              {t('Historical billing logs')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              render={
                <Link to='/usage-logs/$section' params={{ section: 'task' }} />
              }
            >
              {t('Historical task logs')}
            </Button>
          </div>
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
            <Dialog
              open
              title={t('Task details')}
              contentClassName='sm:max-w-5xl'
              footer={
                <Button
                  variant='outline'
                  disabled={query.isFetching}
                  onClick={refreshRecords}
                >
                  {t('Refresh')}
                </Button>
              }
              onOpenChange={(open) => {
                if (!open) setSelected(null)
              }}
            >
              <TaskRecordDetail
                key={selected}
                userId={props.userId}
                id={selected}
              />
            </Dialog>
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
