import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_THEME_COLORS, useThemeStore } from '@/store/themeStore'

/**
 * The token file, read as text.
 *
 * `NATIVE_THEME_COLORS` duplicates hex values that also live in `theme.scss`,
 * because the APIs that consume them take literal colours rather than `var()`.
 * That duplication is the risk this suite exists to catch: a theme change made
 * in one place and not the other shows up as a nav bar that does not match the
 * page it floats over, which no unit test of either file alone would notice.
 */
const themeScss = readFileSync(
  fileURLToPath(new URL('../../src/styles/theme.scss', import.meta.url)),
  'utf-8',
)

/**
 * Reads a token out of the stylesheet.
 *
 * Scoped rather than "first match": the file declares every token once per
 * theme, so a naive match returns the light value twice and would silently pass
 * a broken dark theme. `scope` is anchored on the theme block's own selector so
 * the two reads are independent.
 */
function scssToken(name: string, scope: 'dark' | 'light'): string | undefined {
  const marker = `\n.theme-${scope} {`
  const start = themeScss.indexOf(marker)

  if (start < 0)
    return undefined

  // Up to the block's closing brace; the next theme block starts after it.
  const block = themeScss.slice(start, themeScss.indexOf('\n}', start))

  const match = block.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`))

  return match?.[1]?.toLowerCase()
}

/**
 * Every block that re-declares the dark palette.
 *
 * The file has to repeat the dark values twice — once on `.theme-dark`, which
 * the store toggles, and once on `.page.theme-dark`, which wins on the page
 * root — and that duplication is load-bearing but easy to half-edit. Adding a
 * token to one block and not the other leaves the value undefined wherever the
 * other block applies, which is a silent failure: the property falls back to
 * `inherit`, so the element renders in the *parent's* colour rather than
 * nothing.
 */
function darkBlocks(): { name: string, body: string }[] {
  const found: { name: string, body: string }[] = []
  const pattern = /^(\.theme-dark|\.page\.theme-dark)\s*\{/gm

  for (const match of themeScss.matchAll(pattern)) {
    const start = match.index ?? 0
    found.push({
      name: match[1],
      body: themeScss.slice(start, themeScss.indexOf('\n}', start)),
    })
  }

  return found
}

/** Every `--c-*` token a block declares, as a sorted list of names. */
function declaredTokens(body: string): string[] {
  return [...body.matchAll(/--(c-[\w-]+)\s*:/g)].map(m => m[1]).sort()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('uni', {
    setBackgroundColor: vi.fn(),
    setNavigationBarColor: vi.fn(),
    setTabBarStyle: vi.fn(),
  })
  vi.stubGlobal('plus', undefined)
})

describe('native theme colors', () => {
  it('keeps the page background in step with the stylesheet', () => {
    // `background` paints the webview container, which sits behind the page.
    // If it drifts from `--c-page` the seam shows on any screen shorter than
    // the viewport.
    expect(NATIVE_THEME_COLORS.dark.background.toLowerCase()).toBe(
      scssToken('c-page', 'dark'),
    )
    expect(NATIVE_THEME_COLORS.light.background.toLowerCase()).toBe(
      scssToken('c-page', 'light'),
    )
  })

  it('reads the stylesheet, not just itself', () => {
    // Guards the guard: if the anchor selector ever changes, `scssToken`
    // returns undefined and every comparison above passes vacuously.
    expect(scssToken('c-page', 'dark')).toMatch(/^#[0-9a-f]{6}$/)
    expect(scssToken('c-page', 'light')).toMatch(/^#[0-9a-f]{6}$/)
    expect(scssToken('c-page', 'dark')).not.toBe(scssToken('c-page', 'light'))
  })

  it('keeps the chrome in step with the card surface', () => {
    // The bar reads as the top edge of the page's card, so it tracks
    // `--c-surface` rather than `--c-page`: matching the page colour instead
    // would leave the bar visibly darker than the cards it sits above, which
    // is the same mismatch in the other direction.
    expect(NATIVE_THEME_COLORS.dark.bar.toLowerCase()).toBe(
      scssToken('c-surface', 'dark'),
    )
    expect(NATIVE_THEME_COLORS.light.bar.toLowerCase()).toBe(
      scssToken('c-surface', 'light'),
    )
  })

  it('pairs a light chrome with dark text and the reverse', () => {
    // The pairing is what keeps the clock legible. A bar and its text chosen
    // independently is how a theme ends up with white-on-white chrome.
    expect(NATIVE_THEME_COLORS.dark.textStyle).toBe('white')
    expect(NATIVE_THEME_COLORS.light.textStyle).toBe('black')
  })
})

describe('dark palette blocks', () => {
  it('declares the same tokens in every block that re-states the palette', () => {
    // Two blocks carry the dark values, because the page root has to win on
    // specificity. A token added to only one of them resolves to nothing where
    // the other applies — and because an unresolvable custom property falls
    // back to `inherit` rather than failing, the symptom is a wrong colour in
    // one place instead of an error anywhere.
    const blocks = darkBlocks()

    expect(blocks.length).toBeGreaterThanOrEqual(2)

    const [first, ...rest] = blocks
    const expected = declaredTokens(first.body)

    // Guards the guard: an empty parse would make every comparison below
    // pass without reading anything.
    expect(expected.length).toBeGreaterThan(10)

    for (const block of rest) {
      expect(declaredTokens(block.body), `${block.name} vs ${first.name}`).toEqual(expected)
    }
  })

  it('declares the floating tab bar tokens in both themes', () => {
    // The bar is drawn in the webview now, so it reads these through `var()`
    // like any other surface. A missing declaration is invisible until the bar
    // renders transparent and the page shows through it.
    const shared = [
      'c-tabbar-from',
      'c-tabbar-to',
      'c-tabbar-border',
      'c-tabbar-icon',
      'c-tabbar-icon-active',
      'c-tabbar-active-from',
      'c-tabbar-active-to',
    ]

    for (const token of shared) {
      expect(scssToken(token, 'dark'), `dark ${token}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(scssToken(token, 'light'), `light ${token}`).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('keeps the active tab icon on the same accent as the rest of the app', () => {
    // The selected entry has to belong to the same system as the primary
    // button and the active chip. A tab bar whose accent drifts is the most
    // visible version of two-themes-in-one-screen, because the bar is on every
    // screen that has it.
    expect(scssToken('c-tabbar-icon-active', 'dark')).toBe(scssToken('c-primary', 'dark'))
    expect(scssToken('c-tabbar-icon-active', 'light')).toBe(scssToken('c-primary', 'light'))
  })

  it('does not leave the tab bar the same lightness as the page it floats over', () => {
    // The bar is a floating surface, so it cannot be the page colour: it would
    // vanish into the background and the rounded edge that makes it read as
    // floating would be the only thing left showing.
    expect(scssToken('c-tabbar-from', 'dark')).not.toBe(scssToken('c-page', 'dark'))
    expect(scssToken('c-tabbar-from', 'light')).not.toBe(scssToken('c-page', 'light'))
  })
})

