import { onShow } from '@dcloudio/uni-app'

import { NATIVE_THEME_COLORS, useThemeStore } from '@/store/themeStore'

/**
 * Paints this page's native title bar to match the theme.
 *
 * ## Why this is per page
 *
 * The App runtime draws the title bar as a *native* control owned by each
 * page's webview — it is not a stylesheet surface and it is not shared. Two
 * consequences follow, and both bit:
 *
 * 1. `titleNView` is read by the runtime to size the bar:
 *
 *        titleNView.height = type === 'transparent' ? 0 : statusBarHeight + NAVBAR_HEIGHT
 *
 *    i.e. on an iPhone the bar spans the status bar *and* the navigation bar —
 *    the 91pt of white measured from a screenshot (47 + 44). So the reported
 *    "status bar is light" was the whole title bar being light, with only a 1pt
 *    separator making the status bar read as a separate strip. Fixing the status
 *    bar alone could never have worked.
 *
 * 2. `setStyle({ titleNView })` applies to *one* webview. Issuing it once from a
 *    store at launch painted the webview that happened to be current and left
 *    every page visited afterwards on the `#F7F7F7` default again. It has to run
 *    on each page's `onShow`, through that page's own `$getAppWebview()`.
 *
 * `plus.webview.currentWebview()` is deliberately *not* used: at launch it is
 * not yet the page being shown, and in a shared module it can be a different
 * page's webview entirely.
 *
 * ## Why onShow rather than onLoad
 *
 * `onShow` also fires on returning from a pushed page, which is exactly when a
 * stale bar is visible during the transition. On load-only the bar would be
 * correct until the first navigation away and back.
 *
 * The miniprogram and H5 have no native title bar; `uni.setNavigationBarColor`
 * in the store covers them, and the `#ifdef` keeps this a no-op there.
 */
export function useNativeChrome() {
  const theme = useThemeStore()

  const paint = () => {
    // #ifdef APP-PLUS
    const { background, bar, textStyle } = NATIVE_THEME_COLORS[theme.resolved]

    try {
      // `$getAppWebview` hangs off the page instance rather than the `plus`
      // namespace, so it is reached through the page stack. Guarded at each
      // step: it is absent on the miniprogram, and null before the webview is
      // attached — a throw here must not break the page.
      const pages = getCurrentPages()
      const page = pages[pages.length - 1] as unknown as {
        $getAppWebview?: () => {
          setStyle?: (style: Record<string, unknown>) => void
        } | null
      } | undefined

      const webview = page?.$getAppWebview?.()

      webview?.setStyle?.({
        titleNView: {
          backgroundColor: bar,
          titleColor: textStyle === 'white' ? '#ffffff' : '#000000',
        },
        /**
         * The webview's own backdrop.
         *
         * This is the window's back plate — what shows where the page does not
         * paint. It is *not* what a pull reveals; see `bounceBackground` below.
         */
        background,
        /**
         * What a pull actually reveals — the band this page was showing in white.
         *
         * Dragging past the top or bottom drags the whole webview off its
         * position, and the strip left behind is painted by the native layer
         * underneath. `background` does not reach it: the two are separate
         * surfaces, which is why a dark page could bounce against a white band
         * with `background` already set correctly.
         *
         * The strip starts from `pages.json`'s `globalStyle.backgroundColor` —
         * a build-time value that can hold one theme only, and holds the light
         * page colour — so it was white on every dark screen regardless of what
         * the page painted. No stylesheet can reach it; it sits below the
         * document, not inside it.
         *
         * Set per webview rather than once from the store for the same reason as
         * the title bar: `setStyle` applies to the one webview it is called on,
         * and a launch-time call would paint whichever page happened to be
         * current and leave every later page on the default.
         */
        bounceBackground: background,
      })
    }
    catch {
      // No page yet, or not the App runtime.
    }

    plus.navigator?.setStatusBarStyle?.(
      NATIVE_THEME_COLORS[theme.resolved].textStyle === 'white' ? 'light' : 'dark',
    )
    // #endif
  }

  onShow(paint)

  return { paint }
}
