import { vi } from 'vitest'

/**
 * Stands in for the `uni` runtime, which only exists inside a real build.
 *
 * The modules under test were written against it directly (`uni.getStorageSync`,
 * `uni.request`, `uni.showToast`), so without a stub they cannot be imported at
 * all — not even the parts that never call it. Declaring it once here keeps the
 * individual test files about behaviour rather than about plumbing.
 *
 * Storage is a real `Map` rather than a mock: a test that writes and then reads
 * gets the value back, which is what makes "restores what it saved" testable.
 */
const storage = new Map<string, unknown>()

const uniStub = {
  getStorageSync: vi.fn((key: string) => storage.get(key) ?? ''),

  removeStorageSync: vi.fn((key: string) => {
    storage.delete(key)
  }),

  /**
   * Never resolves on its own. A test that needs a request to answer installs
   * its own implementation; one that does not is left with a promise that does
   * nothing, instead of the real adapter reaching for `XMLHttpRequest`.
   */
  request: vi.fn(),

  setStorageSync: vi.fn((key: string, value: unknown) => {
    storage.set(key, value)
  }),

  showToast: vi.fn(),

  /** Test helper, not part of the real API. */
  __storage: storage,
  __reset() {
    storage.clear()
    this.getStorageSync.mockClear()
    this.removeStorageSync.mockClear()
    this.request.mockClear()
    this.setStorageSync.mockClear()
    this.showToast.mockClear()
  },
}

vi.stubGlobal('uni', uniStub)

/**
 * `plus` is the native bridge. Modules merely *check* for it (`typeof plus`),
 * so an undefined global is the honest default: it is what a non-App platform
 * sees.
 */
vi.stubGlobal('plus', undefined)

export { uniStub }
