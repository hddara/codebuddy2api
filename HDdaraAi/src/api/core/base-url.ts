/**
 * API 基址选路（远端配置 + 健康校验 + 本地持久化）
 *
 * 流程（2026-09-20 重构，总原则：**联网成功率优先 —— 任何校验都不得阻塞首屏**）：
 *  1. 每次冷启动都拉一次远端配置（短超时；失败退回本地副本）——配置是**唯一真相源**，
 *     后台把某节点从配置里删掉后，客户端下次启动即不再使用它；
 *  2. 本地存储里的基址仍在配置列表里 → **立即复用（不阻塞）** + **后台并行健康校验**，
 *     校验失败才触发重选（弱网/服务端慢启动时，不会把「其实可用、只是慢」的节点误判掉）；
 *  3. 本地基址已被配置移除 / 后台校验失败 / 近期判过失效 → 候选按「未失效优先」排序 →
 *     逐个健康校验（探测返回 JSON 才算通）→ 第一个通过的写入本地存储并使用；
 *  4. 业务请求失败时按**滑动窗口失败率**判定是否失效 → 清缓存 + 该节点短期不再优先选用 +
 *     **立即主动重选**（有频次闸门，避免多候选同时故障时反复重选拖慢 App）；
 *  5. 每一步都有兜底：远端配置拿不到 → 用本地缓存；本地也没有 → 用编译期候选（VITE_API_BASE_URL）。
 *
 * 远端配置拿不到时回退编译期候选（VITE_API_BASE_URLS / VITE_API_BASE_URL），
 * 保证「配置服务不可用」不会把客户端彻底卡死。
 *
 * 历史背景（2026-09-17 出包实测）：局域网直连单请求 ~4ms；ngrok 免费隧道固定 ~780ms 且对
 * 浏览器 UA 返回 HTML 插页（需带 ngrok-skip-browser-warning 头绕开）。故保留该头逻辑。
 *
 * 【2026-09-20 修复的四个致命缺陷】（实测见 tests/e2e/_probe-api-base-failover.mjs）
 *  ① 原来「缓存命中即复用、不探测」⇒ 坏节点只要还在远端配置里，**重启也永远选它** → 改为缓存节点也校验；
 *  ② 原来 5xx（502/503）不上报失效（handlers.ts 已同步修）⇒ 网关故障时死守坏节点 → 现由 'server' 类型计入失败率；
 *  ③ 原来「连续 2 次超时」判定 ⇒ 单请求链路/抖动型节点永远到不了阈值，且成功会清零计数
 *     → 改为**滑动窗口失败率**（成功不清零，只靠窗口过期）；
 *  ④ 原来失效后要等「下一个业务请求」才重选 ⇒ 首屏全失败、应用不再发请求时永不恢复
 *     → 改为失效后立即主动重选，并加选路代际号防止旧结果覆盖新状态。
 */
import type { RemoteEndpointConfig } from './remote-endpoint'
import { fetchRemoteConfig, resolveEndpoints } from './remote-endpoint'

/** 编译期基址：作为无候选时的兜底（也是配置服务不可用时的最后一道保险） */
const PRIMARY = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

