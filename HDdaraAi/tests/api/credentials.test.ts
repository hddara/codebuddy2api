import type { CredentialListItem } from '@/api/credentials'

import { describe, expect, it } from 'vitest'
import { describeCredential, draftFromCredential } from '@/api/credentials'

/** A credential with every field at a benign default; each test varies one. */
function credential(overrides: Partial<CredentialListItem> = {}): CredentialListItem {
  return {
    created_at: null,
    domain: 'copilot.tencent.com',
    email: 'a@b.c',
    enterprise_id: null,
    expires_at: null,
    expires_in: null,
    filename: 'a.json',
    has_refresh_token: false,
    index: 0,
    is_expired: false,
    name: null,
    rate_limited_hits: 0,
    rate_limited_kind: null,
    rate_limited_reason: null,
    rate_limited_until: null,
    responses_passthrough: false,
    scope: null,
    session_state: null,
    tenant_id: null,
    time_remaining: null,
    time_remaining_str: '',
    token_type: 'Bearer',
    upstream_protocol: 'chat',
    user_id: 'u1',
    ...overrides,
  }
}

describe('describeCredential', () => {
  it('reports a rate limit ahead of everything else', () => {
    // A limited credential refuses every request until its window passes, so it
    // is the fact that explains a failure — even when the token is also expired.
    expect(
      describeCredential(
        credential({ is_expired: true, rate_limited_kind: 'quota' }),
      ),
    ).toBe('配额受限')
    expect(describeCredential(credential({ rate_limited_kind: 'frequency' }))).toBe(
      '频率受限',
    )
  })

  it('reports expiry when the credential is not limited', () => {
    expect(describeCredential(credential({ is_expired: true }))).toBe('已过期')
  })

  it('prefers the server rendering for a healthy credential', () => {
    // The server already accounts for the shapes above; recomputing from
    // `expires_at` here would be a second implementation to keep in step.
    expect(describeCredential(credential({ time_remaining_str: '3h' }))).toBe('3h')
    expect(describeCredential(credential({ time_remaining_str: 'Unknown' }))).toBe(
      'Unknown',
    )
  })

  it('falls back to a readable word when the server sent nothing', () => {
    expect(describeCredential(credential({ time_remaining_str: '' }))).toBe('有效')
  })
})

describe('draftFromCredential', () => {
  it('carries the identifiers an edit must not silently blank', () => {
    // The server keeps whatever it already has when a field is absent, so a
    // draft that failed to carry one would not clear it — it would look like a
    // save that did nothing, with no error to explain why.
    expect(
      draftFromCredential(
        credential({
          domain: 'copilot.tencent.com',
          enterprise_id: 'ent-1',
          filename: 'a.json',
          tenant_id: 't-1',
          token_type: 'Bearer',
          upstream_protocol: 'responses',
          user_id: 'u1',
        }),
      ),
    ).toEqual({
      domain: 'copilot.tencent.com',
      enterprise_id: 'ent-1',
      filename: 'a.json',
      tenant_id: 't-1',
      token_type: 'Bearer',
      upstream_protocol: 'responses',
      user_id: 'u1',
    })
  })

  it('never carries the token', () => {
    // The list endpoint does not send token material and the form asks for a
    // replacement rather than showing the stored one — so the draft has no field
    // for it, and this pins that.
    const draft = draftFromCredential(credential())

    expect(draft).not.toHaveProperty('bearer_token')
    expect(draft).not.toHaveProperty('access_token')
    expect(draft).not.toHaveProperty('refresh_token')
  })

  it('turns a null identifier into an empty field rather than the string "null"', () => {
    // Binding `null` into an input renders "null", which a user would then save.
    const draft = draftFromCredential(
      credential({ enterprise_id: null, tenant_id: null }),
    )

    expect(draft.enterprise_id).toBe('')
    expect(draft.tenant_id).toBe('')
  })

  it('supplies a token type when the server reported none', () => {
    expect(draftFromCredential(credential({ token_type: '' })).token_type).toBe('Bearer')
  })
})
