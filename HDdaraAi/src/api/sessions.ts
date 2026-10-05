import { ADMIN_COOKIE_NAME, useAuthStore } from '@/store/authStore'
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
  let buffer = ''
  let closed = false
  // Stateful: a Chinese glyph split across two chunks must not decode to
  // replacement characters.
  const decodeChunk = createUtf8Decoder()

  const request = uni.request({
    enableChunked: true,
    header: {
      Accept: 'text/event-stream',
      ...consoleHeaders(),
    },
    method: 'GET',
    timeout: 0 as never,
    url: `${base}/admin-api/sessions/stream${query}`,
    fail: (error: { errMsg?: string }) => {
      if (!closed) {
        onError?.(String(error?.errMsg ?? 'stream failed'))
      }
    },
    success: () => {
      // The stream ends when the server closes it; nothing to do.
    },
  } as never) as unknown as {
    abort?: () => void
    onChunkReceived?: (handler: (result: { data: ArrayBuffer }) => void) => void
  }

  request.onChunkReceived?.((result) => {
    buffer += decodeChunk(result.data)

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

        if (!closed) {
          onEvent(parsed)
        }
      }
      catch {
        // A malformed frame is skipped rather than tearing down the stream.
      }
    }
  })

  return {
    close: () => {
      closed = true
      request.abort?.()
    },
  }
}
