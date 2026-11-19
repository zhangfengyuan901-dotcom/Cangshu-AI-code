import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { fetchUpstreamModels } from '../../api'
import { getPackyMappedModels } from '../../lib/pikno-packy-check'
import type { Channel } from '../../types'

type PackyCheckDialogProps = {
  channel: Channel
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PiknoPackyCheckDialog(props: PackyCheckDialogProps) {
  const { t } = useTranslation()
  const check = useMutation({
    mutationFn: async () => {
      const response = await fetchUpstreamModels(props.channel.id)
      if (!response.success || !Array.isArray(response.data)) {
        throw new Error('packy_catalog_check_failed')
      }
      return new Set(response.data)
    },
    retry: false,
    meta: { errorToast: false },
  })
  const models = getPackyMappedModels(props.channel)

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('PackyAPI read-only connection check')}
      description={props.channel.name}
      contentClassName='sm:max-w-3xl'
      footer={
        <Button variant='outline' onClick={() => props.onOpenChange(false)}>
          {t('Close')}
        </Button>
      }
    >
      <div className='space-y-4'>
        <Alert>
          <AlertTitle>{t('This check does not generate images')}</AlertTitle>
          <AlertDescription>
            {t(
              'Read the upstream model catalogue with the saved Key. No generation request or PIKNO charge is made. A readable catalogue does not confirm generation, balance or image-group permissions.'
            )}
          </AlertDescription>
        </Alert>
        <Button disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending
            ? t('Checking connection...')
            : t('Run read-only check')}
        </Button>
        {check.isSuccess && (
          <p role='status'>
            {t(
              'Model catalogue is readable. Image generation is not yet verified.'
            )}
          </p>
        )}
        {check.isError && (
          <Alert variant='destructive'>
            <AlertTitle>{t('Read-only check did not complete')}</AlertTitle>
            <AlertDescription>
              {t(
                'Check the saved upstream address, Key permissions and network, then retry. This result does not prove that image generation failed.'
              )}
            </AlertDescription>
          </Alert>
        )}
        {models.length === 0 ? (
          <p>{t('No models configured on this connection.')}</p>
        ) : (
          <Table aria-label={t('Configured image model mappings')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Configured model')}</TableHead>
                <TableHead>{t('Mapped upstream model')}</TableHead>
                <TableHead>{t('Catalogue check')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((row) => {
                let result = t('Not checked')
                  if (row.invalid) {
                  result = t(
                    'Invalid model mapping; review the connection configuration.'
                  )
                  } else if (check.isSuccess) {
                  result = check.data.has(row.upstreamModel)
                    ? t('Listed in catalogue; generation not verified')
                    : t('Not listed; confirm upstream availability')
                  }
                return (
                  <TableRow key={row.model}>
                    <TableCell>{row.model}</TableCell>
                    <TableCell>{row.upstreamModel}</TableCell>
                    <TableCell className='whitespace-normal'>
                      {result}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
        <Alert>
          <AlertTitle>
            {t('Real image acceptance uses a published line')}
          </AlertTitle>
          <AlertDescription>
            {t(
              'Use /v1/images/generations for text-to-image and /v1/images/edits for image editing. Real tasks may incur upstream fees. This window does not submit, retry or delete models.'
            )}
          </AlertDescription>
        </Alert>
      </div>
    </Dialog>
  )
}
