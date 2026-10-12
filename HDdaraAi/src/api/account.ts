import {
  consoleDelete,
  consoleGet,
  consolePost,
} from './core/console'

/**
 * Console account management: who is signed in, how they sign in, and what
 * other credentials can reach the same account.
 *
 * Until now the app could only *use* a credential obtained elsewhere — the
 * session views worked and nothing else did. Renaming the account, changing its
 * password, or dropping a passkey all required opening the desktop console,
 * which is exactly the trip the app exists to avoid.
 */

/** What the gateway knows about the account, without any credential material. */
export interface AdminSessionSummary {
  /** True once a password or a passkey exists; until then the console is open. */
  accountConfigured: boolean
  /** The account's own on/off switch. */
  authEnabled: boolean
  /** Whether *this* request carried a valid session. */
  authenticated: boolean
  passkeyCount: number
  passwordConfigured: boolean
  username: string
}

export interface AdminSessionPayload {
  session: AdminSessionSummary
}

/** One registered passkey, as the list endpoint reports it. */
export interface StoredPasskey {
  /** ISO timestamp. */
  createdAt: string
  deviceType?: string | null
  /** Whether the authenticator syncs it (iCloud Keychain, say). */
  backedUp?: boolean | null
  id: string
  name: string
}

/**
 * The fields a screen may show.
 *
 * `publicKey` and `counter` are deliberately dropped rather than left for each
 * caller to omit: they are credential material, they have no meaning to a user,
 * and a screen that renders whatever it was handed would print them.
 *
 * Exported for its own test. It is a security boundary — the only thing standing
 * between the server's record and a template — and a projection that silently
 * started passing fields through would look like a successful fetch.
 */
export function toVisiblePasskey(record: Record<string, unknown>): StoredPasskey {
  return {
    backedUp: (record.backedUp ?? null) as boolean | null,
    createdAt: String(record.createdAt ?? ''),
    deviceType: (record.deviceType ?? null) as string | null,
    id: String(record.id ?? ''),
    name: String(record.name ?? ''),
  }
}

/**
 * Reads the current session. Works signed in or out; it is also how the app
 *  discovers whether the account is set up at all.
 */
export async function fetchAdminSession(): Promise<AdminSessionPayload> {
  return consoleGet<AdminSessionPayload>('/admin-api/auth/session')
}

/**
 * Signs out.
 *
 * Only the session used for this request is dropped — the account stays
 * configured and other devices keep working. That is the behaviour a user
 * expects from "sign out" on a phone, as opposed to the account-wide teardown
 * that disabling authentication performs.
 */
export async function logoutAdminSession(): Promise<{ success: boolean }> {
  return consoleDelete<{ success: boolean }>('/admin-api/auth/session')
}

export interface ChangePasswordInput {
  /** Required: the server verifies it even though a session is already held. */
  currentPassword: string
  /** Must be at least 8 characters. */
  nextPassword?: string
  /** 3–64 characters when present. */
  username?: string
}

/**
 * Changes the password or the username.
 *
 * The server clears every *other* session on success, so any other signed-in
 * device is signed out — worth telling the user before they confirm.
 */
export async function changeAdminPassword(
  input: ChangePasswordInput,
): Promise<{ success: boolean }> {
  return consolePost<{ success: boolean }>('/admin-api/auth/password', input)
}

/** Lists the passkeys registered to the account. */
export async function fetchPasskeys(): Promise<StoredPasskey[]> {
  const payload = await consoleGet<{ passkeys?: Record<string, unknown>[] }>(
    '/admin-api/auth/passkeys',
  )

  return (payload.passkeys ?? []).map(toVisiblePasskey)
}

/**
 * Removes one passkey.
 *
 * The server refuses to remove the last one while no password is set (409),
 * because that would lock the account open — the caller should surface that
 * message rather than retry.
 */
export async function deletePasskey(id: string): Promise<{ success: boolean }> {
  return consoleDelete<{ success: boolean }>(
    `/admin-api/auth/passkeys/${encodeURIComponent(id)}`,
  )
}

/**
 * What disables the account, for the confirmation copy.
 *
 * Not exported as a call, only as a description, because the app does not offer
 * this: turning authentication off from a phone clears every session and all
 * passkeys on the way out, and the console is the place for a change that
 * sweeping. The constant exists so the screens can explain the state a user may
 * find themselves in after doing it elsewhere.
 */
export const DISABLE_AUTH_WARNING
  = '关闭认证会清除密码、全部通行密钥与所有登录会话，之后控制台将不再需要登录。'
