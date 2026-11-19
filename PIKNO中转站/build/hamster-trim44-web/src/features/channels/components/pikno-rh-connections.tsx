import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { api } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { CHANNEL_STATUS, CHANNEL_STATUS_LABELS } from '../constants'

type Connection = { id: number; name: string; status: number }
type RHConnections = {
  tools: (Connection & { kind: 'digital-human' | 'depth' })[]
  legacy: Connection[]
}

export function useRHConnections(enabled = true) {
  const user = useAuthStore((state) => state.auth.user)
  return useQuery({
    queryKey: ['pikno-rh-connections', user?.id ?? null],
    enabled: enabled && (user?.role ?? 0) >= ROLE.ADMIN,
    queryFn: async () => {
      const response = await api.get<{ success: boolean; data: RHConnections }>(
        '/api/pikno/rh-connections'
      )
      return requireServerSuccess(response.data).data
    },
    retry: false,
    staleTime: 0,
    meta: { errorToast: false },
  })
}

export function RHConnectionStatus(props: { connection: Connection }) {
  const { t } = useTranslation()
  const label =
    CHANNEL_STATUS_LABELS[
      props.connection.status as keyof typeof CHANNEL_STATUS_LABELS
    ] ?? 'Unknown'
  return (
    <div className='flex min-w-0 flex-wrap items-center justify-between gap-2'>
      <span className='min-w-0 break-words'>
        <span>#{props.connection.id} · </span>
        <span>{props.connection.name}</span>
      </span>
      <StatusBadge
        label={t(label)}
        variant={
          props.connection.status === CHANNEL_STATUS.ENABLED
            ? 'success'
            : 'neutral'
        }
        copyable={false}
      />
    </div>
  )
}

export function RHToolConnections(props: { tools: RHConnections['tools'] }) {
  const { t } = useTranslation()
  return (
    <div className='grid min-w-0 gap-3 sm:grid-cols-2'>
      {props.tools.map((connection) => (
        <section key={connection.id} className='min-w-0 rounded-lg border p-3'>
          <h3 className='mb-2 text-sm font-medium'>
            {connection.kind === 'digital-human'
              ? t('Digital human')
              : t('Depth video')}
          </h3>
          <RHConnectionStatus connection={connection} />
        </section>
      ))}
    </div>
  )
}