/** 编译期候选：VITE_API_BASE_URLS（逗号分隔）优先，未配置则只有 VITE_API_BASE_URL */
const COMPILE_TIME_CANDIDATES = String(import.meta.env.VITE_API_BASE_URLS || PRIMARY)
  .split(',')
  .map(item => item.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const CACHE_KEY = 'API_BASE_URL_CACHE_V1'
/**
 * 本地基址有效期。节点是否可用以**远端配置 + 健康校验**为准（每次冷启动都会校验），
 * 这里的 TTL 只用于「配置本身拉不到」时避免使用一个很久以前的基址。
 */
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
/** 单候选探测超时（默认值，可被远端配置 probeTimeoutMs 覆盖） */
const DEFAULT_PROBE_TIMEOUT = 1500
/** 探测地址：与业务同源同前缀的轻量公开接口（登录前即可访问） */
const DEFAULT_PROBE_PATH = import.meta.env.VITE_HEALTH_PATH || '/health'
/** 失效重选去抖：一屏多个请求同时失败时只触发一次重选 */
const FAILURE_DEBOUNCE = 5000
/**
 * 冷启动拉配置的超时：配置在对象存储/CDN 上正常远快于此。
 * 超时即沿用本地基址，宁可慢一次也不能把首屏卡住。
 */
const STARTUP_CONFIG_TIMEOUT = 2000

/**
 * 失败判定参数（窗口失败率，替代原「连续 2 次超时」）
 *  - 滑动窗口内失败率 ≥ 50% 且样本数 ≥ 4 → 判定节点失效；
 *  - 网络类失败（连不上）连续 2 次 → 直接判失效（最明确的失效信号，不用等样本够）；
 *  - **成功样本不清空历史失败**（只靠窗口过期），否则「一半请求超时」的抖动型节点永远到不了阈值。
 */
const FAILURE_WINDOW = 30000
const MIN_SAMPLES = 4
const FAILURE_RATE_THRESHOLD = 0.5
const NETWORK_STRIKES = 2
/** 判定失效后该节点在多长时间内不再优先选用（避免选路又立刻选回它；到期自动放行） */
const UNAVAILABLE_TTL = 60000
/** 主动重选的冷却窗口与次数上限（防「多候选同时故障」时反复重选拖慢 App / 耗电） */
const RESELECT_COOLDOWN = 30000
const RESELECT_MAX_IN_WINDOW = 3

let currentBaseUrl = PRIMARY
let resolvePromise: Promise<string> | null = null
/** 本次会话是否已完成启动选路（避免每个业务请求都去拉一次远端配置） */
let bootResolved = false
let lastFailureAt = 0
/** 选路代际号：失效重选时自增，旧一轮选路的结果不得覆盖新一轮状态 */
let epoch = 0

/** 最近的请求结果（滑动窗口，用于失败率判定） */
let outcomes: { at: number, ok: boolean }[] = []
/** 连续网络类失败次数（连不上） */
let networkStrikes = 0
/** 判定失效的节点 → 可再次尝试的时间戳 */
const unavailable = new Map<string, number>()
/** 主动重选的时间戳（滑动窗口，见 canActivelyReselect） */
let reselectTimes: number[] = []

/** 启动时先用缓存值，保证首个请求不必等探测 */
const bootCachedBase = readCache()
if (bootCachedBase) {
  currentBaseUrl = bootCachedBase
}

/** 当前生效的基址（同步读取，供请求前置钩子使用） */
export function getApiBaseUrl(): string {
  return currentBaseUrl || PRIMARY
}

/** 是否走 ngrok 隧道（该类通道需要绕开浏览器插页） */
export function isNgrokBaseUrl(url: string = getApiBaseUrl()): boolean {
  return /ngrok/i.test(url || '')
}

/**
 * 冷启动选路：
 *  1. 每次冷启动都拉一次远端配置（短超时，失败退回本地副本）——这是「后台改完配置能生效」的关键；
 *  2. 本地基址仍在配置列表里 → **校验通过才复用**（避免把已失效节点反复固化到每次启动）；
 *  3. 本地基址不可用（被配置移除 / 校验不过 / 近期判过失效）→ 候选按「未失效优先」排序后逐个健康校验。
 */
export function resolveApiBaseUrl(): Promise<string> {
  // 本次会话已完成启动选路：后续请求直接用结果，不再重复拉配置（否则每个请求都会打一次对象存储）
  if (bootResolved) {
    return Promise.resolve(getApiBaseUrl())
  }
  if (resolvePromise) {
    return resolvePromise
  }
  const cachedBase = readCache()
  if (cachedBase) {
    currentBaseUrl = cachedBase
  }

  const myEpoch = epoch
  const promise = bootResolve(cachedBase, myEpoch)
    .then((base) => {
      // 代际号一致才认为「本次会话选路完成」；否则说明期间又发生了失效重选，交给新一轮决定
      if (myEpoch === epoch) {
        bootResolved = true
      }
      return base
    })
    .finally(() => {
      // 只有「当前代际」的选路才有权清理：并发重选时，旧一轮的收尾不能把新一轮的 promise 置空
      // （否则后续请求会再启动第三个选路，白拉一次配置 + 多探一轮）
      if (myEpoch === epoch) {
        resolvePromise = null
      }
    })
  resolvePromise = promise
  return promise
}

/** 冷启动决策：配置优先于本地缓存（配置里没有的节点一律不再使用） */
async function bootResolve(cachedBase: string, myEpoch: number): Promise<string> {
  const startedAt = Date.now()
  const config = await fetchRemoteConfig(true, STARTUP_CONFIG_TIMEOUT)
  const remoteCandidates = resolveEndpoints(config)
  const { path: probePath, timeout: probeTimeout } = probeOptions(config)

  if (!remoteCandidates.length) {
    // 配置拿不到（离线/对象存储异常）：沿用本地基址；连本地都没有才用编译期候选。
    // 注：此分支不做校验 —— 离线时探测必然失败，校验只会把可用节点也否掉。
    if (cachedBase) {
      console.warn(`[api] 远端配置不可用，沿用本地基址 ${cachedBase}`)
      return cachedBase
    }
    return pickFrom(COMPILE_TIME_CANDIDATES, config, myEpoch)
  }

  if (cachedBase && remoteCandidates.includes(cachedBase)) {
    if (isUnavailable(cachedBase)) {
      console.warn(`[api] 本地基址 ${cachedBase} 近期被判定失效，跳过复用、重新选路`)
      return pickFrom(remoteCandidates, config, myEpoch)
    }
    // ⚠️【为什么是「乐观复用 + 后台校验」而不是「校验通过才复用」】
    // 冷启动阶段**阻塞**做探测，在弱网或服务端慢启动（探测接口响应 >1.5s）时会把
    // 「其实可用、只是慢」的节点误判为不可用 → 不必要地换节点/回退兜底，直接拖慢首屏、
    // 降低联网成功率。这里改为不阻塞：立即用缓存节点发业务请求，同时后台并行校验，
    // **校验失败才触发重选**；万一后台校验与真实情况不符，业务请求失败还会经
    // reportApiFailure 走同一套换节点逻辑（双保险）。
    scheduleCacheCheck(cachedBase, probePath, probeTimeout)
    console.log(`[api] 沿用本地基址 ${cachedBase}（不阻塞首屏、后台并行校验，耗时 ${Date.now() - startedAt}ms）`)
    return cachedBase
  }
  if (cachedBase) {
    console.warn(`[api] 本地基址 ${cachedBase} 已不在远端配置中（或不适用当前端），重新选路`)
  }
  return pickFrom(remoteCandidates, config, myEpoch)
}

/**
 * 缓存节点的**后台**健康校验（不阻塞冷启动）：失败即触发重选，成功则静默。
 * 这里不把探测结果写进失败率统计 —— 它只用于「发现缓存节点已失效」，不该影响业务请求的判定。
 */
function scheduleCacheCheck(base: string, probePath: string, probeTimeout: number) {
  probe(base, probePath, probeTimeout)
    .then(() => {
      console.log(`[api] 后台校验通过：${base} 可用`)
    })
    .catch((e: any) => {
      if (currentBaseUrl !== base) {
        // 期间已被别的逻辑切换过节点，本次结果无意义
        console.warn(`[api] 后台校验失败但基址已变为 ${currentBaseUrl}，忽略：${e?.message || e}`)
        return
      }
      console.warn(`[api] 后台校验失败（${e?.message || e}），触发重选节点`)
      invalidateApiBase(`冷启动后台校验失败：${e?.message || e}`)
    })
}

/**
 * 上报请求失败（由统一错误处理器调用）。
 * @param kind network=连接失败（DNS/拒绝/TLS，节点很可能已失效）；timeout=超时（可能只是慢）；
 *             server=服务端/网关 5xx（502/503/504 属节点级故障，与业务失败不同）
 * @param detail 失败原因（用于日志排查）
 */
export function reportApiFailure(kind: 'network' | 'timeout' | 'server', detail: string) {
  const now = Date.now()
  outcomes.push({ at: now, ok: false })
  trimOutcomes(now)
  if (kind === 'network') {
    networkStrikes += 1
  }
  else {
    networkStrikes = 0
  }

  if (shouldFailover()) {
    invalidateApiBase(`${kind}：${detail}`)
    return
  }
  const failed = outcomes.filter(o => !o.ok).length
  console.warn(
    `[api] 基址 ${currentBaseUrl} 请求失败（${kind}：${detail}）；窗口内失败 ${failed}/${outcomes.length}、网络连击 ${networkStrikes}，未达切换阈值，暂不更换节点`,
  )
}

/** 上报请求成功：记入成功样本（**不清空**失败历史，只靠窗口过期，避免抖动型节点蒙混过关） */
export function markApiHealthy() {
  const now = Date.now()
  outcomes.push({ at: now, ok: true })
  trimOutcomes(now)
  networkStrikes = 0
}

/**
 * 上报「当前基址失效」：清除本地缓存、把该节点列入短期不可用，并**立即主动重选**。
 * 仅在网络层失败 / 5xx / 失败率达阈值时调用，业务错误（如 code!=0、401）不得触发。
 * @param reason 失败原因（用于日志排查）
 */
export function invalidateApiBase(reason: string) {
  const now = Date.now()
  if (now - lastFailureAt < FAILURE_DEBOUNCE) {
    // 一屏多请求同时失败时只处理一次（否则会并发触发多轮重选）
    return
  }
  lastFailureAt = now
  const failedBase = currentBaseUrl
  clearCache()
  if (failedBase) {
    markUnavailable(failedBase)
  }
  outcomes = []
  networkStrikes = 0
  // 代际号自增：让正在进行的旧一轮选路结果失效，避免它覆盖新一轮状态
  epoch += 1
  bootResolved = false
  resolvePromise = null
  console.warn(
    `[api] 基址 ${failedBase || '(空)'} 判定失效（${reason}）：已清除本地缓存、该节点 ${UNAVAILABLE_TTL / 1000}s 内不再优先选用，立即重选节点`,
  )
  // 主动重选：不再依赖「下一个业务请求」触发 —— 首屏全失败时应用可能不再发请求，那样就永远恢复不了。
  // 但必须有冷却：多候选同时故障时，若无节制地重选会反复「拉配置 + 逐个探测」，把 App 拖慢并耗电。
  if (canActivelyReselect()) {
    void resolveApiBaseUrl().catch((e) => {
      console.error('[api] 主动重选节点失败', e)
    })
  }
  else {
    console.warn(
      `[api] ${RESELECT_COOLDOWN / 1000}s 内主动重选已达 ${RESELECT_MAX_IN_WINDOW} 次，暂不主动重选；缓存已清，下一个业务请求会再触发选路`,
    )
  }
}

/**
 * 主动重选的频次闸门：同一窗口内超过上限就不再主动重选。
 * 注意这只是「不主动」，`bootResolved` 已置 false —— 下一个业务请求仍会正常触发选路，不会卡死。
 */
function canActivelyReselect(): boolean {
  const now = Date.now()
  reselectTimes = reselectTimes.filter(at => now - at < RESELECT_COOLDOWN)
  if (reselectTimes.length >= RESELECT_MAX_IN_WINDOW) {
    return false
  }
  reselectTimes.push(now)
  return true
}

/** 是否满足切换阈值（网络连击优先，再看向窗口失败率） */
function shouldFailover(): boolean {
  if (networkStrikes >= NETWORK_STRIKES) {
    return true
  }
  if (outcomes.length < MIN_SAMPLES) {
    return false
  }
  const failed = outcomes.filter(o => !o.ok).length
  return failed / outcomes.length >= FAILURE_RATE_THRESHOLD
}

/** 丢弃滑动窗口之外的样本 */
function trimOutcomes(now: number) {
  if (!outcomes.length) {
    return
  }
  outcomes = outcomes.filter(o => now - o.at <= FAILURE_WINDOW)
}

/** 把节点列入短期不可用 */
function markUnavailable(base: string) {
  if (base) {
    unavailable.set(base, Date.now() + UNAVAILABLE_TTL)
  }
}

/** 该节点当前是否处于「近期判定失效」状态（到期自动恢复） */
function isUnavailable(base: string): boolean {
  const until = unavailable.get(base)
  if (!until) {
    return false
  }
  if (Date.now() > until) {
    unavailable.delete(base)
    return false
  }
  return true
}

/** 候选排序：可用的洗牌在前，近期判定失效的排在最后（不彻底排除，以防它们是仅剩候选） */
function orderCandidates(list: string[]): string[] {
  const shuffled = shuffle(list)
  const usable = shuffled.filter(base => !isUnavailable(base))
  const blocked = shuffled.filter(base => isUnavailable(base))
  if (blocked.length) {
    console.warn(`[api] ${blocked.length} 个候选近期判定失效，排到最后尝试：${blocked.join(', ')}`)
  }
  return [...usable, ...blocked]
}

/** 解析探测参数（远端可覆盖路径与超时） */
function probeOptions(config: RemoteEndpointConfig | null) {
  const path = normalizeProbePath(config?.healthPath) || DEFAULT_PROBE_PATH
  const timeout = Number(config?.probeTimeoutMs) > 0
    ? Number(config!.probeTimeoutMs)
    : DEFAULT_PROBE_TIMEOUT
  return { path, timeout }
}

/** 按「未失效优先」的顺序逐个健康校验，先通过者胜 */
async function pickFrom(
  remoteCandidates: string[],
  config: RemoteEndpointConfig | null,
  myEpoch: number,
): Promise<string> {
  const startedAt = Date.now()
  const source = remoteCandidates.length ? remoteCandidates : COMPILE_TIME_CANDIDATES
  const candidates = orderCandidates(source)
  const { path: probePath, timeout: probeTimeout } = probeOptions(config)

  if (!candidates.length) {
    // 远端与编译期都没有候选：只能用兜底基址，交由业务请求正常报错
    console.error('[api] 无任何可用候选基址（远端配置为空且未配置 VITE_API_BASE_URL）')
    return PRIMARY
  }

  // 逐个探测：不并发发起，避免把多个节点同时打一遍
  for (let i = 0; i < candidates.length; i += 1) {
    const base = candidates[i]
    try {
      await probe(base, probePath, probeTimeout)
      const elapsed = Date.now() - startedAt
      if (myEpoch === epoch) {
        currentBaseUrl = base
        writeCache(base)
        console.log(`[api] 基址选定 → ${base}（候选第 ${i + 1}/${candidates.length} 个，耗时 ${elapsed}ms）`)
      }
      else {
        // 期间又发生了失效重选：本次结果已过期，不写缓存也不覆盖全局状态，只供当前请求使用
        console.warn(`[api] 基址 ${base} 探测通过，但选路已被更新的重选取代，本次不写入缓存（耗时 ${elapsed}ms）`)
      }
      return base
    }
    catch (e: any) {
      console.warn(`[api] 候选不可用，换下一个：${e?.message || e}`)
    }
  }

  // 全部不可达：不写缓存（避免把坏节点持久化），回退编译期首选
  currentBaseUrl = PRIMARY
  console.error(
    `[api] 所有候选（${candidates.length} 个）健康校验均失败，回退编译期基址 ${PRIMARY || '(空)'}，交由业务请求报错`,
  )
  return PRIMARY
}

/** 归一化探测路径：相对路径补前导斜杠，完整 URL 原样返回 */
function normalizeProbePath(path?: string): string {
  const value = String(path ?? '').trim()
  if (!value) {
    return ''
  }
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  return value.startsWith('/') ? value : `/${value}`
}

/** 探测单个候选：必须拿到 JSON 对象才算通（ngrok 插页是 HTML 字符串，视为不通） */
function probe(base: string, probePath: string, timeout: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    uni.request({
      url: `${base}${probePath}${probePath.includes('?') ? '&' : '?'}_probe=${Date.now()}`,
      method: 'GET',
      timeout,
      header: { 'ngrok-skip-browser-warning': '1' },
      success: (res: any) => {
        if (res.statusCode === 200 && res.data && typeof res.data === 'object') {
          resolve(base)
          return
        }
        reject(new Error(`候选 ${base} 探测响应异常：statusCode=${res.statusCode}`))
      },
      // 注：URL 里的 _probe 时间戳用于绕开 CDN/网关缓存（否则探测可能命中缓存的 200 造成「假通过」），
      // 同时也让「探测请求」可与业务请求区分开（业务 GET 用的是 _t）
      fail: (err: any) => reject(new Error(`候选 ${base} 探测失败：${err?.errMsg || err}`)),
    })
  })
}

/** Fisher-Yates 洗牌（随机挑节点用；不改动入参数组） */
function shuffle(list: string[]): string[] {
  const result = [...list]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function readCache(): string {
  try {
    const cache: any = uni.getStorageSync(CACHE_KEY)
    if (cache && typeof cache === 'object' && Date.now() - Number(cache.ts || 0) < CACHE_TTL) {
      return String(cache.base || '')
    }
  }
  catch (e) {
    console.warn('[api] 读取基址缓存失败', e)
  }
  return ''
}

function writeCache(base: string) {
  try {
    uni.setStorageSync(CACHE_KEY, { base, ts: Date.now() })
  }
  catch (e) {
    console.warn('[api] 写入基址缓存失败', e)
  }
}

function clearCache() {
  try {
    uni.removeStorageSync(CACHE_KEY)
  }
  catch (e) {
    console.warn('[api] 清除基址缓存失败', e)
  }
}
