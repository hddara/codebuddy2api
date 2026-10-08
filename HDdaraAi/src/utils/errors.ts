/**
 * Turning gateway errors into something a person can act on.
 *
 * Why this is one module: the test for "is this an auth rejection" was written
 * out five times — in the sessions list, the detail page, the live page (twice),
 * the login page (twice) — and each copy paired it with slightly different
 * wording for the same situation. The user's next step is always the same
 * (re-enter the console credential), so the instruction should be too.
 *
 * The detection is also worth centralising rather than trusting to a regex
 * repeated by hand: `ApiError` carries a numeric `code`, and matching on that is
 * exact, while string matching only works because the gateway happens to word
 * its message a certain way.
 */

/** The gateway's wording for "the admin session is not valid". */
const AUTH_PATTERN = /session required|401|unauthor/i

/**
 * Whether an error means the stored console credential was rejected.
 *
 * Checks the status code first: it is unambiguous, whereas the message is the
 * server's phrasing and can change. The string test remains as a fallback for
 * errors that arrive without a code — a failed `plus.net.XMLHttpRequest`, for
 * instance, reports a status but reaches here as a plain `Error`.
 */
export function isAuthError(error: unknown): boolean {
  if (!error)
    return false

  const code = (error as { code?: unknown }).code

  if (code === 401 || code === 403)
    return true

  const status = (error as { status?: unknown }).status

  if (status === 401 || status === 403)
    return true

  const message = error instanceof Error ? error.message : String(error)

  return AUTH_PATTERN.test(message)
}

/** The instruction shown when the console credential no longer works. */
export const REAUTH_HINT = '控制台凭据已失效，请到「设置」重新填入新的 Cookie'

/**
 * Turns a thrown value into the message to display.
 *
 * `fallback` is the operation's own wording ("加载会话失败"), used for anything
 * that is not an auth failure — a network drop, a 500, a timeout — because those
 * need no translation and the specific message is more useful than a generic one.
 */
export function describeError(error: unknown, fallback: string): string {
  if (isAuthError(error))
    return REAUTH_HINT

  if (error instanceof Error && error.message)
    return error.message

  return fallback
}
