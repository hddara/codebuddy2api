<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app'

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
</script>

<template>
  <slot />
</template>
