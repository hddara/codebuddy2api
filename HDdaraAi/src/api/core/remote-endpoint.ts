/**
 * 远端接口基址配置（对象存储上的 hdara-ai.json）
 *
 * 背景：候选基址原先只能编译期内联（VITE_API_BASE_URLS），换域名、加备用节点都要重新出包。
 * 现改为运行时从对象存储拉取：
 *  - 冷启动 → 拉 hdara-ai.json → 随机挑一个基址做健康校验 → 通过后写入本地存储；
 *  - 本地已有可用基址时**直接使用，不再请求配置**；
 *  - 该基址请求失败（网络错误/超时）时清除本地缓存，并**强制重拉一次配置**再走上面的流程。
 *
 * 配置文件形如：
 * {
 *   "version": 1,
 *   "updatedAt": "2026-09-18 16:50",
 *   "healthPath": "/health",                            // 可选，缺省用内置探测路径
 *   "probeTimeoutMs": 1500,                              // 可选，单候选探测超时
 *   "apis": [
 *     { "name": "生产网关", "baseUrl": "https://code.apimesh.cn", "enabled": true }
 *   ]
 * }
 * apis 元素也支持直接写字符串（"https://host"），不带协议时按 http:// 处理。
 *
 * 【平台限制】小程序真机需把对象存储域名加入「request 合法域名」（开发者工具可勾选"不校验合法域名"绕过）；
 * H5 端跨域需给存储桶配 CORS 规则；App 与小程序为原生请求，不受同源策略限制。
 *
 * 【按端过滤（2026-09-20 新增）】候选可声明 `terminals`（取值 app/mp/alipay/h5），只对指定端生效；
 * 不声明 = 全端可用（兼容旧配置）。存在意义：http 明文 IP 类基址在 H5（HTTPS 页面 Mixed Content 被浏览器
 * 直接阻断）与小程序（request 合法域名校验）上**必然不可用**，若不过滤会白耗一次探测超时，
 * 一旦被缓存命中更会直接卡死当前端（见 base-url.ts 的缓存校验）。
 */

import { getPlatformType } from '@/utils/app-info'

/** 单个候选基址支持的端（app=原生 App/鸿蒙；mp=微信小程序；alipay=支付宝小程序；h5=浏览器） */
export type TerminalKey = 'app' | 'mp' | 'alipay' | 'h5'

/** 配置项：单个候选基址 */
export interface RemoteApiEndpoint {
  name?: string
  baseUrl?: string
  enabled?: boolean
  /** 生效端；缺省或空数组 = 全端可用 */
  terminals?: TerminalKey[] | string[]
}

/** 配置项：远端配置文件结构 */
export interface RemoteEndpointConfig {
  version?: number
  updatedAt?: string
  /** 健康探测路径（含上下文前缀，如 /boot）；缺省时用内置探测路径 */
  healthPath?: string
  /** 单候选探测超时（毫秒） */
  probeTimeoutMs?: number
  apis?: (RemoteApiEndpoint | string)[]
}

/** 默认配置文件地址（可用 VITE_REMOTE_CONFIG_URL 覆盖） */
const DEFAULT_CONFIG_URL
  = 'https://code.apimesh.cn/.well-known/hdara-ai-endpoints.json'

export const REMOTE_CONFIG_URL = String(
  import.meta.env.VITE_REMOTE_CONFIG_URL || DEFAULT_CONFIG_URL,
).trim()

/** 本地副本有效期：12 小时内不重复请求（基址失效时会强制重拉，不受此限制） */
const CONFIG_TTL = 12 * 60 * 60 * 1000
/** 拉取配置超时：配置在存储桶上，正常远快于此 */
const FETCH_TIMEOUT = 4000
const CACHE_KEY = 'REMOTE_ENDPOINT_CONFIG_V1'

interface CachedConfig {
  ts: number
  config: RemoteEndpointConfig
}

/**
 * 归一化单个基址：去空白、去尾部斜杠、补协议。
 * @returns 合法基址；非法/空值返回空串
 */
export function normalizeBaseUrl(raw?: string): string {
  const value = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!value || /\s/.test(value)) {
    return ''
  }
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
  return /^https?:\/\/[^\s/]+/i.test(withScheme) ? withScheme : ''
}

/**
 * 当前端标识（terminals 取值；识别不出时返回空串 = 不做端过滤，宁可用错也不卡死）
 */
export function currentTerminal(): string {
  const platform = getPlatformType()
  if (platform === 'APP') {
    return 'app'
  }
  if (platform === 'WX_MA') {
    return 'mp'
  }
  if (platform === 'MP_ALIPAY') {
    return 'alipay'
  }
  if (platform === 'H5') {
    return 'h5'
  }
  return ''
}

/** 该候选是否对指定端生效（terminals 缺省 = 全端生效） */
function matchTerminal(item: RemoteApiEndpoint, terminal: string): boolean {
  const terminals = item?.terminals
  if (!Array.isArray(terminals) || !terminals.length) {
    return true
  }
  // 端识别不出（空串）时不过滤：宁可多探一次，也不让客户端一个候选都拿不到
  if (!terminal) {
    return true
  }
  return terminals.map(String).includes(terminal)
}

