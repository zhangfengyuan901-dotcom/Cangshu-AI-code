import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Turnstile } from './turnstile'
import { mountLocalChallenge } from '../../public/auth-lite/local-challenge.mjs'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
afterEach(() => { vi.unstubAllGlobals() })

describe('same-origin authentication challenge', () => {
  it('mounts the H5 widget, replaces a consumed proof and removes it on departure', async () => {
    const tokens: string[] = []
    const fetchMock = vi.fn(async (path: string) => ({ ok: true, json: async () => ({ success: true, data: path.endsWith('/verify') ? { token: `local.${'T'.repeat(43)}`, expires_in: 120 } : { id: 'Q'.repeat(43), image: 'data:image/png;base64,aGVsbG8=', expires_in: 120 } }) }))
    vi.stubGlobal('fetch', fetchMock)
    const container = document.createElement('div'); document.body.append(container)
    const widget = mountLocalChallenge(container, (token) => tokens.push(token))
    const input = await screen.findByLabelText('图形验证码')
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false))
    fireEvent.input(input, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '验证' }))
    await waitFor(() => expect(tokens.at(-1)).toBe(`local.${'T'.repeat(43)}`))
    widget.reset(); expect(tokens.at(-1)).toBe('')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    widget.remove(); expect(container.children).toHaveLength(0); container.remove()
    expect(document.querySelector('script[src*="cloudflare"]')).toBeNull()
  })
  it('renders and verifies without injecting a Cloudflare script; unmount rejects late replies', async () => {
    const onVerify = vi.fn()
    let answerReply: ((value: unknown) => void) | undefined
    const fetchMock = vi.fn(async (path: string) => path.endsWith('/verify') ? new Promise((resolve) => { answerReply = resolve }) : { ok: true, json: async () => ({ success: true, data: { id: 'Q'.repeat(43), image: 'data:image/png;base64,aGVsbG8=', expires_in: 120 } }) })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<Turnstile siteKey='local-image' onVerify={onVerify} />)
    const input = await screen.findByLabelText('请输入图片中的 6 位数字')
    fireEvent.change(input, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '验证' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(document.querySelector('script[src*="cloudflare"]')).toBeNull()
    view.unmount()
    answerReply?.({ ok: true, json: async () => ({ success: true, data: { token: `local.${'T'.repeat(43)}`, expires_in: 120 } }) })
    await Promise.resolve(); await Promise.resolve()
    expect(onVerify.mock.calls.every(([token]) => token === '')).toBe(true)
  })
})
