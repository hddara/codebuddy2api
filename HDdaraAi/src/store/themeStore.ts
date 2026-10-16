import { defineStore } from 'pinia'

/**
 * Colour theme.
 *
 * Three settings rather than a boolean, because "follow the system" is a
 * different intent from "dark": a user who picks the system setting expects the
 * app to change when their phone does, and one who picks dark expects it not to.
 * Collapsing them into a boolean means the OS switch silently stops working the
 * first time somebody touches the app's.
 *
 * Kept out of `persistPlugin`'s automatic handling and read explicitly: the
 * theme has to be applied before the first paint, and the plugin restores state
 * asynchronously — see `applyInitialTheme`.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'theme-preference'

/** The class the stylesheet keys off. Named, not inlined, so CSS and TS agree. */
export const THEME_CLASS: Record<ResolvedTheme, string> = {
  dark: 'theme-dark',
  light: 'theme-light',
}

interface ThemeState {
  preference: ThemePreference
  /** What the system reports, kept current so `system` can be resolved. */
  systemDark: boolean
}

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

/**
 * Absorbs a `uni.*` chrome call whose failure is not worth reporting.
 *
 * Both failure modes have to be caught, because these APIs use both:
 *
 * 1. **Rejection.** On the H5 and App runtimes the call is a promise and fails
 *    by rejecting — `setNavigationBarColor:fail page not found` when no page is
 *    mounted yet. A surrounding `try`/`catch` does not see that, so the error
 *    escaped to the runtime's global handler.
 * 2. **Synchronous throw.** On targets that do not implement the API at all,
 *    the member is `undefined` and calling it raises `TypeError` before any
 *    promise exists. The `try`/`catch` this replaces was catching exactly this
 *    case — and only this case.
 *
 * Both matter for the same reason: `apply()` runs from `applyInitialTheme()`
 * before the first page exists, so an escape from either one strands startup.
 *
 * Callers here all treat the result as best-effort — a title bar colour is a
 * cosmetic detail, never a reason to stop the app.
 *
 * The argument is a thunk rather than a value so that the *invocation* is
 * inside the guard; passing `uni.setNavigationBarColor(...)` would evaluate the
 * call — and throw — before this function was ever entered.
 */
function swallow(call: () => Promise<unknown> | unknown): void {
  try {
    const result = call()

    if (result && typeof (result as Promise<unknown>).catch === 'function')
      (result as Promise<unknown>).catch(() => {})
  }
  catch {
    // Missing API, or a runtime that throws synchronously.
  }
}

/**
 * Reads the OS setting.
 *
 * `uni.getSystemInfoSync().osTheme` is the cross-platform source, but it is
 * absent on older builds and on the H5 target it is only populated when the
 * manifest opts into dark mode — so `matchMedia` is the fallback and `false`
 * the last resort. Light is the safe default: the app has always rendered light,
 * and guessing dark would change every existing user's screen on upgrade.
 */
