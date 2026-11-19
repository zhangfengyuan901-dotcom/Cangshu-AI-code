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
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createLocalChallenge, type LocalChallengeState } from '../../public/auth-lite/local-challenge.mjs'

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => void
    }
  }
}

interface TurnstileProps {
  siteKey: string
  onVerify: (token: string) => void
  onExpire?: () => void
  className?: string
}

export function Turnstile({
  siteKey,
  onVerify,
  onExpire,
  className,
}: TurnstileProps) {
  if (siteKey === 'local-image') {
    return <LocalChallenge onVerify={onVerify} onExpire={onExpire} className={className} />
  }
  return <CloudflareTurnstile siteKey={siteKey} onVerify={onVerify} onExpire={onExpire} className={className} />
}

function LocalChallenge({ onVerify, onExpire, className }: Omit<TurnstileProps, 'siteKey'>) {
  const { t } = useTranslation()
  const inputId = useId()
  const [answer, setAnswer] = useState('')
  const [state, setState] = useState<LocalChallengeState>({ image: '', token: '', busy: true, error: false })
  const callbacks = useRef({ onVerify, onExpire })
  callbacks.current = { onVerify, onExpire }
  const client = useRef<ReturnType<typeof createLocalChallenge> | null>(null)
  useEffect(() => {
    const controller = createLocalChallenge({ onChange(next) {
      setState(next)
      callbacks.current.onVerify(next.token)
      if (!next.image) setAnswer('')
      if (next.error) callbacks.current.onExpire?.()
    } })
    client.current = controller
    void controller.load()
    return () => { client.current = null; controller.dispose() }
  }, [])
  return <div className={className}>
    {state.image && <div className='grid gap-2'>
      <img src={state.image} width={210} height={64} alt={t('Image verification code', { defaultValue: '图形验证码' })} />
      <Label htmlFor={inputId}>{t('Enter the 6 digits in the image', { defaultValue: '请输入图片中的 6 位数字' })}</Label>
      <Input id={inputId} value={answer} inputMode='numeric' autoComplete='off' maxLength={6} disabled={state.busy}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!state.busy) void client.current?.verify(answer) } }} />
    </div>}
    <div className='mt-2 flex gap-2'>
      <Button type='button' variant='outline' disabled={state.busy || !state.image || !/^\d{6}$/.test(answer)} onClick={() => { void client.current?.verify(answer) }}>
        {t('Verify', { defaultValue: '验证' })}
      </Button>
      <Button type='button' variant='ghost' disabled={state.busy} onClick={() => { void client.current?.load() }}>{t('Refresh')}</Button>
    </div>
    <p role='status' className='mt-2 text-sm text-muted-foreground'>
      {state.busy ? t('Loading...') : state.token ? t('Verification passed', { defaultValue: '验证通过' }) : state.error ? t('Verification expired or failed. Refresh and try again.', { defaultValue: '验证未完成或已过期，请刷新重试。' }) : ''}
    </p>
  </div>
}

function CloudflareTurnstile({ siteKey, onVerify, onExpire, className }: TurnstileProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const render = () => {
      if (!ref.current || !window.turnstile) return
      try {
        window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: (token: string) => onVerify(token),
          'error-callback': () => onExpire?.(),
          'expired-callback': () => onExpire?.(),
        })
      } catch {
        /* empty */
      }
    }

    if (window.turnstile) {
      render()
      return
    }
    const scriptId = 'cf-turnstile'
    if (document.getElementById(scriptId)) return
    const s = document.createElement('script')
    s.id = scriptId
    s.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.defer = true
    s.onload = () => render()
    document.head.appendChild(s)
  }, [siteKey, onVerify, onExpire])

  return <div ref={ref} className={className} />
}
