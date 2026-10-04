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
      const storageState = uni.getStorageSync(store.$id)
      if (storageState && typeof storageState === 'object' && Object.keys(storageState).length > 0) {
        store.$state = storageState
      }
    }
    catch {
      // 读取失败不阻塞启动
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
    uni.setStorageSync(store.$id, CommonUtil.deepClone(store.$state))
  })
}

export function persistPlugin(context: PiniaPluginContext) {
  // 调用persist函数，并传入排除列表
  // 'temp' - 临时数据不持久化
  // 'network-status' - 网络状态是运行时瞬时值，持久化会让下次冷启动读到过期的 isOffline
  // 'app-update-popup' - 更新弹窗的 visible/phase/进度都是瞬时值，持久化会导致冷启动凭空弹窗
  persist(context, ['temp', 'shoppingCart', 'network-status', 'app-update-popup'])
}