function readSystemDark(): boolean {
  try {
    const info = uni.getSystemInfoSync() as { osTheme?: string }

    if (info.osTheme)
      return info.osTheme === 'dark'
  }
  catch {
    // Older runtimes throw rather than return a default; fall through.
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  return false
}

/**
 * The colours for the surfaces a stylesheet cannot reach.
 *
 * Duplicated from `theme.scss` because `globalStyle` and the navigation bar are
 * set through APIs that take literal colours, not `var()`: there is no selector
 * to hang a custom property on. Keeping them adjacent to the store at least puts
 * the two places a hex is written in the same file.
 *
 * Exported because the App runtime's title bar is per-page and has to be
 * repainted from the page (`useNativeChrome`); keeping one table means the
 * launch-time paint and the per-page paint cannot disagree.
 */
export const NATIVE_THEME_COLORS: Record<ResolvedTheme, {
  background: string
  bar: string
  /**
   * Which way the chrome's text should contrast.
   *
   * One value, read by every API that needs it: `setNavigationBarColor` wants
   * `'black' | 'white'`, `plus.navigator.setStatusBarStyle` wants the same
   * vocabulary, and `titleNView.titleColor` wants the hex form. Mapping here
   * keeps the two spellings from drifting into two fields.
   */
  textStyle: 'black' | 'white'
}> = {
  dark: {
    background: '#16181c',
    bar: '#1f2228',
    textStyle: 'white',
  },
  light: {
    background: '#f5f6f8',
    bar: '#ffffff',
    textStyle: 'black',
  },
}

export const useThemeStore = defineStore('theme', {
  state: (): ThemeState => ({
    preference: 'system',
    systemDark: false,
  }),

  getters: {
    /** The theme actually in effect, after resolving `system`. */
    resolved(state): ResolvedTheme {
      if (state.preference === 'system')
        return state.systemDark ? 'dark' : 'light'

      return state.preference
    },
  },

  actions: {
    /**
     * Applies the theme to the surfaces the stylesheet cannot reach.
     *
     * The page colours themselves need no work here: every page roots its
     * template in `<view class="page" :class="themeClass">`, so a change to
     * `resolved` re-renders the class and the CSS variables follow. That
     * indirection is deliberate — it is the only mechanism that works on the
     * miniprogram, which has no document to add a class to.
     *
     * What remains are the native chrome and the H5 page background, neither of
     * which is a stylesheet concern.
     *
     * Every call is guarded: `setNavigationBarColor` is a no-op before a page
     * exists and throws on some H5 builds, and a theme change must never be the
     * thing that breaks the screen.
     */
    apply() {
      const theme = this.resolved
      const { background, bar, textStyle } = NATIVE_THEME_COLORS[theme]

      // For the miniprogram and H5, where the title bar *is* the web one and
      // this API does reach it. On the App runtime it carries the text colour
      // only: the bar there is a native control whose backdrop comes from
      // `titleNView`, which `useNativeChrome` sets per page.
      //
      // The rejection is caught on the promise, not with `try`/`catch`. This
      // call is asynchronous: with no page mounted it rejects with
      // `setNavigationBarColor:fail page not found`, and a synchronous `catch`
      // does not see that — the rejection escapes to the runtime's global
      // handler. That is not cosmetic: `apply()` runs from `applyInitialTheme()`
      // before the first page exists, so the escape stranded startup and left a
      // blank screen on both H5 and the App.
      swallow(() => uni.setNavigationBarColor({
        backgroundColor: bar,
        frontColor: textStyle === 'white' ? '#ffffff' : '#000000',
      }))

      // #ifdef H5
      try {
        // Outside the page root: the area under a short page, and the overscroll
        // gutters, are painted by the document element. Leaving it light shows a
        // white band below any screen that does not fill the viewport.
        document.documentElement.style.backgroundColor = background
      }
      catch {
        // No document; the page class is enough.
      }
      // #endif

      /**
       * There is deliberately no `uni.setBackgroundColor` call here.
       *
       * The strip a pull reveals is a native layer below the document. It was
       * assumed to be reachable from here — the API is documented, and it takes
       * `backgroundColorTop` / `backgroundColorBottom`, which is exactly the
       * shape this problem has. It was measured on device instead: the member
       * is `undefined` on the App runtime, so the optional call short-circuited
       * and the invocation had never run once.
       *
       * `theme.json` handles the strip instead, resolved at build time per
       * system theme. `webview.setStyle({ bounceBackground })` was also tried
       * and has no effect on this runtime — the two dead ends are recorded so
       * the next person does not spend the same rounds on them.
       */

      // No tab-bar work here any more, and that is the point of the change.
      //
      // There is no native tab bar to colour: `pages.config.ts` no longer
      // registers one, because the platform draws it above the webview and
      // ignores every attempt to restyle it — `setTabBarStyle` accepted a
      // `backgroundColor` on the App runtime and did nothing with it, which is
      // why a white strip survived every earlier dark-mode fix.
      //
      // The bar is `components/AppTabBar.vue` now. It is ordinary DOM inside
      // the page, so it inherits the theme through CSS like everything else and
      // needs no entry here — deleting this call is the fix, not a regression.

      // The webview's own backdrop, which no page class can reach.
      //
      // A page only paints as far as its content goes; below that — and behind
      // the tab bar's safe area — the App runtime shows the *webview
      // container's* background, which it initialised to the light page colour
      // and never re-reads from CSS. In dark mode that left a light band under
      // every short page, visible on the login screen and the live page alike.
      //
      // The native title bar is *not* set here. It belongs to a single page's
      // webview, so painting it from a shared module fixed only whichever page
      // was current and let the next one revert to the default — `onShow` on
      // each page is the only place that runs with the right webview in hand,
      // which is what `useNativeChrome` does.
      //
      // `plus.webview.currentWebview()` is the only handle on this one: it is a
      // property of the *window*, shared by whichever page is showing. Guarded
      // because this runs at launch, and a throw would abort the theme rather
      // than just skip the background.
      try {
        // #ifdef APP-PLUS
        // `background` only. The strip a pull would reveal is not reachable
        // from here — `bounceBackground` has no effect on this runtime,
        // `uni.setBackgroundColor` does not exist on App, and the value is
        // baked in at build time. `pages.config.ts` turns the bounce off
        // instead, so there is no strip to paint.
        plus.webview?.currentWebview?.()?.setStyle?.({ background })
        // #endif
      }
      catch {
        // No webview yet at launch, or not the App runtime.
      }
    },

    /**
     * Sets the preference and applies it.
     *
     * Writes to storage directly rather than relying on the persist plugin: the
     * plugin's snapshot is taken on change but *restored* asynchronously, and the
     * theme has to be correct on the first frame — see `applyInitialTheme`.
     */
    setPreference(preference: ThemePreference) {
      this.preference = preference

      try {
        uni.setStorageSync(THEME_STORAGE_KEY, preference)
      }
      catch {
        // Storage full or unavailable; the in-memory value still applies.
      }

      this.apply()
    },

    /** Records an OS theme change, re-applying only if the user follows it. */
    setSystemDark(systemDark: boolean) {
      const changed = this.systemDark !== systemDark

      this.systemDark = systemDark

      if (changed && this.preference === 'system') {
        this.apply()
      }
    },
  },
})

/**
 * Applies the stored theme before the app renders.
 *
 * Called from `onLaunch`, which is the earliest point the store exists.
 * `pinia` is still being set up when `createApp` runs, so the read of storage
 * happens here rather than there — but it must not wait for the persistence
 * plugin, or the first frame flashes the wrong theme.
 *
 * Returns the store so the caller can subscribe to system changes.
 */
export function applyInitialTheme(): ReturnType<typeof useThemeStore> {
  const store = useThemeStore()

  store.systemDark = readSystemDark()

  try {
    const stored = uni.getStorageSync(THEME_STORAGE_KEY)

    if (isPreference(stored)) {
      store.preference = stored
    }
  }
  catch {
    // Unreadable storage leaves the default in place, which is correct.
  }

  store.apply()

  return store
}

/**
 * Watches the OS theme.
 *
 * `uni.onThemeChange` is the cross-platform hook. The `matchMedia` listener is
 * registered on H5 as well because the hook is not fired there on every build —
 * a listener that is redundant is harmless, one that is missing means the app
 * stops following the system.
 *
 * Returns a disposer. The app never unsubscribes, but a test does.
 */
export function watchSystemTheme(
  onChange: (dark: boolean) => void,
): () => void {
  const disposers: (() => void)[] = []

  try {
    uni.onThemeChange?.((event) => {
      onChange(event.theme === 'dark')
    })
    disposers.push(() => {
      uni.offThemeChange?.(() => {})
    })
  }
  catch {
    // Not available; the listener below may still be.
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (event: MediaQueryListEvent) => onChange(event.matches)

    query.addEventListener('change', handler)
    disposers.push(() => query.removeEventListener('change', handler))
  }

  return () => disposers.forEach(dispose => dispose())
}
