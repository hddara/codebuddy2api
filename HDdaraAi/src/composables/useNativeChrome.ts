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
         * The webview's own backdrop — what shows through an overscroll bounce.
         *
         * Dragging a page past its top or bottom reveals this layer rather than
         * the page, because the page has scrolled out of view. The runtime
         * initialises it from `pages.json`'s `globalStyle.backgroundColor`,
         * which can hold exactly one theme — it is the light page colour — so a
         * dark screen bounced against a white band. The stylesheet cannot reach
         * it: it is below the document, not part of it.
         *
         * Set from the page rather than the store for the same reason the title
         * bar is: this is per-webview, and the store only ever holds the one
         * that happened to be current at launch.
         */
        background,
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
