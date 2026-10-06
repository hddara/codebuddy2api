import { ADMIN_COOKIE_NAME, useAuthStore } from '@/store/authStore'
import { getPlatformType } from '@/utils/app-info'
import { createUtf8Decoder } from '@/utils/utf8-stream'
import { getApiBaseUrl } from './core/base-url'
import { alovaInstance } from './core/instance'

export interface SessionRow {
  callCount: number
  conversationId: string
  lastActiveAt: string
  models: string[]
  totalTokens: number
}

export interface SessionListPayload {
  sessions: SessionRow[]
  totals: { calls: number, sessions: number, totalTokens: number }
  ungroupedEvents: number
  windowMinutes: number
}

/**
 * Auth headers for the console (`/admin-api/*`) endpoints.
 *
 * The gateway authenticates these routes solely by the signed session cookie:
 * `Cookie: codebuddy_admin_session=<token>` is the only shape that verifies.
 * Measured against production, all of these are rejected with 401:
 *
 *  - `Cookie: <bare token>` (no name — the value is not the token, the *cookie*
 *    is: the name is part of what gets signed)
 *  - `Authorization: Bearer <token>`
 *  - `Authorization: Bearer codebuddy_admin_session=<token>`
 *
 * The store already normalises what the user typed, so the token is taken from
 * there rather than re-parsed here.
 */
