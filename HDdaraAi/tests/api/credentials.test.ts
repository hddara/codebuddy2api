import type { CredentialListItem } from '@/api/credentials'

import { describe, expect, it } from 'vitest'
import { describeCredential } from '@/api/credentials'

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
