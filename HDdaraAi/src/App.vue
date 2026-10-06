<script setup lang="ts">
import { onHide, onLaunch, onShow } from '@dcloudio/uni-app'

import { useAuthStore } from '@/store/authStore'

onLaunch(() => {
  const auth = useAuthStore()

  // Restore the gateway origin so requests work before any page mounts.
  if (!auth.baseUrl) {
    auth.setBaseUrl(String(import.meta.env.VITE_API_BASE_URL ?? ''))
  }

  // The persisted snapshot is assigned straight onto the store state, so the
  // derived `isLoggedIn` flag has to be recomputed here.
  auth.syncLoginState()
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
