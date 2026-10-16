import { useAuthStore } from '@/store/authStore'

/**
 * Every page that renders session data, in one place.
 *
 * Declared as a list rather than left to each page to remember: three pages
 * (`sessions/detail`, `sessions/live`, `sessions/transcript`) did not call the
 * guard at all, and those are precisely the ones that show the full text of a
 * conversation. A cold-start deep link or a restored page stack could therefore
 * land on stored answers while the app was locked — the lock screen was
 * decorative for anyone who knew a URL.
 *
 * The test suite walks this list, so a new data page that is not guarded fails
 * rather than going unnoticed.
 */
export const GUARDED_PAGES = [
  'pages/settings/index',
  'pages/settings/gateway',
  'pages/sessions/index',
  'pages/sessions/detail',
  'pages/sessions/live',
  'pages/sessions/transcript',
  'pages/account/index',
  'pages/account/usage',
  'pages/account/stats',
  'pages/credentials/index',
  'pages/credentials/keys',
] as const

/** Pages that must stay reachable while locked. */
export const PUBLIC_PAGES = ['pages/login/index'] as const

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
