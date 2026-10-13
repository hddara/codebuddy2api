import { afterEach, describe, expect, it, vi } from 'vitest'

import { biometricSupport, describeBiometricFailure } from '@/utils/biometric'

/**
 * Stands in for the App runtime's `plus.fingerprint`.
 *
 * `isSupport` and `isKeyguardSecure` are the two probes the module makes, and
 * the point of these cases is which combination produces which message — so the
 * stub is driven entirely by those two flags.
 */
function stubFingerprint(
  api: Partial<{
    authenticate: () => void
    isKeyguardSecure: () => boolean
    isSupport: () => boolean
  }> | null,
) {
  vi.stubGlobal('plus', api ? { fingerprint: api } : undefined)
}

/** A bridge that behaves as a working, enrolled device. */
function ready(overrides: Record<string, unknown> = {}) {
  return {
    authenticate: () => {},
    isKeyguardSecure: () => true,
    isSupport: () => true,
    ...overrides,
  }
}

afterEach(() => {
  vi.stubGlobal('plus', undefined)
})

describe('biometricSupport', () => {
  it('reports available on a device that is ready', () => {
    stubFingerprint(ready())

    expect(biometricSupport()).toBe('available')
  })

  it('reports unsupported when there is no bridge at all', () => {
    // A browser build, or a shell packaged without the module.
    stubFingerprint(null)

    expect(biometricSupport()).toBe('unsupported')
  })

  it('reports unsupported when the bridge is present but incomplete', () => {
    stubFingerprint({ isSupport: () => true })

    expect(biometricSupport()).toBe('unsupported')
  })

  it('reports unavailable, not unsupported, when nothing is enrolled', () => {
    // This is the case the iPhone hit: `isSupport()` goes false when Face ID has
    // no enrolled face, which is a settings problem the user can fix — and
    // reporting it as `unsupported` produced a message about the build that
    // there was nothing to act on.
    stubFingerprint(ready({ isSupport: () => false }))

    expect(biometricSupport()).toBe('unavailable')
  })

  it('reports unavailable when the device has no passcode set', () => {
    stubFingerprint(ready({ isKeyguardSecure: () => false }))

    expect(biometricSupport()).toBe('unavailable')
  })

  it('keeps a working device working when only the extra probe throws', () => {
    // `isSupport()` already answered yes and the module is clearly present;
    // treating a failure in the *second*, optional probe as "unsupported" would
    // switch the feature off on a device that can do it.
    stubFingerprint(
      ready({
        isKeyguardSecure: () => {
          throw new Error('not implemented on this platform')
        },
      }),
    )

    expect(biometricSupport()).toBe('available')
  })

  it('reports unsupported when the support probe itself throws', () => {
    stubFingerprint(
      ready({
        isSupport: () => {
          throw new Error('bridge error')
        },
      }),
    )

    expect(biometricSupport()).toBe('unsupported')
  })
})

describe('describeBiometricFailure', () => {
  it('points at the device settings for a device problem', () => {
    expect(describeBiometricFailure('unavailable')).toContain('系统设置')
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
