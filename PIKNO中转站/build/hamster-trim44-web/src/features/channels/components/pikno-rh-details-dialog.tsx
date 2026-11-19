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
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

import {
  RHConnectionStatus,
  RHToolConnections,
  useRHConnections,
} from './pikno-rh-connections'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  canManage: boolean
  canManageLines: boolean
  onManageCredential: () => void
}

export function PiknoRHDetailsDialog(props: Props) {
  const { t } = useTranslation()
  const connections = useRHConnections(props.open)

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('RH tools and credentials')}
      description={t(
        'One shared RH credential, two independent tool routes. Connection status does not confirm generation acceptance.'
      )}
      footer={
        <Button variant='outline' onClick={() => props.onOpenChange(false)}>
          {t('Close')}
        </Button>
      }
    >
      <div className='flex min-w-0 flex-col gap-4'>
        <Alert>
          <AlertTitle>{t('Shared cloud credential')}</AlertTitle>
          <AlertDescription>
            {t(
              'Configure the real RH Key only in the cloud credential entry. Tool connections use an internal bridge Key and do not need separate RH Keys.'
            )}
          </AlertDescription>
        </Alert>
        {(props.canManage || props.canManageLines) && (
          <div className='flex flex-wrap gap-2'>
            {props.canManage && (
              <Button variant='outline' onClick={props.onManageCredential}>
                {t('Manage cloud RH credential')}
              </Button>
            )}
            {props.canManageLines && (
              <Button
                variant='outline'
                role='link'
                render={<Link to='/line-management' />}
              >
                {t('Manage tool lines')}
              </Button>
            )}
          </div>
        )}
        {connections.isPending && (
          <LoadingState message={t('Loading RH connections...')} />
        )}
        {connections.isError && (
          <ErrorState
            title={t('RH connection status unavailable')}
            description={t(
              'This request only reads connection status. Retry or close the dialog to return to the connection list.'
            )}
            onRetry={() => void connections.refetch()}
          />
        )}
        {connections.isSuccess && (
          <>
            {connections.data.tools.length === 0 && (
              <EmptyState title={t('No managed RH tool connections')} />
            )}
            <RHToolConnections tools={connections.data.tools} />
            {connections.data.legacy.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger render={<Button variant='outline' />}>
                  {t('Advanced / historical connection')}
                </CollapsibleTrigger>
                <CollapsibleContent className='pt-3'>
                  <div className='flex flex-col gap-3 rounded-lg border p-3'>
                    <p className='text-muted-foreground text-sm'>
                      {t(
                        'Retained for historical compatibility. No connection is deleted or changed by this view. Use the dedicated tool lines for current business configuration.'
                      )}
                    </p>
                    {connections.data.legacy.map((connection) => (
                      <RHConnectionStatus
                        key={connection.id}
                        connection={connection}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
