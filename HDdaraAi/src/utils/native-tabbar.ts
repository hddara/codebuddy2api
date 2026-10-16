/**
 * Hides the platform's own tab bar.
 *
 * The two root routes are registered in `pages.json`'s `tabBar.list` because
 * that registration is what `uni.switchTab` requires, and `switchTab` is the
 * only navigation that keeps a tab's page alive — the alternative, `reLaunch`,
 * destroyed the page it left and rebuilt the one it entered, so every tap
 * re-ran the target's `onShow` load and unmounted `AppTabBar` before its slide
 * could play. What read as the bar flickering was the page being recreated
 * under it.
 *
 * Registering the routes has a cost: the platform draws its own bar for them,
 * and that bar cannot be restyled (`uni.setTabBarStyle` takes a
 * `backgroundColor` and ignores it on the App runtime) and reserves its height
 * in the layout. Ours is drawn by `components/AppTabBar.vue` and floats, so the
 * platform's has to go.
 *
 * ## Why this is called from three places
 *
 * `uni.hideTabBar` silently does nothing when the bar is not up yet — the docs
 * are explicit that the tab bar APIs "需要在 tabbar 渲染后才能使用，避免在
 * tabbar 未初始化前使用". `onLaunch` fires long before that point, so a call
 * there alone leaves the native bar on screen, directly under the custom one.
 * Calling it from the tab pages' `onShow` covers the case the launch cannot,
 * because by then the bar provably exists.
 *
 * `fail` cannot be used to detect the no-op: on the App runtime the call
 * reports success even when nothing has been hidden, so the retry has to be
 * driven by timing rather than by an error.
 *
 * Repeat calls are harmless — hiding an already-hidden bar is a no-op — so
 * every entry point calls this unconditionally rather than tracking state that
 * the platform may have changed behind us (returning from the background, or
 * from the biometric sheet, can bring the bar back).
 */
const RETRY_DELAY_MS = 50
const MAX_ATTEMPTS = 20

let attempts = 0

/** Hides the platform tab bar, retrying briefly in case it is not up yet. */
export function hideNativeTabBar(): void {
  attempts = 0
  attempt()
}

function attempt(): void {
  uni.hideTabBar({
    animation: false,
    complete: () => {
      // Retry regardless of the reported outcome. On the App runtime the call
      // resolves successfully whether or not the bar existed, so a success is
      // not evidence that it was hidden — only a later screenshot is.
      if (attempts < MAX_ATTEMPTS) {
        attempts += 1
        setTimeout(attempt, RETRY_DELAY_MS)
      }
    },
  } as never)
}
