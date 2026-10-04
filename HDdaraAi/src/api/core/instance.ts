import type { Method } from 'alova'
import { uniappRequestAdapter } from '@alova/adapter-uniapp'
import { createAlova } from 'alova'
import vueHook from 'alova/vue'
import { useAuthStore } from '@/store/authStore'
import { getAppVersion, getAppVersionCode, getDeviceInfo, getPlatformType } from '@/utils/app-info'
import { getApiBaseUrl, isNgrokBaseUrl, resolveApiBaseUrl } from './base-url'
import { handleAlovaError, handleAlovaResponse } from './handlers'

/**
 * 网络类错误的自动重试等待序列（毫秒）。
 *
 * 【存在原因】iOS 首次访问局域网后端会弹「允许查找本地网络中的设备」授权框：
 * 点「允许」之前**所有**请求都会被系统直接拒绝（-1004 无法连接服务器），
 * 此前首屏必然失败并停在「网络异常，请检查网络后重试」，用户必须手动下拉刷新才恢复。
 * 这里做短退避重试，用户点完「允许」后由重试自动完成首屏加载。
 *
 * 只对 **GET** 请求重试：写接口（下单/支付/领券）在「响应丢失」类失败下重试可能造成重复提交，
 * 而权限弹窗影响的是首屏读取类请求，GET 重试即可覆盖。
 */
const RETRY_DELAYS = [1500, 3000, 5000]

/**
 * 已重试次数挂在 `method.config` 的这个字段上。
 *
 * ⚠️ **不可改用「以 method 实例为 key 的 WeakMap」计数**（2026-09-20 实证 bug）：
 * `method.send()` 内部会 `cloneMethod()` 克隆出**新的 Method 实例**，实例作 key 时
 * 每次重试都查不到记录、计数永远归零 ⇒ 网络故障下**无限重试**（每 1.5s 一次、永不停止），
 * 请求 promise 永不 reject：页面既进不了 catch，也永远显示不出「网络异常 / 离线提示」，
 * 同时还会持续发无效请求。
 *
 * 而 `cloneMethod()` 对 config 是**浅拷贝**（`const newConfig = { ...config }`），
 * 把计数放在 config 上可跨重试自然继承，且随请求结束释放，无全局状态。
 */
const RETRY_COUNT_KEY = '__retryCount'

/**
 * 「本次请求不要自动重试」开关（写在 alova config 上，`method.config` 原样透传）。
 *
 * 用途：检查更新这类「必须尽快给用户结论」的请求 —— 重试会把短超时放大成 30s+，
 * 用户侧表现就是「点了没反应」（2026-09-20 真机反馈）。见 utils/app-update.ts。
 */
export const NO_RETRY_FLAG = '__noRetry'

