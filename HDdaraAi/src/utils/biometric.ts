/**
 * Fingerprint / face unlock for the app lock screen.
 *
 * Wraps the App runtime's `plus.fingerprint` behind a promise with a uniform
 * result, because callers need to distinguish "the user failed" from "this device
 * cannot do it" — only the second should fall back to another method.
 *
 * The browser build has no equivalent, so it reports `unsupported` and the lock
 * screen simply does not offer it.
 */

export type BiometricSupport = 'available' | 'unsupported' | 'unavailable'

export interface BiometricResult {
  /** True only when the OS reported a successful match. */
  ok: boolean
  /** Why it failed, for the user-facing message. */
  reason?: 'cancelled' | 'failed' | 'locked' | 'unsupported' | 'error'
  message?: string
}

interface PlusFingerprint {
  authenticate?: (
    success: () => void,
    fail: (error: { code?: number, message?: string }) => void,
    options?: { message?: string, timeout?: number },
  ) => void
  isSupport?: () => boolean
  isKeyguardSecure?: () => boolean
}

function fingerprint(): PlusFingerprint | undefined {
  try {
    const scope = globalThis as { plus?: { fingerprint?: PlusFingerprint } }
    return scope.plus?.fingerprint
  }
  catch {
    // Reading a missing global is safe, but the App runtime has thrown here
    // before for other bridge members — never let this break the caller.
    return undefined
  }
}

/** Whether this device can currently do biometric unlock. */
export function biometricSupport(): BiometricSupport {
  const api = fingerprint()

  if (!api?.isSupport || !api.authenticate)
    return 'unsupported'

  try {
    if (!api.isSupport())
      return 'unsupported'
    // A device can have the hardware but no enrolled credential; the API
    // reports that separately and the lock screen should then say so rather
    // than offering something that always fails.
    if (api.isKeyguardSecure && !api.isKeyguardSecure())
      return 'unavailable'
  }
  catch {
    return 'unsupported'
  }

  return 'available'
}

/**
 * Prompts for a fingerprint or face match.
 *
 * `message` is what the OS sheet shows; keep it short, it is truncated on some
 * Android skins.
 */
export function authenticateBiometric(
  message = '验证身份以解锁',
): Promise<BiometricResult> {
  const api = fingerprint()

  if (!api?.authenticate) {
    return Promise.resolve({ ok: false, reason: 'unsupported' })
  }

  return new Promise<BiometricResult>((resolve) => {
    try {
      api.authenticate!(
        () => resolve({ ok: true }),
        (error) => {
          // A user-triggered cancel is not a failure worth shouting about; any
          // other code is surfaced so the screen can offer the fallback.
          const text = String(error?.message ?? '')

          if (/cancel|取消/i.test(text)) {
            resolve({ ok: false, reason: 'cancelled' })
            return
          }

          resolve({ ok: false, reason: 'failed', message: text || '验证未通过' })
        },
        { message, timeout: 30_000 },
      )
    }
    catch (error) {
      resolve({ ok: false, reason: 'error', message: String(error) })
    }
  })
}
