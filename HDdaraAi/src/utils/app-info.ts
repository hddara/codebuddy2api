/**
 * 客户端信息（平台 / 版本 / 设备）
 *
 * 【用途】每个请求都带上 platform-type / app-version / app-version-code / device-info：
 * 后端 ClientContextFilter 把它写入日志上下文（日志行的 [client] 段）与访问日志，
 * 排查时可直接回答「是不是只有小程序 3.1.0 有问题」「是不是某机型才有」「某用户是不是特定版本」。
 *
 * 【版本号来源】
 *  - 编译期：vite.config.ts 的 define 把 manifest.config.ts 的 versionName/versionCode
 *    注入为 __APP_VERSION__ / __APP_VERSION_CODE__（发版改 manifest.config.ts，产物与上报自动一致）；
 *  - App 端运行时优先取 plus.runtime.version（安装包真实版本，云打包可能覆盖 manifest 值）。
 */

/** 设备信息缓存：getSystemInfoSync 有开销且每个请求都要用，进程内只取一次 */
let cachedDeviceInfo: string | null = null

/** 设备信息最长长度（服务端还会再截断） */
const MAX_DEVICE_INFO_LENGTH = 120

/**
 * 运行端标识（与后端 OpenPlatformTypeEnum 取值一致：APP / WX_MA / MP_ALIPAY / H5）
 * <p>用条件编译分离，各端产物只保留自己的分支；服务端据此决定可用支付方式与交易形态</p>
 */
export function getPlatformType(): string {
  let platform = ''
  // #ifdef APP-PLUS
  platform = 'APP'
  // #endif
  // #ifdef APP-HARMONY
  // 鸿蒙端：plus 不可用（APP-PLUS 不命中），但语义上同为「App 端」——后端据此取 App 交易形态、
  // 支付方式按终端 1（App）下发、token 有效期 1 天滑动续期（见 PayMethodConfigService / TocLoginService）
  platform = 'APP'
  // #endif
  // #ifdef MP-WEIXIN
  platform = 'WX_MA'
  // #endif
  // #ifdef MP-ALIPAY
  // 支付宝小程序：独立端（可用渠道只有支付宝、调起用 my.tradePay），不能复用 WX_MA / H5
  platform = 'MP_ALIPAY'
  // #endif
  // #ifdef H5
  platform = 'H5'
  // #endif
  return platform
}

/**
 * 客户端版本号（如 3.1.0）
 *
 * 【为什么优先编译期注入值、而不是 plus.runtime.version】
 * 离线打包下 plus.runtime.version 读的是**壳工程**版本（Android build.gradle / iOS Info.plist），
 * 只发资源（wgt 热更，或本次这种「只换 www 资源」的整包）时壳版本不会跟着涨 ⇒ 会出现
 * 「设置页显示 v3.5.1，但点检查更新提示已是最新 v3.5.2」这种自相矛盾（2026-09-20 用户报）。
 * 而更新判断用的就是编译期注入的 __APP_VERSION_CODE__，所以显示与上报必须同源，
 * 否则同一台设备会出现两个「当前版本」。运行态值仅作兜底（注入值缺失时）。
 */
export function getAppVersion(): string {
  const injected = String(__APP_VERSION__ || '')
  if (injected) {
    return injected
  }
  // #ifdef APP-PLUS
  try {
    const plusRuntime = (globalThis as any).plus?.runtime
    if (plusRuntime?.version) {
      return String(plusRuntime.version)
    }
  }
  catch {
    // 忽略：取不到就只能返回空
  }
  // #endif
  return ''
}

/** 客户端版本号（数字，如 310） */
export function getAppVersionCode(): string {
  return String(__APP_VERSION_CODE__ || '')
}

/**
 * 设备信息（机型 / 系统 / 微信版本）
 * <p>微信端额外带 wx 版本：同一机型不同基础库版本表现可能不同，是排查小程序问题的关键维度</p>
 */
export function getDeviceInfo(): string {
  if (cachedDeviceInfo !== null) {
    return cachedDeviceInfo
  }
  try {
    const info: any = uni.getSystemInfoSync()
    const model = [info.brand, info.model].filter(Boolean).join(' ') || info.deviceType || ''
    const parts = [model, info.system]
    if (info.version && getPlatformType() === 'WX_MA') {
      parts.push(`wx${info.version}`)
    }
    cachedDeviceInfo = parts.filter(Boolean).join(' / ').slice(0, MAX_DEVICE_INFO_LENGTH)
  }
  catch (e) {
    console.warn('[app-info] 获取设备信息失败', e)
    cachedDeviceInfo = ''
  }
  return cachedDeviceInfo
}
