import { defineStore } from 'pinia'

/**
 * Gateway credential + admin session state.
 *
 * Two credential shapes exist and both are needed:
 *  - `adminCookie`: the signed console cookie, obtained by signing in on the
 *    login page. Required for the `/admin-api/*` endpoints that back the app.
 *  - `apiKey`: a gateway API key (`cb2_...`). Used when the app talks to the
 *    `/v1/*` endpoints directly.
 *
 * Only the cookie is needed for the session views; the API key field exists so
 * the same app can also act as a client of the model gateway later.
 */
/** Cookie name the gateway's console session lives under. */
export const ADMIN_COOKIE_NAME = 'codebuddy_admin_session'

/**
 * Reduces whatever was typed into the cookie field to the bare session token.
 *
 * Handles the shapes seen in practice — `name=value`, `name=value; other=x`,
 * a `Cookie` header copied verbatim, a bare token, and a value duplicated by a
 * form that was not cleared. `String.prototype.replace` with a global pattern is
 * used instead of a loop because the duplicate may repeat many times.
 */
export function normalizeAdminCookie(input: string): string {
  const trimmed = input.trim()

  if (!trimmed)
    return ''

  // Take the first `name=value` pair if a whole cookie header was pasted.
  const firstPair = trimmed.split(';')[0].trim()
  const raw = firstPair.includes('=')
    ? (firstPair.slice(firstPair.indexOf('=') + 1) || '')
    : firstPair

  const token = raw.trim()

  if (!token)
    return ''

  // Collapse `abcabc` (and `abcabcabc`) back to `abc`. A token repeated an odd
  // number of times still reduces to the base value.
  for (let size = 1; size <= Math.floor(token.length / 2); size += 1) {
    if (token.length % size !== 0)
      continue

    const unit = token.slice(0, size)

    if (unit.repeat(token.length / size) === token) {
      return unit
    }
  }

  return token
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    /** Raw `Cookie` header value captured from a successful console login. */
    adminCookie: '',
    /** Gateway API key, if the user pasted one in settings. */
    apiKey: '',
    /** Gateway origin, e.g. `https://code.apimesh.cn`. */
    baseUrl: '',
    /** Display name resolved from the console session, when available. */
    displayName: '',
    isLoggedIn: false,
    /**
     * Whether the lock screen has been passed in *this* launch.
     *
     * Deliberately not persisted: storing it would let anyone with the device
     * skip the unlock by relaunching the app, which defeats the point of
     * requiring a fingerprint at all. It resets to false on every cold start.
     */
    unlocked: false,
  }),
  getters: {
    /**
     * Credential attached to outgoing requests by the alova interceptor.
     *
     * The interceptor sends `Authorization: Bearer <token>`; for console
     * endpoints the cookie is sent instead via the `Cookie` header, so this
     * getter returns whichever credential is present.
     */
    getToken: (state): string => state.adminCookie || state.apiKey,
    hasCredentials: (state): boolean =>
      Boolean(state.adminCookie || state.apiKey),
  },
  actions: {
    /**
     * Stores the console session token in its canonical form.
     *
     * The field is free text, so anything can arrive: a bare token, the full
     * `name=value`, a whole `Cookie` header, or — seen on a device — the same
     * value pasted twice because the form was not cleared first. Normalising on
     * write keeps every consumer from having to guess, and it collapses the
     * duplicated case, which otherwise produced a token that 401'd with no hint
     * as to why.
     */
    setAdminCookie(cookie: string) {
      this.adminCookie = normalizeAdminCookie(cookie)
      this.isLoggedIn = Boolean(this.adminCookie || this.apiKey)
    },
    setApiKey(apiKey: string) {
      this.apiKey = apiKey.trim()
      this.isLoggedIn = Boolean(this.adminCookie || this.apiKey)
    },
    /**
     * Recomputes the derived flag after the state was restored wholesale.
     *
     * `persist.ts` assigns `store.$state` directly on cold start, which replaces
     * the fields without running the setters — so `isLoggedIn` kept its initial
     * `false` even with a cookie present, and the session page reported
     * "not signed in" until the user re-saved the form.
     */
    syncLoginState() {
      this.isLoggedIn = Boolean(this.adminCookie || this.apiKey)
    },
    /** Marks the lock screen as passed for this launch. */
    unlock() {
      this.unlocked = true
    },
    /**
     * Re-locks without signing out.
     *
     * Called when the app goes to the background so that returning to it asks
     * for the fingerprint again — the credential itself stays on disk.
     */
    lock() {
      this.unlocked = false
    },
    setBaseUrl(baseUrl: string) {
      this.baseUrl = baseUrl.replace(/\/+$/, '')
    },
    logout() {
      this.adminCookie = ''
      this.apiKey = ''
      this.displayName = ''
      this.isLoggedIn = false
    },
  },
})
