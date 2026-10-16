<script setup lang="ts">
import { onHide, onLaunch, onShow } from '@dcloudio/uni-app'

import { useAuthStore } from '@/store/authStore'
import { applyInitialTheme, watchSystemTheme } from '@/store/themeStore'
import { setPendingRoute, takeLaunchRoute } from '@/utils/launch-route'
import { hideNativeTabBar } from '@/utils/native-tabbar'

onLaunch((options) => {
  // Before anything renders: a theme applied after the first paint shows the
  // wrong colours for a frame, and on a cold start into the lock screen that
  // frame is the only thing the user sees.
  const theme = applyInitialTheme()

  watchSystemTheme(dark => theme.setSystemDark(dark))

  hideNativeTabBar()

  const auth = useAuthStore()

  // Restore the gateway origin so requests work before any page mounts.
  if (!auth.baseUrl) {
    auth.setBaseUrl(String(import.meta.env.VITE_API_BASE_URL ?? ''))
  }

  // The persisted snapshot is assigned straight onto the store state, so the
  // derived `isLoggedIn` flag has to be recomputed here.
  auth.syncLoginState()

  // Where the launch asked to go, if it asked. Recorded rather than navigated
  // to: the lock screen is the entry point and the app must establish who the
  // user is before it shows anything, so the destination waits for the unlock
  // instead of routing around it. See `launch-route.ts`.
  setPendingRoute(takeLaunchRoute(options))
})

/**
 * How long the app may stay in the background before it re-locks.
 *
 * Zero would lock on every app switch, including the brief one iOS makes when
 * the biometric sheet itself is presented — the user would unlock and land back
 * on the lock screen. A short grace period keeps the prompt usable while still
 * requiring re-authentication after a real absence.
 */
const LOCK_AFTER_BACKGROUND_MS = 30_000

let backgroundedAt = 0

onHide(() => {
  // Only records the moment. The actual lock happens on the way back in, so the
  // grace period below can be applied — locking here would also fire while the
  // biometric sheet is up, since presenting it backgrounds the app.
  backgroundedAt = Date.now()
})

onShow(() => {
  // Re-hidden on every return: the platform restores its own bar when the app
  // comes back from the background or from the biometric sheet, which would
  // leave the native strip sitting under ours.
  hideNativeTabBar()

  const auth = useAuthStore()

  if (!auth.unlocked || !backgroundedAt)
    return

  if (Date.now() - backgroundedAt >= LOCK_AFTER_BACKGROUND_MS) {
    auth.lock()
  }

  backgroundedAt = 0
})
</script>

<template>
  <slot />
</template>

<style lang="scss">
/**
 * Global, unscopped styles.
 *
 * The theme variables have to be declared exactly once, outside any page's
 * scope — a scoped copy per page would compile the palette into every screen's
 * stylesheet and leave the dark block needing to be repeated alongside it.
 * `App.vue` is the only place in this project that emits an unscoped rule.
 *
 * `@use` rather than `@import`: the latter is deprecated in modern Sass and
 * emits a warning per page that uses it.
 */
@use '@/styles/theme.scss';

/**
 * The document floor.
 *
 * `theme.scss` defines the variables on `page` / `.page` / `.theme-light` /
 * `.theme-dark`, but nothing paints the root element itself. A page taller than
 * its content — or one that does not set a background at all — therefore showed
 * whatever the runtime defaults to, which is the light page colour on every
 * target and is why a dark screen had a light strip under it.
 *
 * `background-color` on `page` also covers the area under the tab bar's safe
 * area, which no page root reaches.
 */
page {
  background-color: var(--c-page);
}

/* The same floor for the H5 and App runtimes, where the scroll container is
   `html`/`body` rather than the `page` element. */
/* #ifdef H5 || APP-PLUS */
html,
body {
  background-color: var(--c-page);
}
/* #endif */
</style>
