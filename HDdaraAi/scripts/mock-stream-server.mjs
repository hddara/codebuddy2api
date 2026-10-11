/**
 * A local stand-in for the gateway, used to exercise the App without touching
 * production.
 *
 * Why this exists: verifying the App against production needs a console cookie,
 * and a dead cookie blocks the whole check — the App never reaches the list, so
 * "does this screen work?" stays unanswered. Nothing about those questions is
 * production-specific though. A local server that serves the same shapes answers
 * them directly, and it can also produce states production will not hand you on
 * demand (an empty list, a page boundary, a failure).
 *
 * Endpoints, mirroring the real ones closely enough for the pages to run:
 *
 *   GET    /health                        — the App probes this on boot
 *   POST   /admin-api/auth/session        — password login
 *   GET    /admin-api/sessions            — conversation list
 *   GET    /admin-api/sessions/transcripts— stored Q&A (paged, with totals)
 *   DELETE /admin-api/sessions/transcripts— clear every stored turn
 *   PATCH  /admin-api/sessions/titles/:id — rename a conversation
 *   POST   /admin-api/sessions/titles/backfill
 *   GET    /admin-api/sessions/live       — live snapshot (poll fallback)
 *   GET    /admin-api/sessions/stream     — SSE
 *   POST   /admin-api/chat/completions    — ask a question
 *
 * The data is generated from a seed so a run is reproducible, and the counts are
 * deliberately past the page boundary (see TRANSCRIPT_COUNT) so paging can be
 * exercised rather than only the first screen.
 *
 * Run: node scripts/mock-stream-server.mjs
 * Then point the App's 设置 → 网关地址 at http://<your-lan-ip>:8788 .
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8788)

/** Milliseconds between characters. Slow enough to be visible, fast enough not to bore. */
const CHAR_INTERVAL_MS = 120

const ANSWER = 'STREAM-OK: this text arrived character by character over SSE.\n'

/** Frames are SSE; the client parses `data: ` lines against a blank-line split. */
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`

/** Accumulated per conversation, so the poll endpoint can answer truthfully. */
const sessions = new Map()

/**
 * Stored turns the mock reports.
 *
 * Past `MAX_TRANSCRIPT_PAGE` (500) so the paging behaviour can be checked, and
 * past 200 so the row the App used to render as "no longer retained" is present.
 */
const TRANSCRIPT_COUNT = Number(process.env.MOCK_TRANSCRIPTS ?? 620)

/** How many of them are intermediate tool steps, so folding has something to fold. */
const TOOL_TURN_EVERY = 3

const CONVERSATION_ID = 'mock-conversation-0001'

const pad = (value, width) => String(value).padStart(width, '0')

/**
 * Builds the stored turns once, newest first.
 *
 * Deterministic rather than random: a run has to be reproducible, and a test
 * that only sometimes produces the state under test is not a test. The answers
 * are numbered so a specific row can be named in a report.
 */
const buildTranscripts = () => {
  const base = Date.parse('2026-10-11T00:00:00.000Z')
  const entries = []

  for (let index = 0; index < TRANSCRIPT_COUNT; index += 1) {
    const completedMs = base - index * 60_000
    const completedAt = new Date(completedMs).toISOString()
    const id = `${completedAt}-${CONVERSATION_ID.slice(0, 12)}`
    // Every third turn is a step of a longer task rather than a finished
    // exchange, which is the shape real traffic has.
    const isToolTurn = index % TOOL_TURN_EVERY === 0
    const question = `mock 提问 #${pad(index, 4)}`
    const answer = isToolTurn
      ? `Now re-run the RV to confirm… (step ${pad(index, 4)})`
      : `mock 回答 #${pad(index, 4)} —— 这是一段用于验证列表渲染与分页的占位文本。`

    entries.push({
      accessKeyId: null,
      answer,
      answerChars: answer.length,
      completedAt,
      conversationId: CONVERSATION_ID,
      id,
      model: 'deepseek-v4.1-flash',
      question,
      questionChars: question.length,
      // Started a little before it finished, so the two timestamps differ and a
      // view that confuses them is visible.
      startedAt: new Date(completedMs - 4_000).toISOString(),
      status: 'completed',
      ...(isToolTurn ? { toolTurn: true } : {}),
    })
  }

  return entries
}

let transcripts = buildTranscripts()