describe('themeStore.apply', () => {
  it('drives the cross-platform nav bar from the same table', () => {
    // Miniprogram and H5 reach their title bar through this API alone, so it
    // has to agree with the App's native path.
    const store = useThemeStore()
    const { setNavigationBarColor } = uni as unknown as {
      setNavigationBarColor: ReturnType<typeof vi.fn>
    }

    store.apply()

    expect(setNavigationBarColor).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: NATIVE_THEME_COLORS[store.resolved].bar,
      }),
    )
  })

  it('survives a runtime that has neither API', () => {
    // A browser build and a miniprogram differ in which of these exist. The
    // theme must degrade to the page class rather than throw and leave the
    // screen unstyled.
    //
    // This is the synchronous failure mode: the member is absent, so the call
    // raises `TypeError` before any promise exists.
    vi.stubGlobal('uni', {})
    const store = useThemeStore()

    expect(() => store.apply()).not.toThrow()
  })

  it('survives an API that fails by rejecting', async () => {
    // The other failure mode, and the one that broke the app.
    //
    // On the H5 and App runtimes these calls are promises: with no page mounted
    // `setNavigationBarColor` *rejects* rather than throwing, so a plain
    // `try`/`catch` around the call looked like a guard and was not one. The
    // rejection reached the runtime's global handler and — because `apply()`
    // runs from `applyInitialTheme()` before the first page exists — stranded
    // startup on a blank screen.
    const rejected = vi.fn(() => Promise.reject(new Error('setNavigationBarColor:fail page not found')))
    vi.stubGlobal('uni', {
      setBackgroundColor: vi.fn(),
      setNavigationBarColor: rejected,
    })

    const store = useThemeStore()

    expect(() => store.apply()).not.toThrow()
    // Both calls were attempted; the point is that neither escapes.
    expect(rejected).toHaveBeenCalled()

    // Give the rejection a turn to surface. An unhandled one would fail the run
    // rather than this assertion, which is the desired outcome either way.
    await Promise.resolve()
  })
})
