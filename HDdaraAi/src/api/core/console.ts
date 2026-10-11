import { ADMIN_COOKIE_NAME, useAuthStore } from '@/store/authStore'
import { alovaInstance } from './instance'

/**
 * Shared plumbing for the console (`/admin-api/*`) endpoints.
 *
 * Every module that talks to the console needs the same three things — the auth
 * header, the JSON shape, and a way to read the two error shapes the server
 * actually produces — and each of them was being written out by hand. That is
 * how `sessions.ts` and the credential screens would drift apart on something
 * as load-bearing as "which header authenticates".
 */

/**
 * Auth header for console endpoints.
 *
 * The gateway authenticates these routes by the signed session cookie:
 * `Cookie: codebuddy_admin_session=<token>` is the shape that verifies.
 * Measured against production, all of these are rejected with 401:
 *
 *  - `Cookie: <bare token>` (no name — the value is not the token, the *cookie*
 *    is: the name is part of what gets signed)
 *  - `Authorization: Bearer <token>`
 *  - `Authorization: Bearer codebuddy_admin_session=<token>`
 *
 * The store already normalises what the user typed, so the token is taken from
 * there rather than re-parsed here.
 */
export function consoleHeaders(): Record<string, string> {
  const token = useAuthStore().adminCookie.trim()

  return token ? { Cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {}
}

/**
 * `consoleHeaders()` plus the flag that stops alova's interceptor from attaching
 * the credential a second time — in a shape the console rejects (`Bearer`).
 *
 * Kept apart from the plain headers because `skipToken` is not a header: it is a
 * boolean the interceptor reads, and folding it into a `Record<string, string>`
 * is why every call site used to carry an `as never`.
 */
function headers(): Record<string, unknown> {
  return { ...consoleHeaders(), skipToken: true }
}

/**
 * The message to show for a console failure.
 *
 * The server answers errors in **two shapes**, and they are both in use:
 * `{ error: { message } }` from the session and passkey routes, and
 * `{ error: string }` from the credential and access-key routes. Reading only
 * the first turned every credential error into "[object Object]" on screen,
 * which is worse than the raw string — it hides that anything was said at all.
 */
export function consoleErrorMessage(error: unknown, fallback: string): string {
  const value = (error as { data?: unknown })?.data ?? error
  const raw = (value as { error?: unknown })?.error

  if (typeof raw === 'string' && raw.trim()) {
    return raw
  }

  const message = (raw as { message?: unknown })?.message

  if (typeof message === 'string' && message.trim()) {
    return message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

/**
 * Runs a console request, mapping the transport and body shapes onto one result.
 *
 * Returning a discriminated union rather than throwing keeps the callers — which
 * are screens that must render something either way — from each having to wrap a
 * `try`/`catch` around the call and decide what a thrown value means.
 */
export async function consoleRequest<T>(
  run: () => Promise<T>,
): Promise<{ data: T, ok: true } | { error: string, ok: false }> {
  try {
    return { data: await run(), ok: true }
  }
  catch (error) {
    return {
      error: consoleErrorMessage(error, '请求失败，请稍后重试'),
      ok: false,
    }
  }
}

/** Shorthand for a `GET` that carries the console credential. */
export function consoleGet<T>(path: string): Promise<T> {
  return alovaInstance
    .Get<T>(path, { headers: headers() } as never)
    .send()
}

/** Shorthand for a `POST` that carries the console credential. */
export function consolePost<T>(path: string, body?: unknown): Promise<T> {
  return alovaInstance
    .Post<T>(path, body ?? {}, { headers: headers() } as never)
    .send()
}

/** Shorthand for a `PATCH` that carries the console credential. */
export function consolePatch<T>(path: string, body?: unknown): Promise<T> {
  return alovaInstance
    .Patch<T>(path, body ?? {}, { headers: headers() } as never)
    .send()
}

/** Shorthand for a `DELETE` that carries the console credential. */
export function consoleDelete<T>(path: string, body?: unknown): Promise<T> {
  return alovaInstance
    .Delete<T>(path, body === undefined ? undefined : (body as never), {
      headers: headers(),
    } as never)
    .send()
}

/** Shorthand for a `PUT` that carries the console credential. */
export function consolePut<T>(path: string, body?: unknown): Promise<T> {
  return alovaInstance
    .Put<T>(path, body ?? {}, { headers: headers() } as never)
    .send()
}
