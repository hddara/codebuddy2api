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
    setAdminCookie(cookie: string) {
      this.adminCookie = cookie.trim()
      this.isLoggedIn = Boolean(this.adminCookie || this.apiKey)
    },
    setApiKey(apiKey: string) {
      this.apiKey = apiKey.trim()
      this.isLoggedIn = Boolean(this.adminCookie || this.apiKey)
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
