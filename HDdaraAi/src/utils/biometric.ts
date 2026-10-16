/**
 * Face ID / fingerprint unlock for the app lock screen.
 *
 * Built on `uni.startSoterAuthentication` rather than `plus.fingerprint`.
 *
 * That is not a preference. `plus.fingerprint` is a Touch-ID-era API: DCloud
 * documents it as "指纹识别" and its own sample message reads 「通过Home键验证已有手机
 * 指纹」. On a Face-ID iPhone it answers `isSupport() === false` and every
 * `authenticate()` fails with `UNSUPPORT(1)` / "No Touch ID Device" — measured on
 * an iPhone 12, where `isEnrolledFingerprints()` reported `true` at the same
 * time, which is impossible for a device with no fingerprint sensor and is the
 * tell that the answer describes hardware the phone does not have.
 *
 * The SOTER API takes the mode as an argument instead of assuming one, so the
 * same code covers Face ID and Touch ID.
 *
 * Every probe here is asynchronous because the bridge is: measured on device,
 * `checkIsSupportSoterAuthentication`'s `success` fired at 28ms while the call
 * itself did not return until 48ms. A synchronous reader would therefore always
 * see the pre-callback state and conclude the device had no sensor, which is why
 * the probe is a promise and the middle layer caches its answer.
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
  /** The module is present and the device is ready to authenticate. */
  = | 'available'
    /** No module at all — a browser build, or a shell without it packaged in. */
    | 'unsupported'
    /** Module is fine; nothing is enrolled, or no passcode is set. */
    | 'unavailable'

export interface BiometricResult {
  /** True only when the OS reported a successful match. */
  ok: boolean
  /** Why it failed, for the user-facing message. */
  reason?: 'cancelled' | 'failed' | 'locked' | 'unsupported' | 'error'
  message?: string
}

/** The two auth modes the module can ask for. */
export type AuthMode = 'facial' | 'fingerPrint'

interface SoterSupportResult {
  /** Which modes this device can do. Empty means neither. */
  supportMode?: string[]
}

interface SoterEnrolledResult {
  isEnrolled?: boolean
}

interface SoterError {
  errCode?: number
  errMsg?: string
}

/**
 * SOTER error codes, from the API reference.
 *
 * Only the ones that change the message are named; everything else folds into
 * `failed`, which is the honest reading of "the match did not happen".
 */
const SOTER_CANCEL = 90008
const SOTER_LOCKOUT = 90010
const SOTER_MISMATCH = 90009

/**
 * Which sensor this phone unlocks with.
 *
 * On iOS the sensor is fixed by the hardware, so the platform decides without a
 * capability round-trip. Asking for `fingerPrint` on a Face-ID phone would
 * answer "not enrolled" for a sensor that does not exist, which is the exact
 * misreading this module was rewritten to avoid.
 */
export function biometricMode(): AuthMode {
  try {
    const info = uni.getSystemInfoSync() as { platform?: string }

    if (String(info.platform ?? '').toLowerCase() === 'ios')
      return 'facial'
  }
  catch {
    // Fall through: `fingerPrint` is the only mode the other platforms have.
  }

  return 'fingerPrint'
}

/**
 * Whether the call that actually performs a match is present.
 *
 * Only `startSoterAuthentication` is required, because that is the one the
 * prompt needs. Folding the two probe calls in as well would refuse to
 * authenticate on a shell that ships the authentication but not the capability
 * queries — a combination the module does not forbid, and which would show the
 * feature as missing on a device that can do it.
 */
function soterAvailable(): boolean {
  try {
    return typeof uni.startSoterAuthentication === 'function'
  }
  catch {
    return false
  }
}

/** Whether both capability probes are present, needed to decide *state*. */
function probesAvailable(): boolean {
  try {
    return typeof uni.checkIsSupportSoterAuthentication === 'function'
      && typeof uni.checkIsSoterEnrolledInDevice === 'function'
  }
  catch {
    return false
  }
}