function consoleHeaders(): Record<string, string> {
  const token = useAuthStore().adminCookie.trim()

  return token ? { Cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {}
}

export interface PasswordLoginResult {
  session: {
    authenticated?: boolean
    username?: string
  }
  success?: boolean
  /**
   * The signed session token, returned only to native clients.
   *
   * A browser receives it as an `HttpOnly` cookie and this field is absent. The
   * App runtime cannot read `Set-Cookie` at all, so the same token is echoed in
   * the body — see `buildSessionResponse` on the server for why.
   */
  token?: string
}

/**
 * Signs in with the console account and stores the resulting session token.
 *
 * This is the login a user can actually complete. The previous flow asked for a
 * `codebuddy_admin_session` cookie, which is a browser artifact produced by
 * signing in somewhere else: it is not reachable from the phone, and pasting it
 * required opening devtools on a desktop. Password auth is what the console
 * itself offers, so the app uses it too.
 *
 * The request deliberately bypasses alova's auth interceptor (`skipToken`): the
 * credential being established here is what that interceptor would attach, and
 * sending a stale one alongside the password only invites a 401.
 */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<PasswordLoginResult> {
  return alovaInstance
    .Post<PasswordLoginResult>(
      '/admin-api/auth/session',
      { password, username },
      {
        headers: {
          // Tells the gateway this client cannot read `Set-Cookie`, so it should
          // return the token in the body. Set explicitly rather than relying on
          // the shared interceptor, because `skipToken` skips that whole block.
          'x-client-platform': getPlatformType() || 'APP',
          'skipToken': true,
        },
      } as never,
    )
    .send()
}

export async function fetchSessions(windowMinutes: number): Promise<SessionListPayload> {
  return alovaInstance
    .Get<SessionListPayload>(
      `/admin-api/sessions?windowMinutes=${encodeURIComponent(String(windowMinutes))}`,
      {
        headers: { ...consoleHeaders(), skipToken: true },
      } as never,
    )
    .send()
}

export interface TranscriptEntry {
  accessKeyId: string | null
  answer: string
  answerChars: number
  completedAt: string
  conversationId: string
  error?: string
  id: string
  model: string | null
  question: string
  questionChars: number
  startedAt: string
  status: 'completed' | 'failed'
}

export interface TranscriptPayload {
  entries: TranscriptEntry[]
  settings: { enabled: boolean, maxEntries: number, retentionDays: number }
  totals: { answerChars: number, questionChars: number, stored: number }
}

/**
 * Stored question/answer history for one conversation.
 *
 * Retention is decided server-side (age and count limits), so an entry missing
 * here simply means it was pruned — the app does not need its own cleanup.
 */
export async function fetchTranscripts(
  conversationId: string,
  limit = 50,
): Promise<TranscriptPayload> {
  // Built by hand rather than with `URLSearchParams`: that class does not exist
  // in the App JS runtime, and its absence threw before the request was ever
  // sent — history silently rendered as "0 条" with no network activity.
  const query
    = `conversationId=${encodeURIComponent(conversationId)}`
      + `&limit=${encodeURIComponent(String(limit))}`

  return alovaInstance
    .Get<TranscriptPayload>(`/admin-api/sessions/transcripts?${query}`, {
      headers: { ...consoleHeaders(), skipToken: true },
    } as never)
    .send()
}

/**
 * The App runtime's XHR, which can read a response incrementally.
 *
 * Declared as a structural type rather than reusing the DOM's `XMLHttpRequest`
 * because the plus variant only exposes what the SSE reader needs, and because
 * `lib.dom` is not guaranteed to be in scope for the App build.
 */
interface PlusXhrConstructor {
  new (): {
    abort: () => void
    onerror: (() => void) | null
    onloadend: (() => void) | null
    onprogress: (() => void) | null
    onreadystatechange: (() => void) | null
    readyState: number
    open: (method: string, url: string, async: boolean) => void
    response: ArrayBuffer | null
    responseType: string
    send: () => void
    setRequestHeader: (name: string, value: string) => void
    status: number
  }
}

/**
 * Sends a message to the gateway and streams the answer back.
 *
 * Uses `/admin-api/chat/completions`, which authenticates with the console
 * cookie the app already holds — `/v1/chat/completions` would require a gateway
 * API key, an extra credential the user should not need just to ask a question.
 * The payload is the standard chat-completions shape, so nothing bespoke is
 * introduced on the server side.
 *
 * `conversationId` is threaded through as the upstream conversation id so the
 * answer joins the same thread the IDE is using; it is carried as a header
 * because the body is forwarded verbatim to the provider.
 */
export async function sendChatMessage({
  conversationId,
  message,
  model,
  onDelta,
  onError,
  onStart,
}: {
  conversationId?: string
  message: string
  model?: string
  onDelta: (text: string) => void
  onError: (message: string) => void
  onStart?: () => void
}): Promise<void> {
  const auth = useAuthStore()
  const base = auth.baseUrl || getApiBaseUrl()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...consoleHeaders(),
  }

  if (conversationId) {
    headers['x-conversation-id'] = conversationId
  }

  const response = await new Promise<{
    onChunkReceived?: (handler: (result: { data: ArrayBuffer }) => void) => void
    onHeadersReceived?: (handler: (result: { header: Record<string, string> }) => void) => void
    abort?: () => void
  }>((resolve, reject) => {
    const request = uni.request({
      data: {
        messages: [{ content: message, role: 'user' }],
        model: model || 'deepseek-v4.1-flash',
        stream: true,
      },
      enableChunked: true,
      header: headers,
      method: 'POST',
      timeout: 2_147_483_647 as never,
      url: `${base}/admin-api/chat/completions`,
      fail: (error: { errMsg?: string }) => {
        reject(new Error(String(error?.errMsg ?? '请求失败')))
      },
      success: () => {
        // Streaming responses end here once the server closes; nothing to do.
      },
    } as never) as never

    resolve(request)
  }).catch((error: Error) => {
    onError(error.message)
    return null
  })

  if (!response)
    return

  if (!response.onChunkReceived) {
    onError('当前运行时不支持流式响应，无法显示回答')
    return
  }

  onStart?.()

  const decodeChunk = createUtf8Decoder()
  let buffer = ''

  await new Promise<void>((resolve) => {
    response.onChunkReceived?.((result) => {
      buffer += decodeChunk(result.data)

      const frames = buffer.split(/\n\n/)
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const dataLine = frame
          .split(/\n/)
          .find(line => line.startsWith('data: '))

        if (!dataLine)
          continue

        const payload = dataLine.slice(6)

        if (payload === '[DONE]') {
          resolve()
          return
        }

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>
            error?: { message?: string }
          }

          if (parsed.error?.message) {
            onError(parsed.error.message)
            resolve()
            return
          }

          const text = parsed.choices?.[0]?.delta?.content

          if (typeof text === 'string' && text) {
            onDelta(text)
          }
        }
        catch {
          // A malformed frame is skipped rather than aborting the whole answer.
        }
      }
    })
  })
}

export interface LiveSnapshot {
  accessKeyId: string | null
  live: boolean
  model: string | null
  question: string | null
  text: string
}

/**
 * One-shot read of the live text for a conversation.
 *
 * The App cannot consume SSE (see `openSessionStream`), so it polls this. Cheap
 * by construction: the gateway answers from in-process state, no storage read.
 */
export async function fetchLiveSnapshot(
  conversationId: string,
): Promise<LiveSnapshot> {
  const query = `?conversationId=${encodeURIComponent(conversationId)}`

  return alovaInstance
    .Get<LiveSnapshot>(`/admin-api/sessions/live${query}`, {
      headers: { ...consoleHeaders(), skipToken: true },
    } as never)
    .send()
}

