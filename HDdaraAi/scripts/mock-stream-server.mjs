/**
 * A local stand-in for the gateway's session stream, used to prove the App
 * actually consumes SSE incrementally.
 *
 * Why this exists: verifying streaming against production needed a console
 * cookie, and a dead cookie blocks the whole check — the App never reaches the
 * live page, so "does it stream?" stays unanswered. Nothing about the question
 * is production-specific though: what is under test is whether
 * `plus.net.XMLHttpRequest` in the App runtime delivers an SSE body in pieces or
 * in one lump at the end. A local server emitting the same frames at a known
 * cadence answers that directly, and the cadence is chosen to be unmistakable.
 *
 * The two endpoints mirror the real ones closely enough for the page to run:
 *
 *   GET  /health                 — the App probes this on boot
 *   POST /admin-api/chat/completions — the question; streams `session.delta`
 *   GET  /admin-api/sessions/live    — the poll fallback; deliberately returns
 *                                      `live: false` so the stream is the only
 *                                      source of text
 *
 * The poll returning nothing is what makes the result readable. If the screen
 * fills in gradually, the frames came over the stream; if it stays empty, the
 * stream is not being read and the poll had nothing to fall back on.
 *
 * Run: node scripts/mock-stream-server.mjs
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

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const path = url.pathname

  // The App checks this before it will show anything.
  if (path === '/health') {
    return send(res, 200, { service: 'mock-stream', status: 'ok' })
  }

  // Deliberately always empty: the point is to prove the *stream* carries the
  // text. A non-empty answer here would make a working poll look like a working
  // stream, which is exactly the confusion this script exists to remove.
  if (path === '/admin-api/sessions/live') {
    return send(res, 200, {
      accessKeyId: null,
      live: false,
      model: null,
      question: null,
      text: '',
    })
  }

  if (path === '/admin-api/sessions/stream') {
    const conversationId = url.searchParams.get('conversationId') ?? 'mock'

    res.writeHead(200, {
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
    let body = ''

    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const conversationId = req.headers['x-conversation-id'] ?? 'mock'

      sessions.set(String(conversationId), { done: false, text: '' })
      send(res, 200, { id: 'mock-turn', object: 'chat.completion' })
    })

    return undefined
  }

  return send(res, 404, { error: { message: `no mock route for ${path}` } })
})

server.listen(PORT, () => {
  console.log(`mock gateway on http://127.0.0.1:${PORT}`)
  console.log(`  stream : /admin-api/sessions/stream?conversationId=mock`)
  console.log(`  poll   : returns no text on purpose, so the stream is the only source`)
  console.log(`  cadence: one character every ${CHAR_INTERVAL_MS}ms`)
})
