import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
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
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { formatNumber } from '@/lib/format'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { getCatalog } from './api'
import { CatalogModelCard, CatalogPrices } from './model-card'
import type { CatalogModel } from './types'

export function CatalogDirectory(props: { onAvailable: () => void }) {
  const { t } = useTranslation()
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  const catalog = useQuery({
    queryKey: ['pikno-catalog'],
    queryFn: getCatalog,
    staleTime: 300000,
    retry: 1,
  })
  return (
    <PublicLayout>
      <div className='mx-auto max-w-7xl space-y-5 py-5'>
        <header className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-semibold'>{t('Models & Pricing')}</h1>
            <p className='text-muted-foreground mt-2 text-sm'>
              {t(
                'Browse the catalog. Publication does not enable a model or change billing.'
              )}
            </p>
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button onClick={props.onAvailable}>
              {t('Available models & billing')}
            </Button>
            {role >= ROLE.SUPER_ADMIN && (
              <Button
                role='link'
                variant='outline'
                render={<Link to='/catalog-admin' />}
              >
                {t('Catalog management')}
              </Button>
            )}
          </div>
        </header>
        {catalog.isPending && <Skeleton className='h-64 w-full' />}
        {catalog.isError && (
          <ErrorState
            title={t('Unable to load model catalog')}
            onRetry={() => void catalog.refetch()}
          />
        )}
        {catalog.data && (
          <>
            <p className='text-muted-foreground text-xs'>
              {t('Catalog updated')}:{' '}
              {catalog.data.fetched_at || t('Not published')}
            </p>
            <CatalogList models={catalog.data.models} />
          </>
        )}
      </div>
    </PublicLayout>
  )
}

export function CatalogList(props: {
  models: CatalogModel[]
  admin?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<CatalogModel | null>(null)
  const filtered = useMemo(
    () =>
      props.models.filter(
        (model) =>
          (provider === 'all' || model.provider === provider) &&
          `${model.name} ${model.id}`
            .toLowerCase()
            .includes(search.toLowerCase().trim())
      ),
    [props.models, provider, search]
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
              onDetails={setSelected}
              admin={props.admin}
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
            'Upstream parameters are informational, not a promise of gateway support.'
          )}
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
        >
          <div className='space-y-4'>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Awaiting validation. Use the available-model list and PIKNO guide before making requests.'
              )}
            </p>
            <CatalogPrices prices={selected.prices} admin={props.admin} />
            {selected.reference_surcharge_cny > 0 && (
              <p>
                {t('Video reference surcharge (CNY)')}: ¥
                {formatLocalCurrencyAmount(selected.reference_surcharge_cny, {
                  showSymbol: false,
                  locale,
                  digitsLarge: 6,
                  digitsSmall: 6,
                })}
              </p>
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
