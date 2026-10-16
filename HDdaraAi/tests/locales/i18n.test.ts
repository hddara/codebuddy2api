import { describe, expect, it } from 'vitest'
import { i18n, SUPPORTED_LOCALES, t } from '@/locales'
import en from '@/locales/en'
import zhCN from '@/locales/zh-CN'

/**
 * Structural parity is the thing worth asserting.
 *
 * A missing key does not throw — it renders as the key itself — so a translation
 * that lost a branch would reach production looking like `account.passkeyEmpty`
 * on screen. `en` is typed against `zh-CN` to catch this at compile time; this
 * catches it at test time too, for the case where the type is widened.
 */
describe('locale catalogues', () => {
  const keysOf = (value: unknown, prefix = ''): string[] => {
    if (typeof value !== 'object' || value === null)
      return [prefix]

    return Object.entries(value).flatMap(([key, child]) =>
      keysOf(child, prefix ? `${prefix}.${key}` : key),
    )
  }

  it('declares every supported locale', () => {
    expect(SUPPORTED_LOCALES).toContain(i18n.global.locale.value)
  })

  it('has the same keys in both languages', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(zhCN).sort())
  })

  it('has no empty strings', () => {
    // An empty value passes a key-parity check while rendering nothing at all.
    for (const [locale, messages] of Object.entries({ en, 'zh-CN': zhCN })) {
      for (const key of keysOf(messages)) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown>)[part],
            messages,
          )

        expect(value, `${locale}:${key}`).toBeTruthy()
      }
    }
  })
})

/**
 * The runtime path, exercised without the message compiler.
 *
 * `vue-i18n`'s full bundle compiles messages with `new Function`, which the
 * miniprogram runtime blocks — and the App build resolves the package to its
 * runtime-only entry, which has no compiler at all. Everything here must
 * therefore work with plain string lookup.
 */
describe('translation runtime', () => {
  it('resolves a nested key', () => {
    expect(t('common.cancel')).toBe('取消')
  })

  it('returns the key for a missing entry instead of throwing', () => {
    expect(t('does.not.exist')).toBe('does.not.exist')
  })

  it('switches locale and back', () => {
    const original = i18n.global.locale.value

    try {
      i18n.global.locale.value = 'en'
      expect(t('common.cancel')).toBe('Cancel')
    }
    finally {
      i18n.global.locale.value = original
    }
  })

  it('uses no messages requiring the compiler', () => {
    // A pipe starts a plural branch, a leading `@` starts a linked message, and
    // `{name}` starts an interpolation — all three are compiled, not resolved at
    // runtime.
    //
    // The first two throw on the miniprogram. The third is worse: it renders the
    // placeholder verbatim on the App, so `跟随系统，当前为{theme}。` reached a real
    // device with a literal `{theme}` in it. Nothing caught that because the
    // placeholder is valid everywhere else. Messages that need a value are split
    // into `...Prefix` / `...Suffix` pairs and joined in JS.
    const offenders: string[] = []

    const walk = (value: unknown, prefix: string) => {
      if (typeof value === 'string') {
        if (value.includes('|') || value.includes('@:') || /\{[^}]*\}/.test(value))
          offenders.push(prefix)

        return
      }

      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          walk(child, prefix ? `${prefix}.${key}` : key)
        }
      }
    }

    walk(zhCN, '')
    walk(en, '')

    expect(offenders).toEqual([])
  })

  it('composes the theme hint without a compiler', () => {
    // Mirrors the expression in `settings/index.vue`; the pieces are what the
    // catalogue ships, so an accidental placeholder would fail here first.
    const hint = `${t('settings.followSystemHintPrefix')}${t('settings.themeLight')}${t('settings.followSystemHintSuffix')}`

    expect(hint).toBe('跟随系统，当前为浅色。')
  })

  it('composes the passkey notice without a compiler', () => {
    const notice = `${t('account.passkeyRegisteredPrefix')}iPhone${t('account.passkeyRegisteredSuffix')}`

    expect(notice).toBe('已注册「iPhone」')
  })
})
