import { describe, expect, it } from 'vitest'

import {
  EDITABLE_SETTING_FIELDS,
  isSettingEditable,
  isSettingEnabled,
  settingFlag,
} from '@/api/settings'

/**
 * The gateway stores its configuration as a flat map of strings, which makes
 * `'false'` a truthy value. These cases pin the parsing, because a switch that
 * renders "on" for `'false'` is the kind of bug that survives a demo.
 */

describe('isSettingEnabled', () => {
  it('reads the stored true as on', () => {
    expect(isSettingEnabled('true')).toBe(true)
  })

  it('reads the stored false as off, not as truthy', () => {
    // The whole point: `Boolean('false')` is `true`, so a naive read would show
    // the automatic check-in as enabled while the gateway had it off.
    expect(isSettingEnabled('false')).toBe(false)
  })

  it('tolerates casing and padding the server may add', () => {
    expect(isSettingEnabled(' TRUE ')).toBe(true)
    expect(isSettingEnabled('False')).toBe(false)
  })

  it('treats a missing key as off', () => {
    expect(isSettingEnabled(undefined)).toBe(false)
    expect(isSettingEnabled('')).toBe(false)
  })
})

describe('settingFlag', () => {
  it('round-trips through isSettingEnabled', () => {
    expect(isSettingEnabled(settingFlag(true))).toBe(true)
    expect(isSettingEnabled(settingFlag(false))).toBe(false)
  })
})

describe('isSettingEditable', () => {
  const checkinTime = EDITABLE_SETTING_FIELDS.find(
    field => field.key === 'CODEBUDDY_AUTO_CHECKIN_TIME',
  )!

  it('leaves a field with no dependency always editable', () => {
    const simple = EDITABLE_SETTING_FIELDS.find(
      field => field.key === 'CODEBUDDY_LOG_LEVEL',
    )!

    expect(isSettingEditable(simple, {} as never)).toBe(true)
  })

  it('gates the check-in time behind its switch', () => {
    // A time that nothing reads is worse than a disabled field: the user sets
    // it, sees it saved, and no check-in ever happens at that hour.
    expect(isSettingEditable(checkinTime, {
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'false',
    } as never)).toBe(false)

    expect(isSettingEditable(checkinTime, {
      CODEBUDDY_AUTO_CHECKIN_ENABLED: 'true',
    } as never)).toBe(true)
  })
})

describe('editable setting fields', () => {
  it('leaves the two keys that can lock the console out to the web console', () => {
    // `CODEBUDDY_API_ENDPOINT` and the passkey RP id decide whether the console
    // is reachable at all; set wrongly from a phone there is no way back in.
    const keys = EDITABLE_SETTING_FIELDS.map(field => field.key)

    expect(keys).not.toContain('CODEBUDDY_API_ENDPOINT')
    expect(keys).not.toContain('CODEBUDDY_ADMIN_PASSKEY_RP_ID')
  })

  it('gives every select a non-empty option list', () => {
    for (const field of EDITABLE_SETTING_FIELDS) {
      if (field.control === 'select') {
        expect(field.options?.length).toBeGreaterThan(0)
      }
    }
  })

  it('has no duplicate keys', () => {
    const keys = EDITABLE_SETTING_FIELDS.map(field => field.key)

    expect(new Set(keys).size).toBe(keys.length)
  })
})
