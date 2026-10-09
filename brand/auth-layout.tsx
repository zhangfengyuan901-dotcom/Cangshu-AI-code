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

import { Skeleton } from '@/components/ui/skeleton'
import { useSystemConfig } from '@/hooks/use-system-config'

type AuthLayoutProps = {
  children: React.ReactNode
}

const AUTH_TRUST_POINTS = [
  'Unified endpoint',
  'Usage-based billing',
  'Live usage records',
] as const

export function AuthLayout(props: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()

  return (
    <main className='pikno-auth'>
      <section className='pikno-auth__brand' aria-label='PIKNO AI'>
        <Link to='/' className='pikno-auth__brand-link'>
          <span className='pikno-auth__brand-logo'>
            {loading ? (
              <Skeleton className='size-full rounded-full' />
            ) : (
              <img src={logo} alt='' className='size-full object-contain' />
            )}
          </span>
          <span>{loading ? 'PIKNO AI' : systemName}</span>
        </Link>

        <div className='pikno-auth__hero'>
          <p className='pikno-auth__eyebrow'>PIKNO AI · UNIFIED GATEWAY</p>
          <h1>{t('One gateway. Every creative possibility.')}</h1>
          <p className='pikno-auth__lead'>
            {t(
              'A unified API for image, video, and general-purpose models. Clear pricing, stable routing, and usage records you can review at any time.'
            )}
          </p>
          <ul className='pikno-auth__trust' aria-label={t('Core Features')}>
            {AUTH_TRUST_POINTS.map((item) => (
              <li key={item}>{t(item)}</li>
            ))}
          </ul>
        </div>

        <div className='pikno-auth__signal' aria-hidden='true'>
          <span>API</span>
          <span>IMAGE</span>
          <span>VIDEO</span>
        </div>
      </section>

      <section
        className='pikno-auth__form-shell'
        aria-label={t('Authentication')}
      >
        <div className='pikno-auth__form-card'>
          <div className='pikno-auth__mobile-brand' aria-hidden='true'>
            <img src={logo} alt='' />
            <span>{loading ? 'PIKNO AI' : systemName}</span>
          </div>
          {props.children}
          <div className='pikno-auth-notices'>
            <Link to='/about'>{t('Open-source notices')}</Link>
          </div>
        </div>
      </section>
    </main>
  )
}