export interface StreamHandle {
  close: () => void
}

/**
 * Opens the live session stream.
 *
 * Uses `uni.request` with `enableChunked` rather than `EventSource`: `EventSource`
 * cannot attach the `Cookie` header, and it is unavailable on several mini-program
 * runtimes. Chunked request + manual SSE framing works on App, H5 and WeChat.
 */
export function openSessionStream({
  conversationId,
  onEvent,
  onError,
}: {
  conversationId?: string
  onEvent: (event: Record<string, unknown>) => void
  onError?: (message: string) => void
}): StreamHandle {
  const auth = useAuthStore()
  const base = auth.baseUrl || getApiBaseUrl()
  const query = conversationId
    ? `?conversationId=${encodeURIComponent(conversationId)}`
    : ''
  const url = `${base}/admin-api/sessions/stream${query}`
  const headers = { Accept: 'text/event-stream', ...consoleHeaders() }

  // Reported through the same channel as runtime failures so an exception here
  // is never mistaken for "waiting for the model".
  let buffer = ''
  let closed = false

  // Feeds raw bytes into the SSE frame parser. Shared by both transports below,
  // so the parsing rules exist in exactly one place.
  const consume = ((): ((bytes: ArrayBuffer) => void) => {
    // Stateful: a Chinese glyph split across two chunks must not decode to
    // replacement characters.
    const decodeChunk = createUtf8Decoder()

    return (bytes: ArrayBuffer) => {
      if (closed)
        return

      buffer += decodeChunk(bytes)

      const frames = buffer.split(/\n\n/)
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        // Comment frames (`: keep-alive`) carry no payload.
        const dataLine = frame
          .split(/\n/)
          .find(line => line.startsWith('data: '))

        if (!dataLine)
          continue

        try {
          const parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>
          if (!closed)
            onEvent(parsed)
        }
        catch {
          // A malformed frame is skipped rather than tearing down the stream.
        }
      }
    }
  })()

  // ---- transport 1: plus.net.XMLHttpRequest ---------------------------
  //
  // Preferred on App. `uni.request`'s chunked mode is a mini-program feature:
  // on App the `enableChunked`/`onChunkReceived` pair silently does nothing
  // when unsupported, so the request never reached the network at all — the
  // gateway logged no connection while the UI sat on "等待活动" forever.
  // XHR's `onprogress` with `responseType: 'arraybuffer'` is the App runtime's
  // documented way to read a stream incrementally.
  //
  // `plus` is injected by the App runtime and only appears once the native
  // bridge is up. Reading it eagerly (module scope, or even at page load on a
  // cold start) can observe `undefined`, which is why the lookup below is a
  // function called when the stream is actually started.
  interface PlusScope { plus?: { net?: { XMLHttpRequest?: PlusXhrConstructor } } }

  const plusXhrCtor = (): PlusXhrConstructor | undefined => {
    const scopes: Array<PlusScope | undefined> = [globalThis as PlusScope]

    // Reading `window` is guarded on purpose: in the App runtime it may be
    // absent — or throw — and an unguarded read aborts this whole function.
    // That is how the stream came to never be opened while nothing was reported
    // anywhere: the exception happened before any transport was chosen.
    try {
      if (typeof window !== 'undefined') {
        scopes.push(window as unknown as PlusScope)
      }
    }
    catch {
      // No browser global here; `globalThis` above already covers this runtime.
    }

    for (const scope of scopes) {
      const ctor = scope?.plus?.net?.XMLHttpRequest
      if (ctor)
        return ctor
    }

    return undefined
  }

  // Distinguishes "the bridge never came up" from "the bridge is there but has
  // no streaming XHR" — two different bugs that both look like a silent stream.
  const describeMissingBridge = (): string => {
    const hasPlus = Boolean(
      (globalThis as { plus?: unknown }).plus
      || (typeof window !== 'undefined'
        && (window as unknown as { plus?: unknown }).plus),
    )

    return hasPlus
      ? '实时连接不可用：当前运行时不支持流式请求'
      : '实时连接不可用：未检测到 App 原生桥（plus）'
  }

  const startXhrStream = (Ctor: PlusXhrConstructor): StreamHandle => {
    let consumedBytes = 0
    const xhr = new Ctor()

    xhr.open('GET', url, true)
    xhr.responseType = 'arraybuffer'
    xhr.setRequestHeader('Accept', headers.Accept)
    for (const [name, value] of Object.entries(headers)) {
      if (name !== 'Accept')
        xhr.setRequestHeader(name, value)
    }

    // Reads whatever has arrived so far.
    //
    // Driven by `onreadystatechange` as well as `onprogress`: in the App runtime
    // `onprogress` is not guaranteed to fire for `responseType: 'arraybuffer'`
    // (the request completes, the bytes arrive, and this callback is simply
    // never invoked — the UI then sits on "等待输出" forever with no error).
    // `readyState >= 3` means the body is being received, which is when there is
    // something to read.
    const drain = (): void => {
      if (closed)
        return

      let chunk: ArrayBuffer | null = null

      try {
        chunk = xhr.response as ArrayBuffer | null
      }
      catch {
        // Reading a partial arraybuffer throws in some implementations.
        return
      }

      if (!chunk || typeof chunk.byteLength !== 'number')
        return
      if (chunk.byteLength <= consumedBytes)
        return

      // `response` is cumulative for arraybuffer responses, so only the new tail
      // is handed to the parser — otherwise every frame would be replayed.
      const fresh = chunk.slice(consumedBytes)
      consumedBytes = chunk.byteLength
      consume(fresh)
    }

    xhr.onprogress = drain
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3)
        drain()
    }

    xhr.onerror = () => {
      if (!closed) {
        onError?.(`实时连接失败（HTTP ${xhr.status || '未知'}）`)
      }
    }

    xhr.onloadend = () => {
      // The final drain matters: the last frames may have arrived without any
      // further progress/readystatechange callback.
      drain()

      // A closed stream is normal: the gateway ends it when the turn finishes,
      // so only a rejected connection is reported. 401 in particular means the
      // console cookie is no longer valid, which is worth naming explicitly —
      // it reads as a UI bug otherwise.
      if (closed || xhr.status < 400)
        return

      onError?.(
        xhr.status === 401
          ? '实时连接被拒绝（401）：控制台凭据已失效，请到「设置」更新 Cookie'
          : `实时连接被拒绝（HTTP ${xhr.status}）`,
      )
    }

    try {
      xhr.send()
    }
    catch (error) {
      onError?.(`实时连接无法建立：${String(error)}`)
    }

    return {
      close: () => {
        closed = true
        try {
          xhr.abort()
        }
        catch {
          // Aborting an already-finished request is harmless.
        }
      },
    }
  }

  // ---- transport 2: fetch（H5 浏览器原生流式）-------------------------
  //
  // Reached only when `plus` never appears, which on App means the bridge failed
  // to start. The App build compiles this out entirely.
  const startFetchStream = (): StreamHandle => {
    const controller = new AbortController()

    void fetch(url, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.body) {
          onError?.(`实时连接不可用（HTTP ${response.status}）`)
          return
        }

        const reader = response.body.getReader()

        for (;;) {
          const { done, value } = await reader.read()
          if (done || closed)
            break
          if (value)
            consume(value.buffer as ArrayBuffer)
        }
      })
      .catch((error: unknown) => {
        if (!closed && (error as { name?: string })?.name !== 'AbortError') {
          onError?.(`实时连接失败：${String(error)}`)
        }
      })

    return {
      close: () => {
        closed = true
        controller.abort()
      },
    }
  }

  // ---- pick a transport ------------------------------------------------
  const immediate = plusXhrCtor()

  if (immediate) {
    return startXhrStream(immediate)
  }

  // On a cold start the page can run before `plus` is injected, so poll briefly
  // rather than giving up on the first miss.
  const POLL_INTERVAL_MS = 300
  const POLL_LIMIT = 10
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: StreamHandle | undefined

  const poll = (): void => {
    if (closed)
      return

    const ctor = plusXhrCtor()

    if (ctor) {
      active = startXhrStream(ctor)
      return
    }

    attempts += 1

    if (attempts >= POLL_LIMIT) {
      // No `plus` at all: inside the App that means the bridge is missing, while
      // in a browser it simply is not part of the platform. Compiling the branch
      // per platform keeps each build honest about which case it can hit.
      // #ifdef H5
      active = startFetchStream()
      // #endif
      // #ifndef H5
      // Be explicit rather than showing "等待活动" forever with no explanation.
      // (A silent no-op here was the original bug: no request, and no error.)
      onError?.(describeMissingBridge())
      // #endif
      return
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS)
  }

  timer = setTimeout(poll, POLL_INTERVAL_MS)

  return {
    close: () => {
      closed = true
      if (timer)
        clearTimeout(timer)
      active?.close()
    },
  }
}
