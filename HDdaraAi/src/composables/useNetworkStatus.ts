import { defineStore } from 'pinia'

/**
 * 全局网络状态
 *
 * 背景：此前全项目没有任何网络监听，断网时各页面只会静默失败（列表一直转圈或空白），
 * 用户看不到任何提示。这里统一维护「是否无网络」，并在断开/恢复时给一次全局提示。
 *
 * 注意：提示只做「状态翻转」时的通知，接口失败的具体文案仍由 api/core/handlers.ts 收口，
 * 两者职责分离：本 store 负责"有没有网"，handlers 负责"这次请求为什么失败"。
 */

/** 状态翻转提示的去重窗口：小程序前后台切换会连发多次网络事件 */
const NOTIFY_DEDUPE_MS = 3000

/**
 * 监听是否已注册：用模块级变量而不是 store state。
 * store 会被 pinia 持久化插件写入本地存储，若用 state 记录，冷启动恢复后 init() 会直接短路，
 * 网络监听再也注册不上（已在 store/persist.ts 里把本 store 排除持久化，这里再兜一层）。
 */
let listenerInited = false

interface NetworkStatus {
  /** 是否无网络 */
  isOffline: boolean
  /** 上次提示时间，用于去重 */
  lastNotifyAt: number
}

export const useNetworkStatus = defineStore('network-status', {
  state: (): NetworkStatus => ({
    isOffline: false,
    lastNotifyAt: 0,
  }),
  actions: {
    /** 初始化监听：App.vue 的 onLaunch 调用一次即可 */
    init() {
      if (listenerInited) {
        return
      }
      listenerInited = true

      // 取一次初值：拿不到时不误判为断网，交给请求失败提示兜底
      uni.getNetworkType({
        success: (res) => {
          this.isOffline = res.networkType === 'none'
        },
        fail: () => {},
      })

      uni.onNetworkStatusChange((res) => {
        this.handleChange(res)
      })
    },

    /** 网络状态变化：状态未翻转时不打扰用户 */
    handleChange(res: UniApp.OnNetworkStatusChangeSuccess) {
      const offline = !res.isConnected || res.networkType === 'none'
      if (offline === this.isOffline) {
        return
      }
      this.isOffline = offline
      this.notify(offline)
    },

    /** 断开/恢复提示（同类提示 3 秒内只弹一次） */
    notify(offline: boolean) {
      const now = Date.now()
      if (now - this.lastNotifyAt < NOTIFY_DEDUPE_MS) {
        return
      }
      this.lastNotifyAt = now

      const globalToast = useGlobalToast()
      if (offline) {
        globalToast.error('当前网络不可用，请检查网络连接')
      }
      else {
        globalToast.success('网络已恢复')
      }
    },
  },
})
