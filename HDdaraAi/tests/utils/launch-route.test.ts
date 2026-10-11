import { beforeEach, describe, expect, it } from 'vitest'

import {
  consumePendingRoute,
  resetLaunchRoute,
  setPendingRoute,
  takeLaunchRoute,
} from '@/utils/launch-route'

describe('takeLaunchRoute', () => {
  it('accepts the path forms the platforms hand over', () => {
    // Deliberately liberal: the exact shape differs per platform and per entry
    // point, and refusing a working link is worse than accepting a sloppy one.
    expect(takeLaunchRoute({ path: 'pages/sessions/index' })).toBe('pages/sessions/index')
    expect(takeLaunchRoute({ path: '/pages/sessions/index' })).toBe('pages/sessions/index')
    expect(takeLaunchRoute({ path: 'pages/sessions/index/' })).toBe('pages/sessions/index')
  })

  it('drops the query, because the page reads its own parameters', () => {
    expect(takeLaunchRoute({ path: 'pages/sessions/index?windowMinutes=1440' })).toBe('pages/sessions/index')
  })

  it('accepts every allow-listed destination', () => {
    expect(takeLaunchRoute({ path: 'pages/settings/index' })).toBe('pages/settings/index')
  })

  it('refuses a destination that is not on the allow-list', () => {
    // This is what keeps a crafted link from routing around the lock screen's
    // guarantee that a cold start begins at the entry point.
    expect(takeLaunchRoute({ path: 'pages/sessions/detail' })).toBeNull()
    expect(takeLaunchRoute({ path: 'pages/admin/index' })).toBeNull()
    expect(takeLaunchRoute({ path: '../../etc/passwd' })).toBeNull()
  })

  it('reports nothing for a launch that asked for nothing', () => {
    expect(takeLaunchRoute(undefined)).toBeNull()
    expect(takeLaunchRoute({})).toBeNull()
    expect(takeLaunchRoute({ path: '' })).toBeNull()
    expect(takeLaunchRoute({ path: '   ' })).toBeNull()
  })

  it('ignores a path that is not a string', () => {
    expect(takeLaunchRoute({ path: 42 as unknown as string })).toBeNull()
    expect(takeLaunchRoute({ path: null as unknown as string })).toBeNull()
  })
})

describe('pending route', () => {
  beforeEach(() => {
    resetLaunchRoute()
  })

  it('holds a destination for the unlock to claim', () => {
    setPendingRoute('pages/sessions/index')

    expect(consumePendingRoute()).toBe('pages/sessions/index')
  })

  it('hands the destination over exactly once', () => {
    // A second unlock in one launch — a background round-trip, say — must not
    // send the user back to the page the first one went to.
    setPendingRoute('pages/settings/index')

    expect(consumePendingRoute()).toBe('pages/settings/index')
    expect(consumePendingRoute()).toBeNull()
  })

  it('reports nothing when the launch did not ask for anything', () => {
    expect(consumePendingRoute()).toBeNull()
  })

  it('lets a later launch clear an earlier destination', () => {
    setPendingRoute('pages/sessions/index')
    setPendingRoute(null)

    expect(consumePendingRoute()).toBeNull()
  })
})
