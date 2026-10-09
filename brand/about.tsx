/*
Copyright (C) 2023-2026 QuantumNous
Licensed under GNU AGPL v3 or later.
PIKNO brand and attribution layout modified on 2026-10-05.
*/
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { Footer } from '@/components/layout/components/footer'

export function About() {
  const { t } = useTranslation()

  return (
    <PublicLayout showMainContainer={false}>
      <main className='pikno-about'>
        <p className='pikno-home__eyebrow'>PIKNO AI</p>
        <h1>{t('About PIKNO')}</h1>
        <p>{t('PIKNO brings image, video, and general-purpose models together through a unified API.')}</p>
        <section aria-labelledby='open-source-notices'>
          <h2 id='open-source-notices'>{t('Open-source notices')}</h2>
          <p>{t('PIKNO customizes the interface of New API. Brand and layout changes were made on 2026-10-05.')}</p>
          <p>Copyright © 2023–2026 QuantumNous and contributors.</p>
          <p lang='en'>Frontend design and development by New API contributors.</p>
          <p>
            {t('Original project')}: <a href='https://github.com/QuantumNous/new-api'>New API · QuantumNous</a>
          </p>
          <p>{t('This software is provided without warranty under the GNU AGPL v3. You may redistribute and modify it under that license.')}</p>
          <nav aria-label={t('License and notices')}>
            <a href='/open-source/LICENSE.txt'>GNU AGPL v3</a>
            <a href='/open-source/NOTICE.txt'>NOTICE</a>
            <a href='/open-source/THIRD-PARTY-LICENSES.txt'>Third-party licenses</a>
          </nav>
        </section>
      </main>
      <Footer />
    </PublicLayout>
  )
}
