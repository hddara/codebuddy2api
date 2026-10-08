import type { Method } from 'alova'

import { useAuthStore } from '@/store/authStore'
import { markApiHealthy, reportApiFailure } from './base-url'

/** Trace id echoed by the gateway, when present. */
function pickTraceId(response: unknown): string | undefined {
  const headers = (response as { header?: unknown, headers?: unknown })?.header
    ?? (response as { headers?: unknown })?.headers

  if (!headers || typeof headers !== 'object')
    return undefined

  const record = headers as Record<string, unknown>
  const key = Object.keys(record).find(
    name => name.toLowerCase() === 'x-trace-id',
  )

  return key ? String(record[key]) : undefined
}

export class ApiError extends Error {
  code: number
  data?: unknown

  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.data = data
  }
}

/** Same toast repeated within this window is shown once. */
const ERROR_TOAST_DEDUPE_MS = 2000
let lastErrorToast = { at: 0, msg: '' }

function toastErrorOnce(msg: string): void {
  const now = Date.now()

  if (lastErrorToast.msg === msg && now - lastErrorToast.at < ERROR_TOAST_DEDUPE_MS) {
    return
  }

  lastErrorToast = { at: now, msg }
  uni.showToast({ icon: 'none', title: msg })
}

/**
 * Success path.
 *
 * The gateway answers with bare JSON (no `code`/`msg` envelope on `/admin-api`
 * and `/v1`), so the body is returned as-is. HTTP failures raise `ApiError`,
 * which is what the app's pages catch.
 */
/**
 * Consecutive auth rejections since the last successful response.
 *
 * Kept module-local rather than on the store: it is transient request state, not
 * something the user can configure, and persisting it would make one bad session
 * look worse after a restart.
 */
const AUTH_REJECTION_THRESHOLD = 3

let consecutiveAuthRejections = 0

const authRejectionStreak = {
  record: (): number => {
    consecutiveAuthRejections += 1

    return consecutiveAuthRejections
  },
  reset: (): void => {
    consecutiveAuthRejections = 0
  },
}

export async function handleAlovaResponse(response: unknown): Promise<unknown> {
  const { statusCode, data } = response as {
    statusCode?: number
    data?: unknown
  }
  const status = Number(statusCode ?? 0)

  // The credential demonstrably works, so the failure streak is over.
  if (status && status < 400) {
    authRejectionStreak.reset()
  }

  // Reaching the gateway at all proves the base URL works, even for 4xx.
  // 5xx is excluded: a broken node typically answers 502/503/504.
  if (status && status < 500) {
    markApiHealthy()
  }

  if (status >= 400) {
    const message
      = (data as { error?: { message?: string } })?.error?.message
        ?? `HTTP ${status}`

    if (status === 401 || status === 403) {
      // Do NOT clear the credential on the first rejection.
      //
      // A single 401 is not proof the credential is invalid: the gateway also
      // answers 401 while its session store is still warming up, and the App
      // fires several requests in parallel on cold start. Dropping the cookie
      // there looked like "the settings I just saved disappeared" and forced the
      // user to retype them. Two consecutive rejections is treated as genuine.
      const store = useAuthStore()
      const previous = store.adminCookie
      const failures = authRejectionStreak.record()

      // The credential is deliberately **not** deleted here, not even when the
      // rejection is genuine. Clearing it turns a recoverable 401 into a secret
      // the user has to fetch again, and the gateway answers 401 during a cold
      // start while its session store is still warming up — observed on a device
      // signing the user out with a credential that was still good. Keeping it
      // leaves the fix reachable (the settings page works with a stale
      // credential) and loses nothing if the rejection was transient.
      if (previous && failures >= AUTH_REJECTION_THRESHOLD) {
        // Once, not on every following request: the streak keeps growing while
        // the credential is stale, and repeating the toast would bury the page.
        if (failures === AUTH_REJECTION_THRESHOLD) {
          toastErrorOnce('登录已失效，请到「设置」重新填写凭据')
        }
      }
      else {
        // Deliberately not the server's wording: rejection messages are English
        // (`Invalid password`) and describe the gateway's view rather than the
        // user's next step. The page that made the request shows the specific
        // reason in Chinese, so the toast only has to say the credential was not
        // accepted.
        toastErrorOnce('凭据未被接受，请检查账号或密码')
      }

      throw new ApiError(message, status, data)
    }

    if (status >= 500) {
      reportApiFailure('server', `HTTP ${status}`)
      toastErrorOnce('网关暂时不可用，请稍后重试')
    }
    else {
      toastErrorOnce(message)
    }

    throw new ApiError(message, status, data)
  }

  if (import.meta.env.MODE === 'development') {
    console.log('[Alova Response]', pickTraceId(response), data)
  }

  return data
}

// `method` is optional because the alova `onError` hook types it as possibly
// absent; it is only used for development logging.
export function handleAlovaError(error: unknown, method?: Method): never {
  if (import.meta.env.MODE === 'development') {
    console.error('[Alova Error]', error, method)
  }

  const candidate = error as { message?: string, name?: string, errMsg?: string }
  const message = candidate?.message ?? candidate?.errMsg ?? ''
  const name = candidate?.name ?? ''

  if (name === 'NetworkError' || message.includes('request:fail')) {
    toastErrorOnce('网络连接失败，请稍后重试')
    // A reachable network that still cannot reach this base URL means the node
    // itself is bad, so the next request re-resolves it.
    reportApiFailure('network', message || 'NetworkError')
  }
  else if (name === 'TimeoutError' || message.toLowerCase().includes('timeout')) {
    toastErrorOnce('请求超时，请重试')
    reportApiFailure('timeout', message || 'TimeoutError')
  }
  else if (error instanceof ApiError) {
    // Already reported by the response handler; avoid duplicating the toast.
  }
  else {
    toastErrorOnce(message || '请求失败')
  }

  throw error
}
