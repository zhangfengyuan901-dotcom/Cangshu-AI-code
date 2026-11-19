import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  BookOpen,
  Box,
  FileText,
  KeyRound,
  RefreshCw,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { WalletStatsCard } from '@/features/wallet/components/wallet-stats-card'
import type { UserWalletData } from '@/features/wallet/types'
import { useIsSidebarModuleVisible } from '@/hooks/use-sidebar-config'
import { useTopNavLinks } from '@/hooks/use-top-nav-links'
import { getSelf } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { useAnnouncements } from '../../hooks/use-status-data'
import { AnnouncementsPanel } from './announcements-panel'

// Keep account data isolated by user; refresh on focus and explicitly, not by polling.
export function CustomerOverview() {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id)
  const announcements = useAnnouncements()
  const walletVisible = useIsSidebarModuleVisible('/wallet')
  const keysVisible = useIsSidebarModuleVisible('/keys')
  const logsVisible = useIsSidebarModuleVisible('/settlements')
  const pricingVisible = useTopNavLinks().some(
    (link) => link.href === '/pricing'
  )
  const account = useQuery({
    queryKey: ['pikno-customer-account', userId],
    queryFn: async (): Promise<UserWalletData> => {
      const response = requireServerSuccess(await getSelf())
      if (!response.data) throw new Error(t('Unable to load account balance'))
      return response.data as UserWalletData
    },
    enabled: !!userId,
    staleTime: 0,
    retry: 1,
    meta: { errorToast: false },
  })
  const actions = [
    {
      title: t('Add Funds'),
      description: t('Fixed CNY top-ups with Alipay or WeChat Pay'),
      to: '/wallet',
      visible: walletVisible,
      icon: Wallet,
    },
    {
      title: t('Available models'),
      description: t('Review supported models before calling'),
      to: '/pricing',
      visible: pricingVisible,
      icon: Box,
    },
    {
      title: t('API Keys'),
      description: '分别管理图片、视频、工具和对话 Key',
      to: '/keys',
      visible: keysVisible,
      icon: KeyRound,
    },
    {
      title: t('Task records'),
      description: t('Review generation results, charges and refunds'),
      to: '/settlements',
      visible: logsVisible,
      icon: FileText,
    },
  ] as const

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Overview')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          size='sm'
          disabled={account.isFetching}
          onClick={() => void account.refetch()}
        >
          <RefreshCw className='size-4' aria-hidden='true' />
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-6xl flex-col gap-5'>
          {account.isError ? (
            <ErrorState
              title={t('Unable to load account balance')}
              description={t(
                'Please retry. Your balance has not been changed.'
              )}
              onRetry={() => void account.refetch()}
            />
          ) : (
            <WalletStatsCard
              user={account.data ?? null}
              loading={account.isPending}
            />
          )}
          <div className='grid gap-3 sm:grid-cols-2'>
            {actions
              .filter((action) => action.visible)
              .map((action) => (
                <Card key={action.to} className='gap-2 py-4'>
                  <CardHeader className='px-4'>
                    <CardTitle className='flex items-center gap-2 text-base'>
                      <action.icon className='size-4' aria-hidden='true' />
                      {action.title}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='flex flex-wrap items-center justify-between gap-3 px-4'>
                    <p className='text-muted-foreground text-sm'>
                      {action.description}
                    </p>
                    <Button
                      variant='outline'
                      size='sm'
                      render={<Link to={action.to} />}
                    >
                      {action.title}
                    </Button>
                  </CardContent>
                </Card>
              ))}
          </div>
          <Card className='gap-3 py-4'>
            <CardHeader className='px-4'>
              <CardTitle className='text-base'>{t('API Access')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-3 px-4'>
              <p className='text-muted-foreground text-sm'>
                在账户中心手动充值并开通四类用途 Key，仓鼠AI应用会安全接入并免费检测。消费与结算记录以服务端为准。
              </p>
              <div className='bg-muted/40 flex min-w-0 items-center gap-2 rounded-md border p-3'>
                <code className='min-w-0 flex-1 text-sm break-all'>
                  https://www.piknoai.com/v1
                </code>
                <CopyButton
                  value='https://www.piknoai.com/v1'
                  aria-label={t('Copy API base URL')}
                />
              </div>
              <Button
                variant='outline'
                size='sm'
                render={<Link to='/developer' />}
              >
                <BookOpen className='size-4' aria-hidden='true' />
                {t('Docs')}
              </Button>
            </CardContent>
          </Card>
          {announcements.items.length > 0 && <AnnouncementsPanel />}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
