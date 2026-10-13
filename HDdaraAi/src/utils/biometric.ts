/**
 * Fingerprint / face unlock for the app lock screen.
 *
 * Wraps the App runtime's `plus.fingerprint` behind a promise with a uniform
 * result, because callers need to distinguish "the user failed" from "this device
 * cannot do it" — only the second should fall back to another method.
 *
 * The browser build has no equivalent, so it reports `unsupported` and the lock
 * screen simply does not offer it.
 *
 * The three failure states are kept apart because they need different wording.
 * Collapsing them was what produced "当前安装包未包含指纹模块" on an iPhone whose
 * shell ships the whole Face ID stack: the sentence blamed the build for
 * something that was either the platform or the user's own settings, and there
 * was nothing the reader could do with it.
 */

export type BiometricSupport
  /** The bridge is present and the device is ready to authenticate. */
  = | 'available'
    /** No bridge at all — a browser build, or a shell without the module. */
    | 'unsupported'
    /** Hardware and module are fine; nothing is enrolled, or no passcode is set. */
    | 'unavailable'

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

  let hardwareReady: boolean

  try {
    hardwareReady = api.isSupport()
  }
  catch {
    return 'unsupported'
  }

  // `isSupport()` is documented as "the device has usable biometric hardware",
  // but on iOS it also goes false when nothing is enrolled — and `authenticate`
  // would then always fail. Both readings mean the same thing to the caller:
  // there is nothing on this device to match against, which is a settings
  // problem the user can fix, not a missing module.
  //
  // Which of the two it is cannot be told apart from here, so the state is
  // reported as `unavailable` — the wording that points at the device — rather
  // than as a build that lacks something.
  if (!hardwareReady)
    return 'unavailable'

  try {
    if (api.isKeyguardSecure && !api.isKeyguardSecure())
      return 'unavailable'
  }
  catch {
    // The check itself failing says nothing about the hardware; the module is
    // present and `isSupport()` already said yes, so proceed rather than
    // downgrading a working device to unsupported.
  }

  return 'available'
}

/**
 * What to tell a user who turned biometric unlock on but cannot use it.
 *
 * Written per state rather than from one sentence with a clause swapped: the
 * three causes lead to three different actions, and a message that names the
 * wrong one sends the reader somewhere useless. The previous wording blamed the
 * installation ("当前安装包未包含指纹模块") for every case, including one on an
 * iPhone whose shell ships the whole Face ID stack — leaving the user with
 * nothing to do, since they cannot rebuild the app.
 */
export function describeBiometricFailure(state: BiometricSupport): string {
  if (state === 'unavailable') {
    return '设备未设置指纹或面容，请先在系统设置中录入'
  }

  // `unsupported`: no bridge, so nothing the user can change from here. Said
  // plainly and without blaming their device, because the app genuinely cannot
  // tell whether it is the platform or the build.
  return '当前设备不支持指纹或面容解锁，请改用密码登录'
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
