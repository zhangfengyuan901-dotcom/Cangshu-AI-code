import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PublicLayout } from '@/components/layout/components/public-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CustomerModelAccess } from '@/features/pricing/components/customer-model-access'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import { getCatalog } from './api'
import { CatalogModelCard, CatalogPrices } from './model-card'
import { startCatalogRefresh } from './refresh'
import type { CatalogModel } from './types'

export function CatalogDirectory() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [unverified, setUnverified] = useState(false)
  const refresh = useRef<ReturnType<typeof startCatalogRefresh> | null>(null)
  const catalog = useQuery({
    queryKey: ['pikno-catalog'],
    queryFn: ({ signal }) => getCatalog(signal),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorToast: false, globalErrorPage: false },
  })
  useEffect(() => {
    const controller = startCatalogRefresh({
      read: () => queryClient.refetchQueries(
        { queryKey: ['pikno-catalog'], exact: true, type: 'active' },
        { cancelRefetch: false, throwOnError: true }
      ),
      state: () => {
        const state = queryClient.getQueryState(['pikno-catalog'])
        return {
          isFetching: state?.fetchStatus === 'fetching',
          lastSuccessAt: state?.dataUpdatedAt ?? 0,
          lastErrorAt: state?.errorUpdatedAt ?? 0,
          error: state?.error,
        }
      },
      onUnverified: () => setUnverified(true),
      onVerified: () => setUnverified(false),
    })
    refresh.current = controller
    return () => {
      controller.dispose()
      refresh.current = null
    }
  }, [queryClient])
  const needsUpdate = unverified || catalog.isError || catalog.isFetching || navigator.onLine === false
  return (
    <PublicLayout>
      <div className='mx-auto max-w-7xl space-y-5 py-5'>
        <header>
          <div>
            <h1 className='text-2xl font-semibold'>{t('Available models')}</h1>
            <p className='text-muted-foreground mt-2 text-sm'>
              {t(
                'Only published lines are shown. Use your PIKNO API key to call them.'
              )}
            </p>
          </div>
        </header>
        {catalog.isPending && <Skeleton className='h-64 w-full' />}
        {catalog.isError && !catalog.data && (
          <ErrorState
            title={t('Unable to load model catalog')}
            onRetry={() => refresh.current?.refresh()}
          />
        )}
        {catalog.data && (
          <>
            {needsUpdate && (
              <div role='status' className='text-muted-foreground flex flex-wrap items-center gap-2 text-sm'>
                <span>{t('目录待更新，当前内容仅供参考。')}</span>
                <Button variant='outline' size='sm' disabled={catalog.isFetching} onClick={() => refresh.current?.refresh()}>
                  {t('Retry')}
                </Button>
              </div>
            )}
            <p className='text-muted-foreground text-xs'>
              {t('Catalog updated')}:{' '}
              {catalog.data.fetched_at || t('Not published')}
            </p>
            <CatalogList models={catalog.data.models} unverified={needsUpdate} />
          </>
        )}
      </div>
    </PublicLayout>
  )
}

export function CatalogList(props: {
  models: CatalogModel[]
  admin?: boolean
  unverified?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = props.models.find((model) => model.id === selectedId) ?? null
  useEffect(() => {
    if (selectedId != null && selected == null) setSelectedId(null)
  }, [selected, selectedId])
  const filtered = useMemo(
    () =>
      props.models.filter(
        (model) =>
          (!props.admin || provider === 'all' || model.provider === provider) &&
          `${model.name} ${model.id}`
            .toLowerCase()
            .includes(search.toLowerCase().trim())
      ),
    [props.admin, props.models, provider, search]
  )
  const pages = Math.max(1, Math.ceil(filtered.length / 12))
  const current = Math.min(page, pages)
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <Input
          className='w-full sm:max-w-sm'
          aria-label={t('Search models')}
          placeholder={t('Search models')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(1)
          }}
        />
        {props.admin && (
          <ToggleGroup
            value={[provider]}
            onValueChange={(values) => {
              if (values[0]) {
                setProvider(values[0])
                setPage(1)
              }
            }}
            variant='outline'
            aria-label={t('Provider')}
          >
            {['all', 'packy', 'sanbao', 'canseedream'].map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {value === 'all' ? t('All') : value}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <span className='text-muted-foreground text-sm'>
          {formatNumber(filtered.length, locale)} {t('models')}
        </span>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title={t('No catalog models found')}
          description={t(
            'The catalog may be unpublished, or no models match these filters.'
          )}
        />
      ) : (
        <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
          {filtered.slice((current - 1) * 12, current * 12).map((model) => (
            <CatalogModelCard
              key={model.id}
              model={model}
              onDetails={(model) => setSelectedId(model.id)}
              admin={props.admin}
              unverified={props.unverified}
            />
          ))}
        </div>
      )}
      {pages > 1 && (
        <Pagination
          aria-label={t('Catalog pages')}
          className='flex items-center justify-between gap-2'
        >
          <Button
            variant='outline'
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
          >
            {t('Previous page')}
          </Button>
          <span>
            {t('Page {{current}} of {{total}}', { current, total: pages })}
          </span>
          <Button
            variant='outline'
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          >
            {t('Next page')}
          </Button>
        </Pagination>
      )}
      {selected && (
        <Dialog
          open
          title={selected.name}
          description={t(
            'Published parameters supported by the PIKNO gateway.'
          )}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null)
          }}
        >
          <div className='space-y-4'>
            {props.unverified && (
              <p role='status' className='text-muted-foreground text-sm'>
                {t('目录待更新，当前内容仅供参考。')}
              </p>
            )}
            {props.admin && (
              <CatalogPrices prices={selected.prices ?? []} admin />
            )}
            <dl className='grid gap-3 text-sm sm:grid-cols-2'>
              <div>
                <dt>{t('Resolutions')}</dt>
                <dd className='text-muted-foreground break-words'>
                  {selected.resolutions.join(', ') || '—'}
                </dd>
              </div>
              <div>
                <dt>{t('Aspect ratios')}</dt>
                <dd className='text-muted-foreground break-words'>
                  {selected.ratios.join(', ') || '—'}
                </dd>
              </div>
              <div>
                <dt>{t('Duration (seconds)')}</dt>
                <dd className='text-muted-foreground break-words'>
                  {selected.durations
                    .map((value) => formatNumber(value, locale))
                    .join(', ') || '—'}
                </dd>
              </div>
              <div>
                <dt>{t('Reference limits: image / video / audio')}</dt>
                <dd>
                  {[
                    selected.max_images,
                    selected.max_videos,
                    selected.max_audio,
                  ]
                    .map((value) => formatNumber(value, locale))
                    .join(' / ')}
                </dd>
              </div>
            </dl>
            <CustomerModelAccess modelName={selected.id} />
          </div>
        </Dialog>
      )}
    </div>
  )
}
