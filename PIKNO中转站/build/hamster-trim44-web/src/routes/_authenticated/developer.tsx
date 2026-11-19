import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { Markdown } from '@/components/ui/markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'

const API_GUIDE_REVISION = 'client34-20261016'

export const Route = createFileRoute('/_authenticated/developer')({
  component: ApiGuide,
})

function ApiGuide() {
  const { t } = useTranslation()
  const guide = useQuery({
    queryKey: ['pikno-api-guide', API_GUIDE_REVISION],
    queryFn: async () => {
      const response = await api.get<string>(
        `/developer-guide.md?revision=${API_GUIDE_REVISION}`,
        {
          responseType: 'text',
        }
      )
      if (!response.data.startsWith('# 仓鼠AI')) {
        throw new Error(t('Unable to load API docs'))
      }
      return response.data
    },
    staleTime: 300000,
    meta: { errorToast: false },
  })
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Docs')}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto max-w-4xl'>
          {guide.isPending && <Skeleton className='h-60 w-full' />}
          {guide.isError && (
            <ErrorState
              title={t('Unable to load API docs')}
              onRetry={() => void guide.refetch()}
            />
          )}
          {guide.data && (
            <article lang='zh-CN'>
              <Markdown>{guide.data}</Markdown>
            </article>
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