/** 是否属于「重试有意义」的网络类错误（业务错误/401 不重试） */
function isRetryableError(error: any): boolean {
  if (!error) {
    return false
  }
  // 业务/鉴权错误（ApiError）重试无意义，401/403 更不能重试
  if (error.name === 'ApiError' || error.code === 401 || error.code === 403) {
    return false
  }
  if (error.name === 'NetworkError' || error.name === 'TimeoutError') {
    return true
  }
  const msg = String(error.message || error.errMsg || '')
  return msg.includes('request:fail') || msg.toLowerCase().includes('timeout')
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const alovaInstance = createAlova({
  baseURL: getApiBaseUrl(),
  requestAdapter: uniappRequestAdapter,
  statesHook: vueHook,
  beforeRequest: async (method) => {
    // 运行时基址：多候选自动选路结果（局域网优先，ngrok 兜底）。
    // 首次调用会等探测（局域网命中 <50ms，最坏 1.5s），之后同一次启动内直接用缓存值。
    const runtimeBase = await resolveApiBaseUrl()
    if (runtimeBase) {
      method.baseURL = runtimeBase
    }
    // ngrok 免费隧道会给浏览器 UA 返回 HTML 插页，必须带此头才能拿到真实 JSON
    if (isNgrokBaseUrl(runtimeBase)) {
      method.config.headers['ngrok-skip-browser-warning'] = '1'
    }

    // Add content type for POST/PUT/PATCH requests
    // 上传请求（requestType=upload）走 uni.uploadFile，Content-Type 必须保持 multipart/form-data 由平台自动生成，
    // 若被覆写成 application/json 会导致后端无法解析 multipart（@RequestPart 收不到文件）
    if (['POST', 'PUT', 'PATCH'].includes(method.type) && method.config.requestType !== 'upload') {
      method.config.headers['Content-Type'] = 'application/json'
    }
    // Gateway authentication. The console uses its own signed admin cookie for
    // the browser session; native apps present a gateway API key instead, so
    // whichever credential the auth store holds is attached here as Bearer.
    // (`satoken` was a mall-backend convention and is intentionally gone.)
    const authStore = useAuthStore()
    const credential = authStore.getToken
    if (credential && !method.config.headers.skipToken) {
      method.config.headers.Authorization = `Bearer ${credential}`
    }
    // Platform + client headers give the gateway something to attribute
    // requests to. They are optional: the gateway ignores unknown headers.
    const platformType = getPlatformType()
    if (platformType) {
      method.config.headers['x-client-platform'] = platformType
    }

    // 客户端版本 + 设备信息：后端 ClientContextFilter 写入日志上下文并落进访问日志，
    // 用于「只有某端某版本/某机型才出现」的问题定位（见 src/utils/app-info.ts）
    method.config.headers['app-version'] = getAppVersion()
    method.config.headers['app-version-code'] = getAppVersionCode()
    method.config.headers['device-info'] = encodeURIComponent(getDeviceInfo())

    // Add timestamp to prevent caching for GET requests
    if (method.type === 'GET' && CommonUtil.isObj(method.config.params)) {
      method.config.params._t = Date.now()
    }

    // Log request in development
    if (import.meta.env.MODE === 'development') {
      console.log(`[Alova Request] ${method.type} ${method.url}`, method.data || method.config.params)
      console.log(`[API Base URL] ${getApiBaseUrl()}`)
      console.log(`[Environment] ${import.meta.env.VITE_ENV_NAME}`)
    }
  },

  // Response handlers
  responded: {
    // Success handler
    onSuccess: handleAlovaResponse,

    // Error handler
    onError: async (error: any, method?: Method) => {
      const cfg = method.config as Record<string, any>
      // 网络类错误自动重试（见 RETRY_DELAYS 注释）：覆盖 iOS「本地网络」授权弹窗期间请求必失败、
      // 以及弱网抖动。重试成功后直接把业务数据交给页面，用户无需手动下拉刷新。
      // NO_RETRY_FLAG：调用方显式声明「快速失败」（检查更新），不参与重试。
      if (method && method.type === 'GET' && !cfg?.[NO_RETRY_FLAG] && isRetryableError(error)) {
        const used: number = cfg?.[RETRY_COUNT_KEY] ?? 0
        if (used < RETRY_DELAYS.length) {
          if (cfg) {
            // 计数写入 config：method.send() 克隆实例时 config 被浅拷贝，下次失败能读到
            cfg[RETRY_COUNT_KEY] = used + 1
          }
          const delay = RETRY_DELAYS[used]
          console.warn(
            `[api] 网络请求失败，${delay}ms 后自动重试（第 ${used + 1}/${RETRY_DELAYS.length} 次）：${method.url}`,
          )
          await sleep(delay)
          // method.send() 会重新走 beforeRequest（重新解析基址）并返回业务数据；
          // 其失败会再次进入本处理器（此时 config 计数已 +1），用尽后交给 handleAlovaError 抛给页面
          return method.send()
        }
      }
      return handleAlovaError(error, method)
    },

    // Complete handler - runs after success or error
    onComplete: async () => {
      // Any cleanup or logging can be done here
    },
  },

  // We'll use the middleware in the hooks
  // middleware is not directly supported in createAlova options

  // Default request timeout (10 seconds)
  timeout: 60000,
  // 设置为null即可全局关闭全部请求缓存
  cacheFor: null,
})

export default alovaInstance
