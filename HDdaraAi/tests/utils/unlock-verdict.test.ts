import { describe, expect, it } from 'vitest'

import { classifyStoredCredential, describeUnlockFailure } from '@/utils/unlock-verdict'

describe('classifyStoredCredential', () => {
  describe('nothing thrown means the credential is good', () => {
    it('reads an absent error as valid', () => {
      // The caller passes the thrown value, or `null` when the request resolved.
      // Without this branch a successful check would be classified as
      // `unreachable` and the user would be told their network was down.
      expect(classifyStoredCredential(null)).toBe('valid')
      expect(classifyStoredCredential(undefined)).toBe('valid')
    })
  })

  describe('a refusal is recognised by status, not wording', () => {
    it('reads a 401 as rejected', () => {
      // This is the shape a lapsed console session actually arrives in. The
      // wording is "Invalid password" for a bad login and "Admin session
      // required" for an expired one, so matching text would miss half of them.
      expect(classifyStoredCredential({ code: 401 })).toBe('rejected')
      expect(classifyStoredCredential({ code: 403 })).toBe('rejected')
    })

    it('reads a bare status field too', () => {
      // A failed `plus.net.XMLHttpRequest` reports a status but reaches here as
      // a plain Error rather than an `ApiError`, so both fields are checked.
      expect(classifyStoredCredential({ status: 401 })).toBe('rejected')
      expect(classifyStoredCredential({ status: 403 })).toBe('rejected')
    })

    it('falls back to the wording when no code is present', () => {
      expect(
        classifyStoredCredential(new Error('Admin session required')),
      ).toBe('rejected')
      expect(classifyStoredCredential(new Error('401 Unauthorized'))).toBe(
        'rejected',
      )
    })
  })

  describe('anything else is unverifiable, not a refusal', () => {
    it('does not read a network failure as a rejection', () => {
      // The distinction is the whole point: telling a user with no signal to
      // sign in again sends them to retype a password that was never the
      // problem, and they cannot complete that on a dead connection anyway.
      expect(
        classifyStoredCredential(new Error('request:fail')),
      ).toBe('unreachable')
      expect(classifyStoredCredential(new Error('timeout'))).toBe('unreachable')
    })

    it('does not read a server fault as a rejection', () => {
      // A 500 is the gateway being broken, not the credential being wrong.
      expect(classifyStoredCredential({ code: 500 })).toBe('unreachable')
      expect(classifyStoredCredential({ status: 503 })).toBe('unreachable')
    })

    it('does not treat a value it cannot read as a refusal', () => {
      // Erring towards `unreachable` keeps the user on the lock screen with a
      // retry, which is recoverable; guessing `rejected` throws away a working
      // credential and makes them sign in again.
      expect(classifyStoredCredential({})).toBe('unreachable')
      expect(classifyStoredCredential('something odd')).toBe('unreachable')
    })
  })
})

describe('describeUnlockFailure', () => {
  it('says the identity check succeeded before asking for a new login', () => {
    // This text appears seconds after a face scan. The wording it replaces
    // ("登录已过期，请重新填写凭据") left users thinking the scan had failed and
    // pressing the button again, so the confirmation is the load-bearing half.
    const message = describeUnlockFailure('rejected')

    expect(message).toContain('身份已确认')
    expect(message).toContain('重新登录')
    // Must not repeat the sentence that caused the misreading.
    expect(message).not.toContain('登录已过期')
  })

  it('points an unreachable gateway at the network, not at the credential', () => {
    const message = describeUnlockFailure('unreachable')

    expect(message).toContain('网络')
    expect(message).not.toContain('重新登录')
  })

  it('has nothing to say when the credential was fine', () => {
    // A blank string is what the caller assigns to the error line, so this is
    // the assertion that keeps a success from rendering an empty red box.
    expect(describeUnlockFailure('valid')).toBe('')
  })

  it('never returns the same wording for two different verdicts', () => {
    // Two verdicts sharing a sentence is the bug this module exists to end: it
    // told users to re-enter a credential for a problem the credential did not
    // cause. A new verdict has to bring its own wording with it.
    const messages = (['valid', 'rejected', 'unreachable'] as const).map(
      describeUnlockFailure,
    )

    expect(new Set(messages).size).toBe(messages.length)
  })
})
