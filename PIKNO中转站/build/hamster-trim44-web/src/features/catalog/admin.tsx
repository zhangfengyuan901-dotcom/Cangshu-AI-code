import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { handleServerError } from '@/lib/handle-server-error'

import { changeCatalog, getCatalogAdmin } from './api'
import { CatalogList } from './directory'
import { CatalogPrices } from './model-card'
import type { CatalogChange, CatalogModel } from './types'

const queryKey = ['pikno-catalog-admin']

function ChangeDetails({ change }: { change: CatalogChange }) {
  const { t } = useTranslation()
  const summary = (model: CatalogModel) => (
    <>
      <p className='break-words'>{model.name}</p>
      <CatalogPrices prices={model.prices ?? []} admin />
      <p>
        {model.upstream_available
          ? t('Listed upstream')
          : t('Upstream unavailable')}{' '}
        ·{' '}
        {model.price_issue
          ? t('Pricing needs review')
          : t('Reference price parsed')}
      </p>
      <p>
        {t('Resolutions')}: {model.resolutions.join(', ') || '—'}
      </p>
      <p>
        {t('Aspect ratios')}: {model.ratios.join(', ') || '—'}
      </p>
      <p>
        {t('Duration (seconds)')}: {model.durations.join(', ') || '—'}
      </p>
      <p>
        {t('Reference limits: image / video / audio')}: {model.max_images} /{' '}
        {model.max_videos} / {model.max_audio}
      </p>
      <p>
        {t('Video reference surcharge (CNY)')}: ¥
        {model.reference_surcharge_cny ?? 0}
      </p>
    </>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex flex-wrap gap-2 text-sm'>
          <code className='break-all'>{change.id}</code>
          <Badge variant='outline'>
            {t(
              {
                added: 'Added',
                changed: 'Changed',
                removed: 'Removed upstream',
              }[change.kind]
            )}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className='grid gap-4 text-xs sm:grid-cols-2'>
        <div className='space-y-2'>
          <h4 className='font-semibold'>{t('Published version')}</h4>
          {change.before ? summary(change.before) : '—'}
        </div>
        <div className='space-y-2'>
          <h4 className='font-semibold'>{t('Draft version')}</h4>
          {change.after ? summary(change.after) : '—'}
        </div>
      </CardContent>
    </Card>
  )
}

export function CatalogAdmin() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const query = useQuery({
    queryKey,
    queryFn: getCatalogAdmin,
    staleTime: 0,
    retry: 1,
  })
  const [confirmation, setConfirmation] = useState<{
    action: 'publish' | 'rollback'
    revision: string
  } | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  const mutation = useMutation({
    mutationFn: ({
      action,
      revision,
    }: {
      action: 'sync' | 'publish' | 'rollback'
      revision: string
    }) => changeCatalog(action, revision),
    onSuccess: (response, request) => {
      client.setQueryData(queryKey, response)
      setConfirmation(null)
      if (request.action !== 'sync') {
        void client.invalidateQueries({ queryKey: ['pikno-catalog'] })
      }
      toast.success(t('Catalog saved. Channels and billing are unchanged.'))
    },
    onError: (error) => {
      handleServerError(error)
      setConfirmation(null)
      void query.refetch()
    },
  })
  const state = query.data?.data
  const changes = query.data?.changes ?? []
  return (
    <SectionPageLayout stackActionsOnMobile>
      <SectionPageLayout.Title>
        {t('Catalog management')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          disabled={mutation.isPending || !state}
          onClick={() =>
            state &&
            mutation.mutate({ action: 'sync', revision: state.revision })
          }
        >
          {mutation.isPending ? t('Processing...') : t('Sync upstream catalog')}
        </Button>
        <Button
          disabled={mutation.isPending || !state?.draft}
          onClick={() =>
            state &&
            setConfirmation({ action: 'publish', revision: state.revision })
          }
        >
          {t('Publish draft')}
        </Button>
        <Button
          variant='outline'
          disabled={mutation.isPending || !state?.previous}
          onClick={() =>
            state &&
            setConfirmation({ action: 'rollback', revision: state.revision })
          }
        >
          {t('Rollback catalog')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-5'>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Sync creates a draft. Review changes before publishing. Publication never enables channels or changes active billing.'
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Video reference prices use upstream CNY cost × 2. Flare remains ¥0.1 per image. Unclear prices require review.'
            )}
          </p>
          {query.isPending && <Skeleton className='h-64 w-full' />}
          {query.isError && (
            <ErrorState
              title={t('Unable to load model catalog')}
              onRetry={() => void query.refetch()}
            />
          )}
          {state && (
            <>
              <div className='flex flex-wrap gap-4 rounded-lg border p-3 text-sm'>
                <p>
                  {t('Published version')}:{' '}
                  {state.published?.models.length ?? 0} ·{' '}
                  {state.published?.fetched_at || t('Not published')}
                </p>
                <p>
                  {t('Draft version')}: {state.draft?.models.length ?? 0} ·{' '}
                  {state.draft?.fetched_at || '—'}
                </p>
              </div>
              {state.draft && (
                <section className='space-y-3'>
                  <Button
                    variant='outline'
                    aria-expanded={showChanges}
                    onClick={() => setShowChanges(!showChanges)}
                  >
                    {t('Review changes')} ({changes.length})
                  </Button>
                  {showChanges && (
                    <div className='space-y-3'>
                      {changes.length === 0 ? (
                        <p>{t('No model changes')}</p>
                      ) : (
                        changes.map((change) => (
                          <ChangeDetails key={change.id} change={change} />
                        ))
                      )}
                    </div>
                  )}
                </section>
              )}
              <h3 className='font-semibold'>
                {state.draft ? t('Draft preview') : t('Published catalog')}
              </h3>
              <CatalogList
                key={state.draft?.revision ?? state.published?.revision}
                models={state.draft?.models ?? state.published?.models ?? []}
                admin
              />
              <section className='space-y-2 border-t pt-4'>
                <h3 className='font-semibold'>
                  {t('Recent catalog operations')}
                </h3>
                {state.events
                  .slice(-10)
                  .reverse()
                  .map((event) => (
                    <p
                      key={event.revision}
                      className='text-muted-foreground text-xs break-all'
                    >
                      {event.at} ·{' '}
                      {t(
                        {
                          sync: 'Sync upstream catalog',
                          publish: 'Publish draft',
                          rollback: 'Rollback catalog',
                        }[event.action] ?? event.action
                      )}{' '}
                      · {t('Operator ID')}: {event.actor}
                    </p>
                  ))}
              </section>
            </>
          )}
        </div>
        <ConfirmDialog
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmation(null)
          }}
          title={t(
            confirmation?.action === 'rollback'
              ? 'Rollback catalog'
              : 'Publish draft'
          )}
          desc={t(
            'This only changes the customer-facing catalog. It does not enable models, update billing, or alter balances. Unvalidated models remain informational.'
          )}
          confirmText={t('Confirm catalog change')}
          isLoading={mutation.isPending}
          handleConfirm={() => {
            if (confirmation) mutation.mutate(confirmation)
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
