import { createInstance } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n, { i18nReady } from '../config'
import { createLocaleLoader, localeImports, type LocaleModule } from '../locale-loader'
import { convertDetectedLanguage, INTERFACE_LANGUAGE_OPTIONS, normalizeInterfaceLanguage, toIntlLocale } from '../languages'
import chinese from '../locales/zh.json'

afterEach(() => vi.useRealTimers())
describe('fixed Chinese interface', () => {
  it('ships Chinese only and ignores stored or detected foreign languages', async () => {
    await i18nReady
    expect(i18n.language).toBe('zhCN')
    expect(i18n.t('Available models')).toBe('可用模型')
    expect(INTERFACE_LANGUAGE_OPTIONS.map((entry) => entry.code)).toEqual(['zhCN'])
    expect(Object.keys(localeImports)).toEqual(['zhCN'])
    for (const input of ['en', 'fr', 'zh-TW', '../private', null]) expect(normalizeInterfaceLanguage(input)).toBe('zhCN')
    expect(convertDetectedLanguage('fr-FR')).toBe('zhCN')
    expect(toIntlLocale('zhCN')).toBe('zh-CN')
  })
  it('initializes Chinese synchronously from local resources without a fallback request', async () => {
    const instance = createInstance()
    await instance.init({ lng: 'zhCN', supportedLngs: ['zhCN'], fallbackLng: 'zhCN', resources: { zhCN: chinese }, initAsync: false, nsSeparator: false })
    expect(instance.t('Sign in')).toBe(chinese.translation['Sign in'])
    expect(instance.hasResourceBundle('en', 'translation')).toBe(false)
  })
  it('shares successful Chinese imports and rejects arbitrary module paths', async () => {
    const zhCN = vi.fn(async () => ({ default: { translation: { Hello: '你好' } } }))
    const load = createLocaleLoader({ zhCN })
    const first = load('zhCN')
    expect(load('zhCN')).toBe(first)
    expect(await first).toEqual({ Hello: '你好' })
    expect(await load('zhCN')).toEqual({ Hello: '你好' })
    expect(zhCN).toHaveBeenCalledTimes(1)
    await expect(load('../private')).rejects.toThrow('Unsupported interface language')
    await expect(load('__proto__')).rejects.toThrow('Unsupported interface language')
  })
  it('bounds a hung optional import and permits a later recovery', async () => {
    vi.useFakeTimers()
    const zhCN = vi.fn<() => Promise<LocaleModule>>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ default: { translation: { Hello: '你好' } } })
    const load = createLocaleLoader({ zhCN }, 50)
    const rejected = expect(load('zhCN')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(await load('zhCN')).toEqual({ Hello: '你好' })
  })
})
