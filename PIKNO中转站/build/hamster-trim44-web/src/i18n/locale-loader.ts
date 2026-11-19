import type { BackendModule, ReadCallback } from 'i18next'

import type { InterfaceLanguageCode } from './languages'

type Translation = Record<string, unknown>
export type LocaleModule = { default: { translation: Translation } }
export type LocaleImports = Record<
  InterfaceLanguageCode,
  () => Promise<LocaleModule>
>

// Every import is fixed at build time. Browser language preferences never become
// a URL or an arbitrary module path.
export const localeImports: LocaleImports = {
  zhCN: () => import('./locales/zh.json'),
}

export function createLocaleLoader(imports: LocaleImports, timeoutMs = 8000) {
  const loaded = new Map<string, Translation>()
  const inFlight = new Map<string, Promise<Translation>>()

  return (language: string): Promise<Translation> => {
    if (!Object.hasOwn(imports, language)) {
      return Promise.reject(new Error('Unsupported interface language'))
    }
    const cached = loaded.get(language)
    if (cached) return Promise.resolve(cached)
    const existing = inFlight.get(language)
    if (existing) return existing

    const pending = new Promise<Translation>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new Error('Interface language loading timed out'))
      }, timeoutMs)
      void Promise.resolve()
        .then(() => imports[language as InterfaceLanguageCode]())
        .then((module) => module.default.translation)
        .then((translation) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          loaded.set(language, translation)
          resolve(translation)
        }, () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error('Interface language could not be loaded'))
        })
    }).finally(() => {
      if (inFlight.get(language) === pending) inFlight.delete(language)
    })
    inFlight.set(language, pending)
    return pending
  }
}

export function createLazyLocaleBackend(
  load: ReturnType<typeof createLocaleLoader>
): BackendModule {
  return {
    type: 'backend',
    init() {},
    read(language: string, namespace: string, callback: ReadCallback) {
      if (namespace !== 'translation') {
        callback(null, {})
        return
      }
      void load(language).then((translation) => {
        // Adapt the promise to i18next's required backend callback interface.
        // oxlint-disable-next-line promise/no-callback-in-promise
        callback(null, translation)
      }, () => {
        // With maxRetries: 0, a retryable failure ends this read immediately
        // and remains eligible for the next explicit changeLanguage call.
        // The fixed Chinese UI can retry the same locale on a later load.
        // oxlint-disable-next-line promise/no-callback-in-promise
        callback(new Error('Interface language could not be loaded'), true)
      })
    },
  }
}
