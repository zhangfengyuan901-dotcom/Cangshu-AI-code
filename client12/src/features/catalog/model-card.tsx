import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { toIntlLocale } from '@/i18n/languages'
import { formatLocalCurrencyAmount } from '@/lib/currency'

import type { CatalogModel, CatalogPrice } from './types'

export function CatalogPrices(props: {
  prices: CatalogPrice[]
  admin?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  return (
    <dl className='space-y-2 text-sm'>
      {props.prices.map((price) => {
        const unit = {
          request: t('request'),
          second: t('second'),
          image: t('image'),
        }[price.unit]
        const amount = formatLocalCurrencyAmount(price.retail_cny, {
          showSymbol: false,
          locale,
          digitsLarge: 6,
          digitsSmall: 6,
        })
        return (
          <div
            key={`${price.resolution}-${price.unit}`}
            className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'
          >
            <dt className='text-muted-foreground'>
              {price.resolution === 'default'
                ? t('Standard')
                : price.resolution}
            </dt>
            <dd className='font-mono'>
              ¥{amount} / {unit}
            </dd>
            {props.admin && price.cost_cny != null && (
              <dd className='text-muted-foreground w-full text-xs'>
                {t('Upstream cost (CNY)')}: ¥
                {formatLocalCurrencyAmount(price.cost_cny, {
                  showSymbol: false,
                  locale,
                  digitsLarge: 6,
                  digitsSmall: 6,
                })}{' '}
                / {unit}
              </dd>
            )}
          </div>
        )
      })}
    </dl>
  )
}

export function CatalogModelCard(props: {
  model: CatalogModel
  onDetails: (model: CatalogModel) => void
  admin?: boolean
}) {
  const { t } = useTranslation()
  const model = props.model
  let status = t('Awaiting validation')
  if (!model.upstream_available) status = t('Upstream unavailable')
  else if (model.price_issue) status = t('Pricing needs review')
  return (
    <Card className='min-w-0 gap-3'>
      <CardHeader>
        <div className='flex items-start justify-between gap-2'>
          <CardTitle className='min-w-0 break-words'>{model.name}</CardTitle>
          <Badge variant='outline'>{status}</Badge>
        </div>
        <div className='flex min-w-0 items-center gap-2'>
          <code className='min-w-0 text-xs break-all'>{model.id}</code>
          <CopyButton value={model.id} tooltip={t('Copy model name')} />
        </div>
        <p className='text-muted-foreground text-xs'>
          {model.provider} · {model.kind === 'video' ? t('Video') : t('Image')}
        </p>
      </CardHeader>
      <CardContent className='flex-1 space-y-2'>
        <p className='text-muted-foreground text-xs'>
          {t('Reference price (CNY), not an active billing rule')}
        </p>
        <CatalogPrices prices={model.prices} admin={props.admin} />
        {model.price_issue && (
          <p className='text-warning text-sm'>
            {t('Incomplete pricing must be reviewed before activation.')}
          </p>
        )}
        {model.reference_surcharge_cny > 0 && (
          <p className='text-warning text-xs'>
            {t('Video reference surcharge applies; see details.')}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Button
          variant='outline'
          size='sm'
          onClick={() => props.onDetails(model)}
        >
          {t('Parameters & access')}
        </Button>
      </CardFooter>
    </Card>
  )
}