/**
 * Whether this device can currently do biometric unlock.
 *
 * Three answers, each from a distinct source: the bridge existing, the platform
 * naming a usable mode, and that mode being enrolled. A negative from any of them
 * is a different problem for the user — and only the last one is theirs to fix,
 * which is why the state is returned rather than a boolean.
 */
export async function probeBiometricSupport(): Promise<BiometricSupport> {
  if (!soterAvailable())
    return 'unsupported'

  // A shell that ships authentication but no probes cannot be asked what it can
  // do. Reported as unavailable rather than unsupported: the bridge is there, so
  // the device may well be able to authenticate; refusing the switch outright
  // would be the more damaging of the two guesses.
  if (!probesAvailable())
    return 'unavailable'

  // Asked directly rather than inferred from hardware: `supportMode` lists the
  // modes the *module* can drive, which is what the caller needs, and it comes
  // back empty when the FaceId subspec is missing from the shell build.
  const modes = await readSupportModes()
  const mode = biometricMode()

  // Logged because this verdict is the whole answer to "why will the switch not
  // turn on", and on a release build there is no other way to read it: the
  // sandbox cannot be attached to, so these values are the only evidence of what
  // the platform reported.
  console.info('[biometric] probe', JSON.stringify({ mode, modes }))

  // The platform is asked first, then the mode: a shell without the module
  // answers "supported: no" for every mode, and reporting that as "nothing
  // enrolled" would send the user into settings to fix a build problem.
  if (!modes.length)
    return 'unsupported'

  if (!modes.includes(mode))
    return 'unsupported'

  if (!(await readEnrolled(mode)))
    return 'unavailable'

  return 'available'
}

/** Resolves the modes the module can drive. An unreadable reply is empty. */
function readSupportModes(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      uni.checkIsSupportSoterAuthentication({
        complete: (result: SoterSupportResult) => {
          resolve(Array.isArray(result?.supportMode) ? result.supportMode : [])
        },
        fail: () => resolve([]),
        success: (result: SoterSupportResult) => {
          resolve(Array.isArray(result?.supportMode) ? result.supportMode : [])
        },
      } as never)
    }
    catch {
      resolve([])
    }
  })
}

/**
 * Enrolment state for a mode.
 *
 * Unlike `plus.fingerprint`'s probe, this one takes the mode: asking whether *a*
 * fingerprint is enrolled on a Face-ID phone is what returned a misleading
 * `true` before, and the answer has to be about the sensor in use.
 *
 * An unreadable reply is `false` rather than `true`: the only caller uses this to
 * decide whether to offer the switch, and offering it on a device that reports
 * nothing is what produced a prompt that could never succeed.
 */
function readEnrolled(mode: AuthMode): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      uni.checkIsSoterEnrolledInDevice({
        checkAuthMode: mode,
        complete: (result: SoterEnrolledResult) => {
          resolve(Boolean(result?.isEnrolled))
        },
        fail: () => resolve(false),
        success: (result: SoterEnrolledResult) => {
          resolve(Boolean(result?.isEnrolled))
        },
      } as never)
    }
    catch {
      resolve(false)
    }
  })
}

/**
 * The biometric hardware this device actually has, for wording purposes.
 *
 * Naming the wrong sensor sends the reader to a settings screen that does not
 * exist: an iPhone has no 「指纹」 page, so "请录入指纹" is an instruction the
 * user cannot follow. iOS and the App runtime both expose the platform, so the
 * label can say Face ID or 指纹 rather than the hedge 「指纹 / 面容」.
 *
 * Falls back to the hedge when the platform is unknown, which is the honest
 * answer rather than a guess.
 *
 * `withSuffix` composes the "解锁" title in one place. It exists because Latin
 * and Han script need a space between them — "面容 ID解锁" is the kind of detail
 * that reads as machine output — while "指纹解锁" needs none. Concatenating at
 * the call site would have to know that, and would get it wrong twice.
 */
export function biometricLabel(withSuffix = false): string {
  const name = readBiometricName()

  return withSuffix ? `${name}${name.includes('ID') ? ' ' : ''}解锁` : name
}

