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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LoadingState } from '@/components/loading-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { useChannels } from './channels-provider'
import { PiknoRHConfigDialog } from './pikno-rh-config-dialog'
import { RHToolConnections, useRHConnections } from './pikno-rh-connections'
import { PiknoRHDetailsDialog } from './pikno-rh-details-dialog'

const supplierLabels = [
  'RH · 工具工作流',
  'CanSeeDream · 视频生成',
  'PackyAPI · 图片生成',
]

export function UpstreamSupplierView() {
  const { t } = useTranslation()
  const [rhOpen, setRHOpen] = useState(false)
  const [credentialOpen, setCredentialOpen] = useState(false)
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  // The credential controller requires exactly the root role. Line management
  // follows the broader RootAuth threshold; do not broaden credential access.
  const canManageCredential = role === ROLE.SUPER_ADMIN
  const canManageLines = role >= ROLE.SUPER_ADMIN
  const connections = useRHConnections()
  const { enableTagMode, setEnableTagMode } = useChannels()

  const setSupplierView = (bySupplier: boolean) => {
    localStorage.setItem('enable-tag-mode', String(bySupplier))
    setEnableTagMode(bySupplier)
  }

  if (role < ROLE.ADMIN) return null

  return (
    <section
      aria-label={t('Connection view')}
      className='flex shrink-0 flex-col gap-2'
    >
      <ButtonGroup aria-label={t('Connection view')}>
        <Button
          type='button'
          variant={enableTagMode ? 'outline' : 'default'}
          aria-pressed={!enableTagMode}
          onClick={() => setSupplierView(false)}
        >
          {t('General connections')}
        </Button>
        <Button
          type='button'
          variant={enableTagMode ? 'default' : 'outline'}
          aria-pressed={enableTagMode}
          onClick={() => setSupplierView(true)}
        >
          {t('By supplier')}
        </Button>
      </ButtonGroup>
      <section
        aria-label='RH 工具线路'
        className='min-w-0 rounded-lg border p-3'
      >
        <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
          <h2 className='text-sm font-semibold'>RH 工具线路</h2>
          <Button
            type='button'
            variant='outline'
            onClick={() => setRHOpen(true)}
          >
            {t('RH tools and credentials')}
          </Button>
        </div>
        {connections.isPending && (
          <LoadingState inline message={t('Loading RH connections...')} />
        )}
        {connections.isError && (
          <div
            role='status'
            className='flex flex-wrap items-center gap-2 text-sm'
          >
            <span>{t('RH connection status unavailable')}</span>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void connections.refetch()}
            >
              {t('Retry')}
            </Button>
          </div>
        )}
        {connections.isSuccess &&
          (connections.data.tools.length > 0 ? (
            <RHToolConnections tools={connections.data.tools} />
          ) : (
            <p className='text-muted-foreground text-sm'>
              {t('No managed RH tool connections')}
            </p>
          ))}
        <PiknoRHDetailsDialog
          open={rhOpen}
          onOpenChange={setRHOpen}
          canManage={canManageCredential}
          canManageLines={canManageLines}
          onManageCredential={() => {
            setRHOpen(false)
            setCredentialOpen(true)
          }}
        />
        {canManageCredential && (
          <PiknoRHConfigDialog
            open={credentialOpen}
            onOpenChange={(open) => {
              setCredentialOpen(open)
              if (!open) setRHOpen(true)
            }}
          />
        )}
      </section>
      <div aria-label={t('Supplier labels')} className='flex flex-wrap gap-2'>
        {supplierLabels.map((label) => (
          <StatusBadge key={label} label={label} copyable={false} />
        ))}
      </div>
    </section>
  )
}
