import { useAuthStore } from '@/store/authStore'

/**
 * Sends the user to the lock screen unless this launch has been unlocked.
 *
 * Called from `onShow` of every page that shows session data. The lock screen is
 * the app's entry point, but that alone is not enough: a tab switch, a deep link
 * or a restored page stack can all land on a data page without it ever running,
 * and each of those would leak the user's traffic. Checking on show closes them.
 *
 * Returns `true` when the caller may proceed.
 */
export function ensureUnlocked(): boolean {
  const auth = useAuthStore()

  if (auth.unlocked && auth.hasCredentials) {
    return true
  }

  // `reLaunch` clears the stack: otherwise "back" returns to a data page the
  // guard just rejected, and the user bounces between the two.
  uni.reLaunch({ url: '/pages/login/index' })

  return false
}
