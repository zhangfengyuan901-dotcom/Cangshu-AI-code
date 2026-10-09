import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'

// The published guide owns the R2/media contract, not model-name heuristics.
export function CustomerModelAccess(props: { modelName: string }) {
  const { t } = useTranslation()
  return (
    <section className='space-y-4 rounded-xl border p-4'>
      <h2 className='font-semibold'>{t('API access')}</h2>
      <dl className='space-y-3 text-sm'>
        <div>
          <dt className='text-muted-foreground'>{t('API Base URL')}</dt>
          <dd className='flex min-w-0 items-center gap-2'>
            <code className='min-w-0 break-all'>
              https://www.piknoai.com/v1
            </code>
            <CopyButton
              value='https://www.piknoai.com/v1'
              tooltip={t('Copy API Base URL')}
            />
          </dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>{t('Model')}</dt>
          <dd className='flex min-w-0 items-center gap-2'>
            <code className='min-w-0 break-all'>{props.modelName}</code>
            <CopyButton
              value={props.modelName}
              tooltip={t('Copy model name')}
            />
          </dd>
        </div>
      </dl>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Use a PIKNO API key in the Authorization Bearer header. Your key group and model permissions must allow this model.'
        )}
      </p>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Upload reference media directly to R2 first, then submit its signed URL. Follow the PIKNO guide for endpoints, parameters and task queries.'
        )}
      </p>
      <div className='flex flex-wrap gap-2'>
        <Button role='link' render={<Link to='/developer' />}>
          {t('API documentation')}
        </Button>
        <Button role='link' variant='outline' render={<Link to='/keys' />}>
          {t('API Keys')}
        </Button>
      </div>
    </section>
  )
}
