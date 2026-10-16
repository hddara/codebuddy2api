import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAuthStore } from '@/store/authStore'
import { ensureUnlocked, GUARDED_PAGES, PUBLIC_PAGES } from '@/utils/app-guard'
import { uniStub } from '../setup'

/**
 * The lock screen is the app's entry point, but it is not the only way in.
 * `ensureUnlocked` is what the data pages call on show, and these cases pin the
 * two ways it has to hold: an unlocked session passes, and anything else is
 * redirected rather than left rendering.
 */

beforeEach(() => {
  setActivePinia(createPinia())
  uniStub.__reset()
})

describe('ensureUnlocked', () => {
  it('lets an unlocked session through', () => {
    const auth = useAuthStore()

    auth.setAdminCookie('session-token')
    auth.unlock()

    expect(ensureUnlocked()).toBe(true)
    expect(uniStub.reLaunch).not.toHaveBeenCalled()
  })

  it('redirects a locked session to the lock screen', () => {
    // The regression: `detail`, `live` and `transcript` did not call the guard
    // at all, so a deep link or a restored page stack showed stored answers
    // while the app was locked.
    const auth = useAuthStore()

    auth.setAdminCookie('session-token')
    auth.lock()

    expect(ensureUnlocked()).toBe(false)
    expect(uniStub.reLaunch).toHaveBeenCalledWith({ url: '/pages/login/index' })
  })

  it('redirects when there is no stored credential at all', () => {
    const auth = useAuthStore()

    // Unlocked but credential-less cannot happen through the app's own flows;
    // it is the state a failed restore leaves behind, and the guard must not
    // treat it as usable.
    auth.unlock()

    expect(ensureUnlocked()).toBe(false)
    expect(uniStub.reLaunch).toHaveBeenCalled()
  })

  it('uses reLaunch rather than navigateTo, so back cannot return to the page', () => {
    // `navigateTo` pushes: "back" would land on the data page the guard just
    // rejected, and the user would bounce between the two.
    ensureUnlocked()

    expect(uniStub.reLaunch).toHaveBeenCalled()
  })
})

describe('page lists', () => {
  it('lists the pages that render session data', () => {
    expect(GUARDED_PAGES).toContain('pages/sessions/detail')
    expect(GUARDED_PAGES).toContain('pages/sessions/live')
    expect(GUARDED_PAGES).toContain('pages/sessions/transcript')
  })

  it('never lists a page that must stay reachable while locked', () => {
    // The lock screen cannot require the lock to be open.
    for (const page of PUBLIC_PAGES) {
      expect(GUARDED_PAGES).not.toContain(page)
    }
  })

  it('has no duplicate entries', () => {
    expect(new Set(GUARDED_PAGES).size).toBe(GUARDED_PAGES.length)
  })
})
