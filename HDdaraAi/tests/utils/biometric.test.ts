import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  authenticateBiometric,
  biometricLabel,
  biometricMode,
  biometricSettingsPane,
  describeBiometricFailure,
  probeBiometricSupport,
} from '@/utils/biometric'

/**
 * Stands in for the App runtime's SOTER bridge.
 *
 * The two probes answer asynchronously — measured on device, `success` fired at
 * 28ms while the call itself did not return until 48ms — so the stub calls back
 * on a later turn. A stub that answered synchronously would let a synchronous
 * reader pass here while failing on the phone, which is exactly the bug this
 * module was rewritten for.
 */
function stubSoter(options: {
  authenticated?: boolean
  authMode?: string
  authModes?: string[]
  enrolled?: boolean | 'throw'
  missingAuth?: boolean
  missingSupport?: boolean
}) {
  const {
    authenticated = true,
    authMode = 'facial',
    authModes = ['facial'],
    enrolled = true,
    missingAuth = false,
    missingSupport = false,
  } = options

  const bridge: Record<string, unknown> = {
    startSoterAuthentication: missingAuth
      ? undefined
      : (opts: Record<string, (...args: unknown[]) => void>) => {
          setTimeout(() => {
            if (authenticated)
              opts.success?.({ authMode, errCode: 0, errMsg: 'ok' })
            else
              opts.fail?.({ errCode: 90008, errMsg: 'cancel' })
          }, 0)
        },
  }

  if (!missingSupport) {
    bridge.checkIsSupportSoterAuthentication = (opts: Record<string, (...args: unknown[]) => void>) => {
      setTimeout(() => opts.success?.({ errMsg: 'ok', supportMode: authModes }), 0)
    }

    bridge.checkIsSoterEnrolledInDevice = (opts: Record<string, (...args: unknown[]) => void>) => {
      setTimeout(() => {
        if (enrolled === 'throw') {
          opts.fail?.({ errMsg: 'not support' })
          return
        }

        opts.success?.({ errMsg: 'ok', isEnrolled: enrolled })
      }, 0)
    }
  }

  vi.stubGlobal('uni', { ...bridge, getSystemInfoSync: () => ({ platform: 'ios' }) })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('biometricMode', () => {
  it('asks for Face ID on iOS', () => {
    vi.stubGlobal('uni', { getSystemInfoSync: () => ({ platform: 'ios' }) })

    expect(biometricMode()).toBe('facial')
  })

  it('asks for a fingerprint elsewhere', () => {
    vi.stubGlobal('uni', { getSystemInfoSync: () => ({ platform: 'android' }) })

    expect(biometricMode()).toBe('fingerPrint')
  })

  it('falls back to the fingerprint mode when the platform is unreadable', () => {
    // Android is the platform that has a choice; iOS never reads this value.
    vi.stubGlobal('uni', {
      getSystemInfoSync: () => {
        throw new Error('bridge unavailable')
      },
    })

    expect(biometricMode()).toBe('fingerPrint')
  })
})

describe('probeBiometricSupport', () => {
  it('reports available on a device that is ready', async () => {
    stubSoter({})

    await expect(probeBiometricSupport()).resolves.toBe('available')
  })

  it('reports unsupported when the bridge is absent', async () => {
    // A browser build, or a shell packaged without the module.
    vi.stubGlobal('uni', {})

    await expect(probeBiometricSupport()).resolves.toBe('unsupported')
  })

  it('reports unavailable, not unsupported, when only the probes are missing', async () => {
    // The bridge that performs a match is present, so the device may well be
    // able to authenticate — only the queries used to describe its state are
    // absent. Calling that "unsupported" would switch the feature off on a
    // device that can do it.
    stubSoter({ missingSupport: true })

    await expect(probeBiometricSupport()).resolves.toBe('unavailable')
  })

  it('reports unsupported when the module drives no mode at all', async () => {
    // The state the shell was actually in before FaceId was linked in:
    // `supportMode` came back empty even though the device has Face ID.
    stubSoter({ authModes: [] })

    await expect(probeBiometricSupport()).resolves.toBe('unsupported')
  })

  it('reports unsupported when the platform does not offer the mode this phone uses', async () => {
    // A fingerprint-only module on a Face-ID phone; asking for a fingerprint
    // would answer "not enrolled" about a sensor that is not there.
    stubSoter({ authModes: ['fingerPrint'] })

    await expect(probeBiometricSupport()).resolves.toBe('unsupported')
  })

  it('reports unavailable when nothing is enrolled', async () => {
    stubSoter({ enrolled: false })

    await expect(probeBiometricSupport()).resolves.toBe('unavailable')
  })

  it('reports unavailable when the enrolment probe cannot answer', async () => {
    // Failing closed: offering the switch on a device that reports nothing is
    // what produced a prompt that could never succeed.
    stubSoter({ enrolled: 'throw' })

    await expect(probeBiometricSupport()).resolves.toBe('unavailable')
  })

  it('waits for the asynchronous reply instead of reading the pre-answer state', async () => {
    // The regression this guards: `checkIsSupportSoterAuthentication` calls back
    // after the call has already returned, so a synchronous reader sees an empty
    // `supportMode` and declares a Face-ID phone unsupported.
    stubSoter({ authModes: ['facial'] })

    const pending = probeBiometricSupport()

    // A promise, not a value — the caller cannot have been given the answer yet.
    expect(pending).toBeInstanceOf(Promise)

    await expect(pending).resolves.toBe('available')
  })
})

describe('authenticateBiometric', () => {
  it('resolves ok on a successful match', async () => {
    stubSoter({ authenticated: true })

    await expect(authenticateBiometric()).resolves.toEqual({ ok: true })
  })

  it('reports a user cancel as cancelled, not as a failure to shout about', async () => {
    // 90008 is the user changing their mind; saying anything about it is noise.
    stubSoter({ authenticated: false })

    await expect(authenticateBiometric()).resolves.toMatchObject({
      ok: false,
      reason: 'cancelled',
    })
  })

  it('reports unsupported without touching the bridge when it is absent', async () => {
    vi.stubGlobal('uni', {})

    await expect(authenticateBiometric()).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('requests the mode this device actually has', async () => {
    let requested: string[] = []

    vi.stubGlobal('uni', {
      getSystemInfoSync: () => ({ platform: 'ios' }),
      startSoterAuthentication: (opts: Record<string, unknown>) => {
        requested = opts.requestAuthModes as string[]
        ;(opts.success as () => void)()
      },
    })

    await authenticateBiometric()

    expect(requested).toEqual(['facial'])
  })
})

describe('describeBiometricFailure', () => {
  it('points at the device settings for a device problem', () => {
    expect(describeBiometricFailure('unavailable')).toContain('系统设置')
  })

  it('names the settings pane the reader has to open', () => {
    // "请先在系统设置中录入" named a destination but not a page, and an iPhone
    // user looking for a fingerprint pane does not have one. The pane has to be
    // spelled out for the sentence to be followable.
    const message = describeBiometricFailure('unavailable')

    expect(message).toMatch(/「[^」]+」/)
    expect(message).toContain('开启')
  })

  it('offers the password path when the device cannot do it at all', () => {
    expect(describeBiometricFailure('unsupported')).toContain('密码')
  })

  it('never blames the installation', () => {
    // The wording this replaces said 当前安装包未包含指纹模块 to every failure,
    // including on an iPhone whose shell ships the whole Face ID stack. A user
    // cannot rebuild the app, so that sentence left them with nothing to do.
    for (const state of ['unavailable', 'unsupported'] as const) {
      expect(describeBiometricFailure(state)).not.toContain('安装包')
    }
  })

  it('says something different for each cause', () => {
    // One sentence with a clause swapped would send both readers to the same
    // place, and only one of them can fix it there.
    expect(describeBiometricFailure('unavailable')).not.toBe(
      describeBiometricFailure('unsupported'),
    )
  })
})

/**
 * Naming the sensor.
 *
 * The hedge 「指纹 / 面容」 named both at once, which on an iPhone points at a
 * settings page that does not exist — the reader's next step is to leave the
 * app and open a specific pane, so the text has to say which one.
 */
describe('biometricLabel', () => {
  function stubPlatform(platform: string | undefined) {
    vi.stubGlobal('uni', {
      getSystemInfoSync: () => (platform === undefined ? {} : { platform }),
    })
  }

  it('names Face ID on iOS', () => {
    stubPlatform('ios')

    expect(biometricLabel()).toBe('面容 ID')
  })

  it('names the fingerprint sensor on Android', () => {
    stubPlatform('android')

    expect(biometricLabel()).toBe('指纹')
  })

  it('falls back to naming both when the platform is unknown', () => {
    // Guessing here would be worse than the hedge: the wrong name sends the
    // reader to a settings page their device does not have.
    stubPlatform(undefined)

    expect(biometricLabel()).toBe('指纹 / 面容')
  })

  it('survives a throwing bridge', () => {
    vi.stubGlobal('uni', {
      getSystemInfoSync: () => {
        throw new Error('bridge unavailable')
      },
    })

    expect(biometricLabel()).toBe('指纹 / 面容')
  })

  it('spaces the suffix after Latin script but not after Han', () => {
    // "面容 ID解锁" is the tell that a string was concatenated without looking:
    // Han and Latin need a space between them, two Han runs do not.
    stubPlatform('ios')
    expect(biometricLabel(true)).toBe('面容 ID 解锁')

    stubPlatform('android')
    expect(biometricLabel(true)).toBe('指纹解锁')
  })
})

describe('biometricSettingsPane', () => {
  it('names the iOS pane as the system settings app does', () => {
    vi.stubGlobal('uni', {
      getSystemInfoSync: () => ({ platform: 'ios' }),
    })

    expect(biometricSettingsPane()).toBe('面容 ID 与密码')
  })

  it('uses the generic name where the pane differs per vendor', () => {
    // Android's pane name varies by OEM and cannot be derived from the sensor,
    // so a specific guess would be wrong on most phones.
    vi.stubGlobal('uni', {
      getSystemInfoSync: () => ({ platform: 'android' }),
    })

    expect(biometricSettingsPane()).toBe('指纹、面部与密码')
  })
})
