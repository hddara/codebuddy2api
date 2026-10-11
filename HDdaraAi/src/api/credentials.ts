import {
  consoleGet,
  consolePost,
  consolePut,
} from './core/console'

/**
 * Upstream account credentials — the CodeBuddy logins the gateway rotates
 * between when it answers a request.
 *
 * Distinct from an **access key** (`access-keys.ts`): a credential is a real
 * upstream account, an access key is a `cb2_` token the app itself presents and
 * which is bound to a set of credentials. The two are shown on separate screens
 * because mixing them is how someone deletes the account they were using.
 *
 * Every field here comes from the list endpoint, which reports token material
 * only as `has_refresh_token` — the tokens themselves never leave the server.
 */

/** One credential, as listed. No secret material is present. */
export interface CredentialListItem {
  /** Seconds. */
  created_at: number | null
  domain: string
  email: string
  enterprise_id: number | string | null
  /** Seconds. */
  expires_at: number | null
  expires_in: number | null
  filename: string
  has_refresh_token: boolean
  /** Position in the list; select and delete both address a credential by this. */
  index: number
  is_expired: boolean
  name: string | null
  rate_limited_hits: number
  rate_limited_kind: 'frequency' | 'quota' | null
  rate_limited_reason: string | null
  /** Seconds. */
  rate_limited_until: number | null
  responses_passthrough: boolean
  scope: string | null
  session_state: string | null
  tenant_id: number | string | null
  /** Seconds. */
  time_remaining: number | null
  /** Pre-rendered by the server: `Unknown` | `expired` | `<n>m` | `<n>h` | `<n>d`. */
  time_remaining_str: string
  token_type: string
  upstream_protocol: 'chat' | 'responses'
  user_id: string
}

/** Lists every configured credential, newest state first. */
export async function fetchCredentials(): Promise<CredentialListItem[]> {
  const payload = await consoleGet<{ credentials?: CredentialListItem[] }>(
    '/admin-api/credentials',
  )

  return payload.credentials ?? []
}

/** Which credential the next request will use. */
export type CurrentCredential
  = | { status: 'no_credentials' }
    | {
      available_credential_count: number
      next_filename: string | null
      status: 'access_keys_enabled'
    }
    | {
      domain: string
      enterprise_id: number | string | null
      filename: string
      next_filename: string | null
      status: 'round_robin'
      tenant_id: number | string | null
      user_id: string
    }

export async function fetchCurrentCredential(): Promise<CurrentCredential> {
  return consoleGet<CurrentCredential>('/admin-api/credentials/current')
}

/**
 * Makes `index` the next credential used.
 *
 * Takes effect for subsequent requests only — a reply already streaming is not
 * interrupted — so this is safe to press while the app itself is polling.
 *
 * The endpoint answers 200 even when the index is out of range, with
 * `success: false`; the caller has to read the flag rather than the status.
 */
export async function selectCredential(
  index: number,
): Promise<{ message: string, success: boolean }> {
  return consolePost<{ message: string, success: boolean }>(
    '/admin-api/credentials/select',
    { index },
  )
}

/**
 * Deletes a credential.
 *
 * Two consequences worth warning about before calling: the credential is removed
 * from every access key that referenced it, and any conversation relying on it
 * will fail its next turn. Same out-of-range behaviour as `selectCredential`.
 */
export async function deleteCredential(
  index: number,
): Promise<{ message: string, success: boolean }> {
  return consolePost<{ message: string, success: boolean }>(
    '/admin-api/credentials/delete',
    { index },
  )
}

/** One credential's rate-limit window, when it is currently limited. */
export interface CredentialLimit {
  filename: string
  hits: number
  kind: 'frequency' | 'quota'
  /** Epoch milliseconds. */
  observedAt: number
  reason: string | null
  /** Epoch milliseconds — when it becomes usable again. */
  resumeAt: number
  /** Upstream HTTP status that triggered it. */
  status: number
  code: number | null
}

export async function fetchCredentialLimits(): Promise<CredentialLimit[]> {
  const payload = await consoleGet<{ limits?: CredentialLimit[] }>(
    '/admin-api/credentials/limits',
  )

  return payload.limits ?? []
}

/**
 * Clears rate-limit marks so the credentials are tried again immediately.
 *
 * Without a filename this clears every credential, which is the useful action
 * after the upstream recovers or its clock has moved on.
 */
export async function clearCredentialLimits(
  filename?: string,
): Promise<{ cleared: number, success: boolean }> {
  return consolePost<{ cleared: number, success: boolean }>(
    '/admin-api/credentials/limits',
    filename ? { filename } : {},
  )
}

/** Models per credential, keyed by filename. */
export type CredentialModels = Record<
  string,
  { error: string | null, models: { id: string }[] }
>

/**
 * Reads the model list the server already has saved.
 *
 * Cheap enough to call on every visit — no upstream request is made. Use
 * `refreshCredentialModels` when the list has to be current.
 */
export async function fetchCredentialModels(): Promise<CredentialModels> {
  const payload = await consoleGet<{ models?: CredentialModels }>(
    '/admin-api/credentials/models',
  )

  return payload.models ?? {}
}

/**
 * Pulls the model list from upstream and stores it.
 *
 * Slow: this is a real round trip to the provider, which is why the read path is
 * separate and the UI should show progress while it runs.
 */
export async function refreshCredentialModels(
  filename: string,
): Promise<CredentialModels> {
  const payload = await consolePost<{ models?: CredentialModels }>(
    '/admin-api/credentials/models',
    { filename },
  )

  return payload.models ?? {}
}

/**
 * Overwrites a credential's model list.
 *
 * A manual override for the case where upstream reports models the provider will
 * not actually serve — the list is free text, split on newlines and commas, so
 * a user can paste the two or three that work.
 */
export async function saveCredentialModels(
  filename: string,
  models: string,
): Promise<CredentialModels> {
  const payload = await consolePut<{ models?: CredentialModels }>(
    '/admin-api/credentials/models',
    { filename, models },
  )

  return payload.models ?? {}
}

/** Human-readable state for a credential, in the order that decides what matters. */
export function describeCredential(credential: CredentialListItem): string {
  if (credential.rate_limited_kind) {
    return credential.rate_limited_kind === 'quota' ? '配额受限' : '频率受限'
  }

  if (credential.is_expired) {
    return '已过期'
  }

  // `time_remaining_str` is the server's own rendering and already accounts for
  // the shapes above, so it is preferred over recomputing from `expires_at`.
  return credential.time_remaining_str || '有效'
}
