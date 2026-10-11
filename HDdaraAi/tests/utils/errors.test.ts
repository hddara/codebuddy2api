import { describe, expect, it } from 'vitest'

import { describeError, isAuthError, REAUTH_HINT } from '@/utils/errors'

describe('isAuthError', () => {
  it('accepts a rejected credential by status code', () => {
    // The gateway answers a wrong password with `401 Invalid password`. The
    // wording is the server's; the code is not, so the code is what decides.
    expect(isAuthError({ status: 401 })).toBe(true)
    expect(isAuthError({ status: 403 })).toBe(true)
    expect(isAuthError({ code: 401 })).toBe(true)
    expect(isAuthError({ code: 403 })).toBe(true)
  })

  it('does not treat other statuses as a credential problem', () => {
    // A 500 or a 429 needs a different next step, and sending the user to
    // re-enter a working credential wastes their time.
    expect(isAuthError({ status: 500 })).toBe(false)
    expect(isAuthError({ status: 429 })).toBe(false)
    expect(isAuthError({ status: 404 })).toBe(false)
  })

  it('falls back to the wording when no code is carried', () => {
    // A failed `plus.net.XMLHttpRequest` reaches here as a plain Error, with a
    // message but no status field.
    expect(isAuthError(new Error('session required'))).toBe(true)
    expect(isAuthError(new Error('Unauthorized'))).toBe(true)
    expect(isAuthError(new Error('[401] nope'))).toBe(true)
  })

  it('reports no auth problem for a transport failure', () => {
    // The distinction matters: `request:fail` is a network drop, and telling
    // the user to re-enter their Cookie would send them down a dead end.
    expect(isAuthError(new Error('request:fail'))).toBe(false)
    expect(isAuthError(new Error('timeout'))).toBe(false)
  })

  it('survives values that are not errors', () => {
    expect(isAuthError(null)).toBe(false)
    expect(isAuthError(undefined)).toBe(false)
    expect(isAuthError('')).toBe(false)
    expect(isAuthError(0)).toBe(false)
    expect(isAuthError({})).toBe(false)
  })
})

describe('describeError', () => {
  it('sends an auth rejection to the settings page instead of echoing it', () => {
    expect(describeError({ status: 401 }, '加载会话失败')).toBe(REAUTH_HINT)
  })

  it('keeps the specific message for everything else', () => {
    // A 500 or a network drop needs no translation — the concrete message is
    // more useful than a generic one.
    expect(describeError(new Error('服务器开小差了'), '加载会话失败')).toBe(
      '服务器开小差了',
    )
  })

  it('uses the fallback when there is no message to show', () => {
    // An empty message is a real case — a platform that rejects with an
    // Error-shape but no text leaves the page with nothing to display, so the
    // caller's own wording has to take over.
    const blank = new Error('placeholder')
    blank.message = ''

    expect(describeError(null, '加载会话失败')).toBe('加载会话失败')
    expect(describeError(blank, '加载会话失败')).toBe('加载会话失败')
    expect(describeError({}, '加载会话失败')).toBe('加载会话失败')
  })
})
