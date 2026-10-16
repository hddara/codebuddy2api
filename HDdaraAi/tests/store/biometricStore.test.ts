import type { Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBiometricStore } from '@/store/biometricStore'
import { uniStub } from '../setup'

/**
 * The biometric preference used to live in a bare storage key written from the
 * lock screen, which meant the settings page could not offer the switch and the
 * capability probe was memoised for the life of the process. These cases pin the
 * behaviour that replaced it: one owner for the value, a re-runnable probe, and
 * an opt-in that is never recorded without a successful authentication.
 *
 * The bridge stubbed here is SOTER, not `plus.fingerprint`. The old API only
 * drives Touch ID, so on a Face-ID iPhone it answered "unsupported" for a device
 * that could authenticate — and these tests used to encode that wrong answer as
 * the expected behaviour.
 */

/**
 * A bridge that matches on the first prompt.
 *
 * Both probes and the prompt call back asynchronously, as the real bridge does —
 * measured on device, the capability callback fired at 28ms while the call
 * itself did not return until 48ms. A stub that answered synchronously would let
 * a synchronous reader pass here while failing on the phone.
 */
function stubReadyBridge(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('uni', {
    checkIsSoterEnrolledInDevice: (opts: Record<string, (...a: unknown[]) => void>) => {
      setTimeout(() => opts.success?.({ isEnrolled: true }), 0)
    },
    checkIsSupportSoterAuthentication: (opts: Record<string, (...a: unknown[]) => void>) => {
      setTimeout(() => opts.success?.({ supportMode: ['facial'] }), 0)
    },
    getSystemInfoSync: () => ({ platform: 'ios' }),
    startSoterAuthentication: (opts: Record<string, (...a: unknown[]) => void>) => {
      setTimeout(() => opts.success?.({ authMode: 'facial', errCode: 0 }), 0)
    },
    ...overrides,
  })
}

/**
 * A device with the bridge but nothing enrolled — the fixable case.
 *
 * The prompt succeeds if it is ever reached: the point is that it must not be,
 * since `enableWithConfirmation` checks support first.
 */
function stubNoEnrolment() {
  stubReadyBridge({
    checkIsSoterEnrolledInDevice: (opts: Record<string, (...a: unknown[]) => void>) => {
      setTimeout(() => opts.success?.({ isEnrolled: false }), 0)
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  uniStub.__reset()
})

afterEach(() => {
  // Restores the shared `uni` stub rather than clearing every global: the
  // storage spies the cases above assert on live on that object, and
  // `unstubAllGlobals()` takes them with it.
  vi.stubGlobal('uni', uniStub)
})

describe('biometricStore — persisted opt-in', () => {
  it('starts off, so a module-less build is never probed automatically', () => {
    const store = useBiometricStore()

    expect(store.enabled).toBe(false)
  })

  it('restores the opt-in written under the previous build', () => {
    // The key carries over on purpose: renaming it would silently switch the
    // feature off for everyone who had already turned it on.
    uniStub.__storage.set('biometric-enabled', true)

    const store = useBiometricStore()

    expect(store.loadEnabled()).toBe(true)
    expect(store.enabled).toBe(true)
  })

  it('writes the opt-in so the next launch can read it', () => {
    const store = useBiometricStore()

    store.setEnabled(true)

    expect(uniStub.setStorageSync).toHaveBeenCalledWith('biometric-enabled', true)
    expect(uniStub.__storage.get('biometric-enabled')).toBe(true)
  })

  it('keeps the value in memory when storage refuses the write', () => {
    // Losing the preference costs the next launch, not the current session —
    // failing the toggle the user just made would be the worse outcome.
    ;(uniStub.setStorageSync as Mock).mockImplementationOnce(() => {
      throw new Error('storage full')
    })

    const store = useBiometricStore()

    expect(() => store.setEnabled(true)).not.toThrow()
    expect(store.enabled).toBe(true)
  })
})

describe('biometricStore — capability probe', () => {
  it('reports available on a ready device', async () => {
    stubReadyBridge()

    await expect(useBiometricStore().refreshSupport()).resolves.toBe('available')
  })

  it('reports unavailable when nothing is enrolled', async () => {
    stubNoEnrolment()

    await expect(useBiometricStore().refreshSupport()).resolves.toBe('unavailable')
  })

  it('re-probes on every call, so enrolling a face is picked up', async () => {
    // The regression this covers: the probe result was cached in a ref and only
    // computed when `'unknown'`, so a user sent to system settings to enrol a
    // face came back to the same "未设置" until the process was killed.
    stubNoEnrolment()

    const store = useBiometricStore()

    await expect(store.refreshSupport()).resolves.toBe('unavailable')

    stubReadyBridge()

    await expect(store.refreshSupport()).resolves.toBe('available')
    expect(store.support).toBe('available')
  })

  it('does not fake support when a probe has not yet run', () => {
    const store = useBiometricStore()

    expect(store.support).toBe('unknown')
    expect(store.usable).toBe(false)
  })

  it('switches the opt-in off when the device loses its enrolment', async () => {
    // Otherwise every launch prompts into a guaranteed failure instead of
    // falling back to the credential form.
    stubReadyBridge()

    const store = useBiometricStore()

    store.setEnabled(true)
    stubNoEnrolment()
    await store.refreshSupport()

    expect(store.enabled).toBe(false)
    expect(store.shouldPrompt).toBe(false)
  })
})

describe('biometricStore — turning it on', () => {
  it('only opts in after the device authenticates', async () => {
    stubReadyBridge()

    const store = useBiometricStore()
    const failure = await store.enableWithConfirmation()

    expect(failure).toBeNull()
    expect(store.enabled).toBe(true)
  })

  it('refuses to enable when the device cannot prompt', async () => {
    // The capability probe reports that a bridge exists, not that this person's
    // face will match — enabling without a prompt is how a switch gets set on a
    // device that then fails on every launch.
    stubNoEnrolment()

    const store = useBiometricStore()
    const failure = await store.enableWithConfirmation()

    expect(failure?.ok).toBe(false)
    expect(store.enabled).toBe(false)
  })

  it('stays off when the user cancels, and reports it as a cancel', async () => {
    stubReadyBridge({
      startSoterAuthentication: (opts: Record<string, (...a: unknown[]) => void>) => {
        // 90008 is the documented code for a dismissed sheet.
        setTimeout(() => opts.fail?.({ errCode: 90008, errMsg: 'cancel' }), 0)
      },
    })

    const store = useBiometricStore()
    const failure = await store.enableWithConfirmation()

    expect(failure?.ok).toBe(false)
    expect(failure?.reason).toBe('cancelled')
    expect(store.enabled).toBe(false)
  })

  it('turns off without asking for authentication', () => {
    // Leaving must never be gated behind the thing being switched off.
    const start = vi.fn()
    stubReadyBridge({ startSoterAuthentication: start })

    const store = useBiometricStore()

    store.setEnabled(true)
    store.disable()

    expect(store.enabled).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })
})
