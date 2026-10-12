import { describe, expect, it } from 'vitest'

import { DISABLE_AUTH_WARNING, toVisiblePasskey } from '@/api/account'

function record(extra: Record<string, unknown> = {}) {
  return {
    backedUp: true,
    counter: 42,
    createdAt: '2026-10-01T00:00:00.000Z',
    deviceType: 'platform',
    id: 'passkey-1',
    name: '我的 iPhone',
    publicKey: 'pQECAyYgASFYIP...',
    transports: ['internal'],
    ...extra,
  }
}

describe('toVisiblePasskey', () => {
  it('keeps the fields a person recognises', () => {
    expect(toVisiblePasskey(record())).toEqual({
      backedUp: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      deviceType: 'platform',
      id: 'passkey-1',
      name: '我的 iPhone',
    })
  })

  it('drops the credential material the server sends', () => {
    // `publicKey` is the stored credential and `counter` is its replay
    // protection. Neither means anything to a user, both are the record's
    // sensitive half, and a screen that renders whatever it was handed would
    // print them — so the omission is asserted rather than assumed.
    const visible = toVisiblePasskey(record()) as Record<string, unknown>

    expect(visible).not.toHaveProperty('publicKey')
    expect(visible).not.toHaveProperty('counter')
    expect(JSON.stringify(visible)).not.toContain('pQECAyYgASFYIP')
  })

  it('drops anything the projection has not been taught about', () => {
    // The failure this guards is a server field being added and flowing straight
    // through, so an unknown key must not survive.
    const visible = toVisiblePasskey(record({ secret: 'nope' })) as Record<string, unknown>

    expect(visible).not.toHaveProperty('secret')
  })

  it('fills in for a record with missing fields instead of showing undefined', () => {
    expect(toVisiblePasskey({})).toEqual({
      backedUp: null,
      createdAt: '',
      deviceType: null,
      id: '',
      name: '',
    })
  })

  it('keeps a false `backedUp` as false rather than collapsing it to null', () => {
    // "not synced" is a real answer; `?? null` would erase it and the row would
    // stop saying whether the key survives losing this device.
    expect(toVisiblePasskey(record({ backedUp: false })).backedUp).toBe(false)
  })
})

describe('dISABLE_AUTH_WARNING', () => {
  it('names what turning authentication off destroys', () => {
    // The app does not offer this action — the console does — but a user who
    // performed it elsewhere lands on a screen that has to explain the state.
    expect(DISABLE_AUTH_WARNING).toContain('通行密钥')
    expect(DISABLE_AUTH_WARNING).toContain('会话')
  })
})
