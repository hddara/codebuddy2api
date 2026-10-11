/**
 * Where a launch asked the app to go.
 *
 * Why this exists: the app could only ever be entered through the lock screen
 * and then navigated by hand. Nothing could open it *at* a page, so a link from
 * a notification, a share sheet or a QR code had nowhere to land.
 *
 * A launch destination does not bypass the lock screen — it is parked and
 * claimed after the unlock. Anyone holding the device must still authenticate
 * before they see the page they were sent to; the alternative would make the
 * fingerprint decorative, since a crafted link would skip it.
 *
 * The value is held in memory rather than storage on purpose. It is meaningful
 * only for the launch that carried it: persisting it would route the *next*
 * launch to a page the user did not ask for.
 */

/** Pages a launch may target. Anything else is ignored rather than guessed at. */
const ROUTABLE_PREFIXES = ['pages/sessions/index', 'pages/settings/index']

/** The path waiting to be claimed, or null when the launch was ordinary. */
let pendingRoute: string | null = null

/** Trims a leading slash and any query or fragment from an app path. */
function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? ''

  return withoutQuery.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * The route a launch option asked for, or null when it asked for nothing
 * usable.
 *
 * Accepts the shapes the platforms actually hand over: `pages/sessions/index`,
 * `/pages/sessions/index`, an absolute URL whose path names the page, and a
 * bare path with a query (`pages/sessions/index?windowMinutes=1440`, which the
 * query is dropped from here — the page reads its own parameters).
 *
 * A destination outside `ROUTABLE_PREFIXES` is refused. The allow-list is what
 * keeps a link from naming an arbitrary page: without it the value would be
 * handed straight to `reLaunch`, and the lock screen's guarantee that a cold
 * start begins at the entry point would only hold for launches that did not ask
 * for anything.
 */
export function takeLaunchRoute(options?: {
  path?: string
  query?: Record<string, unknown>
}): string | null {
  const raw = options?.path

  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }

  const path = normalizePath(raw)
  const allowed = ROUTABLE_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`),
  )

  return allowed ? path : null
}

/** Parks a destination for the unlock to claim. `null` clears any pending one. */
export function setPendingRoute(path: string | null): void {
  pendingRoute = path
}

/**
 * Claims the parked destination, if any.
 *
 * Reading clears it, so a route is claimed exactly once — two unlocks in one
 * launch (a background round-trip, say) must not send the user back to the same
 * page the second time.
 */
export function consumePendingRoute(): string | null {
  const route = pendingRoute
  pendingRoute = null

  return route
}

/** Test/teardown helper. */
export function resetLaunchRoute(): void {
  pendingRoute = null
}
