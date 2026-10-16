import type { BiometricResult, BiometricSupport } from '@/utils/biometric'
import { defineStore } from 'pinia'

import { authenticateBiometric, probeBiometricSupport } from '@/utils/biometric'
/**
 * The biometric opt-in, as application state rather than a stray storage key.
 *
 * It used to be a bare `uni.setStorageSync('biometric-enabled', …)` written from
 * the login page only. Two problems followed from that:
 *
 *  - the settings page could not offer the switch at all, because the value was
 *    private to a single screen, and the login page only renders the switch for
 *    a user who already has a stored credential — so the feature was reachable
 *    only from a screen the user stops visiting once they are signed in;
 *  - the capability probe was memoised forever, so enrolling a face after the
 *    first reading kept showing "not set up" until the process was killed.
 *
 * Holding both in a store fixes the first, and `refreshSupport()` fixes the
 * second: the state can be re-read on every `onShow`, which is exactly when a
 * user who just came back from the system settings would need it.
 */

/**
 * Storage key carries over from the old bare-key version on purpose.
 *
 * Users who opted in under the previous build keep their choice; renaming it
 * would silently switch the feature off for them.
 */
const STORAGE_KEY = 'biometric-enabled'

/** Capability probe, re-runnable. `'unknown'` means "not probed yet". */
interface BiometricState {
  enabled: boolean
  /** Last observed device capability, or `'unknown'` before the first probe. */
  support: BiometricSupport | 'unknown'
}

export const useBiometricStore = defineStore('biometric', {
  state: (): BiometricState => ({
    enabled: false,
    support: 'unknown',
  }),
  getters: {
    /** True when the switch can actually be turned on right now. */
    usable: (state): boolean => state.support === 'available',
    /**
     * Whether the app should present a biometric prompt on launch.
     *
     * Both halves are required: an opt-in with no usable hardware would prompt
     * into a guaranteed failure, which is worse than the credential form.
     */
    shouldPrompt: (state): boolean =>
      state.enabled && state.support === 'available',
  },
  actions: {
    /**
     * Re-reads the device capability.
     *
     * Called on every `onShow` of the screens that display the state. A probe is
     * cheap for the bridge but not free, so the value is compared before being
     * written — an unchanged reading does not notify subscribers and the page
     * does not re-render for nothing.
     *
     * Asynchronous because the bridge is: `checkIsSupportSoterAuthentication`
     * fires its callback after the call has already returned, so a synchronous
     * reader would always report the pre-answer state and conclude that a
     * Face-ID phone has no sensor.
     */
    async refreshSupport(): Promise<BiometricSupport> {
      let next: BiometricSupport

      try {
        next = await probeBiometricSupport()
      }
      catch {
        // The App runtime has thrown from bridge members before; a probe that
        // cannot answer is treated as "no bridge", which is the honest reading.
        next = 'unsupported'
      }

      if (this.support !== next) {
        this.support = next
      }

      // A device that lost its enrolment must not stay opted in: keeping it on
      // would make every launch fail at the prompt instead of using the form.
      if (next !== 'available' && this.enabled) {
        this.setEnabled(false)
      }

      return next
    },

    /** Reads the persisted opt-in. Safe to call before the bridge is up. */
    loadEnabled(): boolean {
      try {
        this.enabled = Boolean(uni.getStorageSync(STORAGE_KEY))
      }
      catch {
        this.enabled = false
      }

      return this.enabled
    },

    /**
     * Writes the opt-in, to the store and to storage.
     *
     * Storage is best-effort by design: losing it costs the preference for the
     * next launch, which is better than failing the toggle the user just made.
     */
    setEnabled(enabled: boolean): void {
      this.enabled = enabled

      try {
        uni.setStorageSync(STORAGE_KEY, enabled)
      }
      catch {
        // Only the preference is lost; the session keeps the new value.
      }
    },

    /**
     * Turns the feature on, but only after the device proves it can do it.
     *
     * The confirmation prompt is the point: `biometricSupport()` reports that a
     * bridge exists, not that this person's finger or face will match. Without
     * a real authentication the switch could be turned on for a device that
     * would then fail on every launch, and the user would only find out on the
     * next cold start — by which time the memory of what they pressed is gone.
     *
     * Returns the failure so the caller can show the reason.
     */
    async enableWithConfirmation(): Promise<BiometricResult | null> {
      const support = await this.refreshSupport()

      if (support !== 'available') {
        // No prompt to attempt; the caller phrases this from `support`.
        return { ok: false, reason: 'unsupported' }
      }

      const result = await authenticateBiometric('验证身份以开启快速解锁')

      if (result.ok) {
        this.setEnabled(true)
        return null
      }

      // A cancel is not a failure — the user simply changed their mind. The
      // caller stays silent for it, so the result is passed through untouched.
      return result
    },

    /** Turns the feature off. Never prompts: leaving must never be gated. */
    disable(): void {
      this.setEnabled(false)
    },
  },
})