/**
 * 解析配置里的候选基址（过滤禁用项与不适用当前端的项、去重、保序）
 * @param config 远端配置；缺省或非法时回退到内置候选
 * @param terminal 当前端标识；缺省取 currentTerminal()
 */
export function resolveEndpoints(
  config?: RemoteEndpointConfig | null,
  terminal: string = currentTerminal(),
): string[] {
  const list = config?.apis
  if (!Array.isArray(list)) {
    return []
  }
  const result: string[] = []
  /** 忽略端过滤的兜底集（只用于「过滤后为空」的保险） */
  const fallback: string[] = []
  list.forEach((item) => {
    const isObject = item && typeof item === 'object'
    if (isObject && item.enabled === false) {
      return
    }
    const raw = typeof item === 'string' ? item : item?.baseUrl
    const base = normalizeBaseUrl(raw)
    if (!base) {
      return
    }
    if (!fallback.includes(base)) {
      fallback.push(base)
    }
    if (isObject && !matchTerminal(item, terminal)) {
      return
    }
    if (!result.includes(base)) {
      result.push(base)
    }
  })
  // 【保险】按端过滤后一个候选都不剩时，退化为「不过滤」：
  // 宁可让某个端去试一个可能不合适的地址，也绝不能让客户端没有候选可用（联网成功率优先）。
  // 触发即说明后台「适用端」配置有问题，日志会明确提示。
  if (!result.length && fallback.length) {
    console.warn(
      `[api] 按端过滤（当前端=${terminal || '未知'}）后无候选可用，已退化为使用全部启用候选，请检查后台「适用端」配置`,
    )
    return fallback
  }
  return result
}

/** 读取本地副本（ignoreTtl=true 时忽略有效期，用于网络失败兜底） */
export function readConfigCache(ignoreTtl = false): RemoteEndpointConfig | null {
  try {
    const cache = uni.getStorageSync(CACHE_KEY) as CachedConfig
    if (!cache || typeof cache !== 'object' || !cache.config) {
      return null
    }
    if (!ignoreTtl && Date.now() - Number(cache.ts || 0) > CONFIG_TTL) {
      return null
    }
    return cache.config
  }
  catch (e) {
    console.warn('[api] 读取远端接口配置副本失败', e)
    return null
  }
}

function writeConfigCache(config: RemoteEndpointConfig) {
  try {
    uni.setStorageSync(CACHE_KEY, { ts: Date.now(), config } as CachedConfig)
  }
  catch (e) {
    console.warn('[api] 写入远端接口配置副本失败', e)
  }
}

/**
 * 拉取远端配置文件。
 * @param force 忽略本地副本有效期，强制发起请求（冷启动校验与基址失效重选时都走这里）
 * @param timeout 本次请求超时（冷启动会给一个较短的超时，避免拖住首屏）
 * @returns 配置对象；网络失败时回退本地副本（含过期副本），都没有则返回 null
 */
export function fetchRemoteConfig(force = false, timeout = FETCH_TIMEOUT): Promise<RemoteEndpointConfig | null> {
  if (!force) {
    const cached = readConfigCache()
    if (cached && resolveEndpoints(cached).length) {
      return Promise.resolve(cached)
    }
  }

  return new Promise<RemoteEndpointConfig | null>((resolve) => {
    uni.request({
      // 加时间戳绕开 CDN/客户端缓存，保证改完配置立即生效
      url: `${REMOTE_CONFIG_URL}${REMOTE_CONFIG_URL.includes('?') ? '&' : '?'}_t=${Date.now()}`,
      method: 'GET',
      timeout,
      success: (res: any) => {
        const data = typeof res.data === 'string' ? safeParse(res.data) : res.data
        if (res.statusCode !== 200 || !data || typeof data !== 'object') {
          console.warn(`[api] 远端接口配置响应异常：statusCode=${res.statusCode}`, res.data)
          resolve(readConfigCache(true))
          return
        }
        const config = data as RemoteEndpointConfig
        if (!resolveEndpoints(config).length) {
          console.warn('[api] 远端接口配置里没有可用基址（apis 为空）', config)
          resolve(readConfigCache(true))
          return
        }
        writeConfigCache(config)
        console.log(
          `[api] 远端接口配置已更新：updatedAt=${config.updatedAt || '(未填)'}，候选=${resolveEndpoints(config).join(', ')}`,
        )
        resolve(config)
      },
      fail: (err: any) => {
        console.warn(`[api] 拉取远端接口配置失败：${err?.errMsg || err}，回退本地副本`)
        resolve(readConfigCache(true))
      },
    })
  })
}

/**
 * Parses a response body that may arrive as a JSON string.
 *
 * Exported because the base-URL probe hits the same platform quirk: the App
 * runtime does not always decode JSON for the caller, so a body that is an
 * object on the wire arrives here as a string.
 */
export function safeParse(text: string) {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}
