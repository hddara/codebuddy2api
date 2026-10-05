/*
 * @Author: weisheng
 * @Date: 2025-06-23 22:23:05
 * @LastEditTime: 2025-06-24 19:03:21
 * @LastEditors: weisheng
 * @Description:
 * @FilePath: /mall-uniapp-pro/src/store/persist.ts
 * 记得注释
 */
import type { PiniaPluginContext } from 'pinia'

/**
 * Snapshot of a store state that is safe to hand to `uni.setStorageSync`.
 *
 * Replaces the scaffold's `CommonUtil.deepClone`, which does not exist in this
 * project: the resulting ReferenceError fired inside `$subscribe` on every
 * state change, so nothing was ever written and the app lost its credentials on
 * each cold start. `JSON` round-trip is enough because these states are plain
 * data, and `structuredClone` is not guaranteed in the App JS runtime.
 */
function snapshotState(state: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(state))
  }
  catch {
    return state
  }
}

/**
 * Writes a store snapshot and reads it straight back.
 *
 * The read-back is deliberate: on the App runtime `setStorageSync` can appear to
 * succeed while nothing lands, and a silent failure here is invisible until the
 * next cold start ("I saved the settings, they are gone"). Verifying turns that
 * into something observable in the device log.
 */
/** How many times a failed write is retried before giving up. */
const WRITE_RETRY_LIMIT = 12
const WRITE_RETRY_INTERVAL_MS = 500

/**
 * Persists a store snapshot, retrying until the read-back confirms it landed.
 *
 * Why the retry loop: on the App runtime the storage engine is backed by
 * `plus.storage`, which is unavailable until the 5+ runtime is up. A Pinia
 * plugin runs before that, and `setStorageSync` does not throw in that window —
 * it simply does nothing. Retrying against a read-back is the only way to tell
 * "stored" from "silently dropped", and a write that is dropped on a cold start
 * is exactly the "credentials gone after restart" failure.
 */
function writeThrough(
  store: { $id: string, $state: unknown },
  attempt = 0,
): void {
  const payload = snapshotState(store.$state)

  // Nothing to persist yet: writing `{}` would erase a good snapshot that we
  // simply have not restored yet.
  if (!Object.keys(payload as object).length) {
    return
  }

  // Stored as a JSON string rather than a raw object. Some App runtimes accept
  // an object in `setStorageSync` and then read back an empty value, which made
  // every cold start look like "the credentials were never saved"; a string is
  // handled consistently on every platform.
  const serialized = JSON.stringify(payload)
  const expectedKeys = Object.keys(payload as object)

  const landed = (): boolean => {
    try {
      const readBack = parseStored(uni.getStorageSync(store.$id))

      return readBack !== null
        && expectedKeys.every(key => key in readBack)
    }
    catch {
      return false
    }
  }

  const retry = (): void => {
    if (attempt >= WRITE_RETRY_LIMIT) {
      console.warn(`[persist] gave up persisting ${store.$id}`)
      return
    }

    setTimeout(writeThrough, WRITE_RETRY_INTERVAL_MS, store, attempt + 1)
  }

  try {
    // The **async** API is used on purpose. On the App runtime
    // `setStorageSync` keeps a value in an in-memory layer and only flushes it
    // to disk later — so reading it straight back with `getStorageSync` always
    // succeeded, the retry loop stopped, and the write was still lost whenever
    // the app was killed before the flush. That is the "credentials gone after
    // restart" bug: the read-back was checking the cache, not the storage.
    //
    // `uni.setStorage`'s success callback fires after the write is committed.
    uni.setStorage({
      data: serialized,
      fail: () => retry(),
      key: store.$id,
      success: () => {
        if (!landed()) {
          retry()
        }
      },
    })
  }
  catch (error) {
    console.warn(`[persist] write failed for ${store.$id}`, error)
    retry()
  }
}

/**
 * Reads a snapshot back into an object.
 *
 * Accepts the JSON string this module writes as well as a plain object, so a
 * snapshot written by an earlier build is still restorable.
 */
export function parseStored(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown

      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null
    }
    catch {
      return null
    }
  }

  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

function persist({ store }: PiniaPluginContext, excludedIds: string[]) {
  // 检查当前store的id是否在排除列表中
  const isExcluded = excludedIds.includes(store.$id)

  // 如果当前store的id在排除列表中，则不进行持久化
  if (isExcluded) {
    return
  }

  // 从缓存中恢复状态。
  // ⚠️ App 端冷启动时 uni.getStorageSync 可能早于 plus ready 执行而读到空值（表现为「每次杀进程重启都要重新登录」），
  // 因此这里先读一次，并在 plus 就绪后再兜底恢复一次；读到空值时不覆盖 store 自身状态，避免把空状态回写进缓存。
  const restoreState = () => {
    try {
      const storageState = parseStored(uni.getStorageSync(store.$id))

      if (!storageState || !Object.keys(storageState).length) {
        return
      }

      // `$patch` is the supported way to hydrate a store. Assigning `$state`
      // wholesale looked like it worked (the fields were readable in memory) but
      // does not reliably notify subscribers, so the UI kept reading the initial
      // empty values until something else triggered a re-render.
      //
      // The record is cast because a snapshot is untyped by nature; Pinia's
      // overloads only accept a `_DeepPartial` of the concrete state.
      store.$patch(storageState as never)
      console.log(`[persist] restored ${store.$id}`, Object.keys(storageState as object).join(','))
    }
    catch (error) {
      console.warn(`[persist] restore failed for ${store.$id}`, error)
    }
  }
  restoreState()

  // #ifdef APP-PLUS
  const appAny = globalThis as any
  if (appAny.plus) {
    restoreState()
  }
  else if (typeof document !== 'undefined') {
    document.addEventListener('plusready', restoreState, { once: true } as any)
  }
  // #endif

  store.$subscribe(() => {
    // 在存储变化的时候将store缓存
    writeThrough(store)
  })

  // #ifdef APP-PLUS
  // On the App runtime `uni.setStorageSync` silently does nothing until the
  // `plus` bridge is up, and a Pinia plugin runs before that. Subscribing here
  // alone therefore wrote to nowhere: the settings page showed "saved", the
  // device directory stayed empty, and the credentials were gone on the next
  // cold start. Flush again once the bridge reports ready.
  const bridge = globalThis as any
  const flush = () => writeThrough(store)

  if (bridge.plus) {
    flush()
  }
  else {
    if (typeof document !== 'undefined') {
      document.addEventListener('plusready', flush, { once: true } as any)
    }

    // The bridge can also come up without the DOM event; a delayed retry covers
    // that ordering.
    setTimeout(flush, 2000)
  }

  bridge.plus?.globalEvent?.addEventListener?.('pause', flush)
  // #endif
}

export function persistPlugin(context: PiniaPluginContext) {
  // 调用persist函数，并传入排除列表
  // 'temp' - 临时数据不持久化
  // 'network-status' - 网络状态是运行时瞬时值，持久化会让下次冷启动读到过期的 isOffline
  // 说明：mall 的 'shoppingCart' / 'app-update-popup' 已随业务剥离，本项目无这些 store
  persist(context, ['temp', 'network-status'])
}