const sessionRows = [
  {
    accessKeyName: 'mock key',
    callCount: 128,
    conversationId: CONVERSATION_ID,
    firstSeenAt: transcripts.at(-1)?.startedAt,
    lastActiveAt: transcripts[0]?.completedAt,
    models: ['deepseek-v4.1-flash'],
    title: 'mock 会话（620 条记录）',
    titleSource: 'manual',
    totalTokens: 5_171_858_574,
  },
  {
    callCount: 9,
    conversationId: 'mock-conversation-0002',
    lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    models: ['deepseek-v4.1-flash', 'gpt-5'],
    totalTokens: 12_345,
  },
]

/**
 * CORS headers, so the browser build can talk to this mock.
 *
 * The App reaches the gateway directly and needs none of this, but the H5 build
 * is served from a different port and the browser refuses the response without
 * it. Left off, every request becomes an opaque `request:fail` — which looks
 * exactly like the gateway being down, and would have been misread as a bug in
 * the App rather than a missing header here.
 *
 * `*` for the origin is safe because this server only ever runs on a developer's
 * machine holding mock data.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'Cookie',
    // Requested unconditionally, for any base URL — not only a tunnel. A server
    // that does not allow it fails the preflight, which the App reads as "this
    // address is down" and silently falls back to another candidate. Spelled out
    // here because omitting it is what made this mock look broken.
    'ngrok-skip-browser-warning',
    'x-client-platform',
    'x-conversation-id',
  ].join(', '),
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST',
  'Access-Control-Allow-Origin': '*',
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
    ...headers,
  })
  res.end(JSON.stringify(body))
}

const readBody = req =>
  new Promise(resolve => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      }
      catch {
        resolve({})
      }
    })
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Request log, on by default.
  //
  // Without it a client that never reaches the server is indistinguishable from
  // one whose requests are rejected — both show up as "nothing happened" in the
  // App, and the guess is then aimed at the wrong side. `MOCK_QUIET=1` silences
  // it when the output is in the way.
  if (process.env.MOCK_QUIET !== '1') {
    console.log(`${method} ${path}${url.search}`)
  }

  // The browser build sends a preflight for anything carrying a `Cookie` header
  // or a non-simple method, and a 404 here reads as "the gateway is gone".
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()

    return undefined
  }

  // The App checks this before it will show anything.
  if (path === '/health') {
    return send(res, 200, { service: 'mock-stream', status: 'ok' })
  }

  // The remote endpoint config, which the App fetches on every cold start to
  // decide which base URLs exist. Served here so a build pointed at this mock
  // does not reach out to production for it — that fetch is cross-origin in the
  // browser, fails, and takes the whole selection pipeline down with it, which
  // makes the mock look broken rather than the fetch.
  if (path === '/.well-known/hdara-ai-endpoints.json') {
    return send(res, 200, {
      apis: [
        {
          baseUrl: `http://127.0.0.1:${PORT}`,
          enabled: true,
          name: 'mock',
        },
        // Included deliberately: the App is expected to fall through to the first
        // candidate that answers, and a dead lead entry exercises that.
        {
          baseUrl: 'http://127.0.0.1:1',
          enabled: true,
          name: 'dead-on-purpose',
        },
      ],
      healthPath: '/health',
      probeTimeoutMs: 3_000,
      updatedAt: new Date().toISOString(),
      version: 1,
    })
  }

  // ---- auth ------------------------------------------------------------

  if (path === '/admin-api/auth/session' && method === 'POST') {
    const { password, username } = await readBody(req)

    // The wrong-password branch is worth keeping: the App's copy for it is one
    // of the things being checked, and it cannot be reached against production
    // without knowing a bad credential.
    if (username !== 'admin' || password !== 'admin') {
      return send(res, 401, {
        error: { message: '用户名或密码错误' },
        success: false,
      })
    }

    return send(res, 200, {
      session: { authenticated: true, username },
      success: true,
      token: 'mock-console-session-token',
    })
  }

  // ---- conversation list -----------------------------------------------

  if (path === '/admin-api/sessions' && method === 'GET') {
    const totalTokens = sessionRows.reduce((sum, row) => sum + row.totalTokens, 0)
    const calls = sessionRows.reduce((sum, row) => sum + row.callCount, 0)

    return send(res, 200, {
      sessions: sessionRows,
      totals: { calls, sessions: sessionRows.length, totalTokens },
      ungroupedEvents: 0,
      windowMinutes: Number(url.searchParams.get('windowMinutes') ?? 1440),
    })
  }

  if (path.startsWith('/admin-api/sessions/titles/') && method === 'PATCH') {
    const conversationId = decodeURIComponent(
      path.slice('/admin-api/sessions/titles/'.length),
    )
    const { title } = await readBody(req)
    const row = sessionRows.find(item => item.conversationId === conversationId)

    if (row) {
      row.title = String(title ?? '')
      row.titleSource = 'manual'
    }

    return send(res, 200, { session: { title: String(title ?? '') } })
  }

  if (path === '/admin-api/sessions/titles/backfill' && method === 'POST') {
    return send(res, 200, { generated: 0, remaining: 0, titles: {} })
  }

  // ---- stored Q&A ------------------------------------------------------

  if (path === '/admin-api/sessions/transcripts') {
    if (method === 'DELETE') {
      const removed = transcripts.length
      transcripts = []

      return send(res, 200, { removed })
    }

    if (method === 'GET') {
      const conversationId = url.searchParams.get('conversationId')
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const scoped = conversationId
        ? transcripts.filter(entry => entry.conversationId === conversationId)
        : transcripts

      return send(res, 200, {
        // Totals describe the conversation, not the page — matching the gateway,
        // where summing the page would report two numbers that cannot both be
        // true ("695 stored" on a page holding 40).
        entries: scoped.slice(0, limit),
        settings: { enabled: true, maxEntries: 2_000, retentionDays: 30 },
        totals: {
          answerChars: scoped.reduce((sum, entry) => sum + entry.answerChars, 0),
          questionChars: scoped.reduce((sum, entry) => sum + entry.questionChars, 0),
          stored: scoped.length,
          toolTurns: scoped.filter(entry => entry.toolTurn).length,
        },
      })
    }
  }

  // ---- live ------------------------------------------------------------

  // Empty by default: against production this proves the *stream* carries the
  // text, because a non-empty answer here would make a working poll look like a
  // working stream. `MOCK_LIVE=1` fills it, which is what the live page needs in
  // order to show something without a running turn.
  if (path === '/admin-api/sessions/live') {
    const conversationId = url.searchParams.get('conversationId') ?? ''
    const held = sessions.get(conversationId)
    const echoed = process.env.MOCK_LIVE === '1'

    return send(res, 200, {
      accessKeyId: null,
      live: Boolean(held && !held.done),
      model: echoed ? 'deepseek-v4.1-flash' : null,
      question: echoed ? 'mock 提问' : null,
      text: echoed ? (held?.text ?? ANSWER) : (held?.text ?? ''),
    })
  }

  if (path === '/admin-api/sessions/stream') {
    const conversationId = url.searchParams.get('conversationId') ?? 'mock'

    res.writeHead(200, {
      ...CORS_HEADERS,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    })

    let index = 0
    let timer = null

    const push = () => {
      if (index >= ANSWER.length) {
        res.write(frame({ type: 'session.completed' }))
        clearInterval(timer)
        sessions.set(conversationId, { done: true, text: ANSWER })

        return
      }

      // Each frame carries the whole text so far, matching the real gateway:
      // the page replaces rather than appends, so a cumulative frame cannot be
      // double-counted if one is missed.
      const text = ANSWER.slice(0, index + 1)

      res.write(frame({ text, type: 'session.delta' }))
      sessions.set(conversationId, { done: false, text })
      index += 1
    }

    res.write(frame({ text: '', type: 'session.started' }))
    // A comment frame up front proves the connection is alive before any
    // content, which is how a "connected but idle" stream is told apart from a
    // stream that never opened.
    res.write(': open\n\n')

    timer = setInterval(push, CHAR_INTERVAL_MS)

    req.on('close', () => clearInterval(timer))

    return undefined
  }

  if (path === '/admin-api/chat/completions') {
    // The page posts here and expects the reply on the stream, so the body is
    // only the acknowledgement.
    await readBody(req)

    const conversationId = req.headers['x-conversation-id'] ?? 'mock'

    sessions.set(String(conversationId), { done: false, text: '' })
    send(res, 200, { id: 'mock-turn', object: 'chat.completion' })

    return undefined
  }

  return send(res, 404, { error: { message: `no mock route for ${method} ${path}` } })
})

server.listen(PORT, () => {
  console.log(`mock gateway on http://127.0.0.1:${PORT}`)
  console.log(`  transcripts : ${TRANSCRIPT_COUNT} turns, every ${TOOL_TURN_EVERY}rd a tool step`)
  console.log(`  sessions    : ${sessionRows.length} conversations`)
  console.log(`  login       : admin / admin`)
  console.log(`  stream      : one character every ${CHAR_INTERVAL_MS}ms`)
  console.log(`  MOCK_LIVE=1 fills the poll endpoint instead of leaving it empty`)
})
