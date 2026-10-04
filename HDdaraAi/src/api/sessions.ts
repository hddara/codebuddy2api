import { useAuthStore } from '@/store/authStore'
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
 * Those routes authenticate with the signed admin cookie, and the raw cookie
 * value is stored at login, so it is replayed as a `Cookie` header. This works
 * on App and H5; some mini-program runtimes restrict the `Cookie` header, which
 * is why the settings page also accepts a gateway API key.
 */
function consoleHeaders(): Record<string, string> {
  const auth = useAuthStore()

  return auth.adminCookie ? { Cookie: auth.adminCookie } : {}
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
  const query = new URLSearchParams({
    conversationId,
    limit: String(limit),
  })

  return alovaInstance
    .Get<TranscriptPayload>(`/admin-api/sessions/transcripts?${query.toString()}`, {
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

  const request = uni.request({
    enableChunked: true,
    header: {
      Accept: 'text/event-stream',
      ...consoleHeaders(),
    },
    method: 'GET',
    timeout: 0 as never,
    url: `${base}/admin-api/sessions/stream${query}`,
    fail: (error) => {
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
    const text = new TextDecoder('utf-8').decode(result.data)

    buffer += text

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