/** The bare sensor name, without the action. */
function readBiometricName(): string {
  try {
    const info = uni.getSystemInfoSync() as { platform?: string }
    const platform = String(info.platform ?? '').toLowerCase()

    // `ios` covers iPhone and iPad; both use Face ID on the models that have
    // biometrics at all, and the older Touch ID iPads are rare enough that the
    // hedge is a better default than a second probe.
    if (platform === 'ios')
      return '面容 ID'

    if (platform === 'android')
      return '指纹'
  }
  catch {
    // No system info available; the hedge below is still correct.
  }

  return '指纹 / 面容'
}

/**
 * The name of the system-settings pane that enrols biometrics.
 *
 * Separated from `biometricLabel` because the two do not vary together: iOS
 * calls the sensor 「面容 ID」 but the pane 「面容 ID 与密码」, while Android's
 * pane name differs per vendor and is not derivable from the sensor at all — so
 * the generic name is used there rather than a guess that would send the reader
 * looking for a page their phone does not have.
 */
export function biometricSettingsPane(): string {
  try {
    const info = uni.getSystemInfoSync() as { platform?: string }

    if (String(info.platform ?? '').toLowerCase() === 'ios')
      return '面容 ID 与密码'
  }
  catch {
    // Fall through to the generic name.
  }

  return '指纹、面部与密码'
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
 *
 * The `unavailable` wording names the actual sensor and the actual destination,
 * because the reader's next step is to leave the app: "未设置面容 ID" plus the
 * path to the switch is actionable, while a bare "请录入" left an iPhone user
 * hunting for a fingerprint page that does not exist.
 */
export function describeBiometricFailure(state: BiometricSupport): string {
  if (state === 'unavailable') {
    // The system settings app names the pane 「面容 ID 与密码」 on iOS and
    // 「指纹、面部与密码」 on Android; naming it exactly is what makes the
    // sentence followable, so the platform suffix is part of the label rather
    // than appended here.
    return `未设置${biometricLabel()}，请到系统设置的「${biometricSettingsPane()}」中开启后重试`
  }

  // `unsupported`: no module, so nothing the user can change from here. Said
  // plainly and without blaming their device, because the app genuinely cannot
  // tell whether it is the platform or the build.
  return `当前设备不支持${biometricLabel(true)}，请改用密码登录`
}

/**
 * Prompts for a face or fingerprint match.
 *
 * `authContent` is what the OS sheet shows; keep it short, the API caps it at 42
 * characters and some Android skins truncate it sooner.
 */
export function authenticateBiometric(
  message = '验证身份以解锁',
): Promise<BiometricResult> {
  if (!soterAvailable())
    return Promise.resolve({ ok: false, reason: 'unsupported' })

  return new Promise<BiometricResult>((resolve) => {
    try {
      uni.startSoterAuthentication({
        authContent: message,
        fail: (error: SoterError) => {
          // The whole error, not just the message: the numeric `errCode` is what
          // tells "user cancelled" apart from "no match" and "locked out", and a
          // release build has no other way to report which one happened.
          console.info('[biometric] authenticate failed', JSON.stringify(error))

          const code = Number(error?.errCode)

          if (code === SOTER_CANCEL) {
            resolve({ ok: false, reason: 'cancelled' })
            return
          }

          if (code === SOTER_LOCKOUT) {
            resolve({ ok: false, reason: 'locked', message: '尝试次数过多，请改用手机密码解锁' })
            return
          }

          if (code === SOTER_MISMATCH) {
            resolve({ ok: false, reason: 'failed', message: '未能识别，请重试' })
            return
          }

          // No `errCode` at all means the call was rejected before the sheet
          // appeared — the prompt never ran, so it is not a mismatch the user
          // can retry their way out of.
          resolve({
            ok: false,
            reason: 'failed',
            message: error?.errMsg ? '验证未通过，请重试' : '验证未通过',
          })
        },
        requestAuthModes: [biometricMode()],
        success: () => {
          console.info('[biometric] authenticate ok')
          resolve({ ok: true })
        },
      } as never)
    }
    catch (error) {
      console.info('[biometric] authenticate threw', String(error))
      resolve({ ok: false, reason: 'error', message: String(error) })
    }
  })
}
