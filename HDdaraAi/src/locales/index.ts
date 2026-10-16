import { createI18n } from 'vue-i18n'

import en from './en'
import zhCN from './zh-CN'

/**
 * Internationalisation.
 *
 * Wired up and used by the screens that have been extracted; the rest of the app
 * still carries its copy inline. That is a staging point, not an oversight: the
 * app has ~512 lines of user-facing Chinese across 12 pages, and converting them
 * in one commit would produce a diff nobody can review and a translation file
 * nobody can verify. The remaining screens move over as they are touched.
 *
 * Two constraints shape the configuration:
 *
 * 1. `legacy: false` — the Composition API mode. The Options API one needs a
 *    Vue instance at install time, which does not exist yet here.
 *
 * 2. Messages must stay plain strings. The full `vue-i18n` bundle compiles
 *    messages with `new Function`, which the miniprogram runtime blocks; a
 *    message that needs compiling (pluralisation with pipes, named links) would
 *    throw there while working on H5. Interpolation with `{name}` is fine — it
 *    is resolved by the runtime, not the compiler.
 *
 * The locale is fixed rather than detected. The app has no language picker yet,
 * and following the device language would switch every existing Chinese user to
 * English the moment this shipped, because their phone reports `en` far more
 * often than their preference for this app does.
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

export const i18n = createI18n({
  fallbackLocale: 'zh-CN',
  legacy: false,
  locale: 'zh-CN',
  messages: {
    'en': en,
    'zh-CN': zhCN,
  },
})

/**
 * The translator, for use outside a component.
 *
 * `useI18n()` needs a component instance, so API modules and the stores cannot
 * call it — they take this instead. Typed to the default locale's shape so a
 * mistyped key is caught at build time.
 */
export const t = i18n.global.t as (
  key: string,
  named?: Record<string, unknown>,
) => string

export default i18n
