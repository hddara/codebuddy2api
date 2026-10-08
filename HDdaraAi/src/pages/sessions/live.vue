<script setup lang="ts">
import type { ChatHandle, ChatMessage, StreamHandle } from '@/api/sessions'
import { onLoad, onPageScroll, onUnload } from '@dcloudio/uni-app'

import { computed, nextTick, ref } from 'vue'
import { fetchLiveSnapshot, openSessionStream, sendChatMessage } from '@/api/sessions'
import StateBlock from '@/components/StateBlock.vue'
import { isAuthError, REAUTH_HINT } from '@/utils/errors'
import { renderIncremental, resetIncrementalRender } from '@/utils/incremental-markdown'

definePage({
  name: 'session-live',
  style: { navigationBarTitleText: '实时回复' },
})

interface Turn {
  /** Answer text as it arrives. */
  answer: string
  /** Stable identity for the list key; index-based keys misbehave on prepend. */
  id: number
  question: string
  /** Set when this turn was cancelled so the UI can say so instead of "failed". */
  stopped: boolean
}

const conversationId = ref('')
const turns = ref<Turn[]>([])
const draft = ref('')
const status = ref<'idle' | 'live' | 'done' | 'failed'>('idle')
const statusLabel = ref('正在连接…')
const errorMessage = ref('')
const sending = ref(false)
const draftFocused = ref(false)

/**
 * The answer being written right now, or the last one on screen.
 *
 * Polling replaces the whole text on every round, so the source of truth is the
 * newest snapshot rather than an accumulation of deltas. This is what the
 * transcript area renders while a turn is open.
 */
const latestAnswer = ref('')

let handle: StreamHandle | null = null
let chat: ChatHandle | null = null
/** Turns completed in this session, sent back as history on the next question. */
const history: ChatMessage[] = []
/**
 * How many messages of history go upstream, newest kept.
 *
 * The array used to grow without bound while every question sent all of it, so
 * a long session eventually posted hundreds of exchanges — each with a full
 * answer — and the request either exceeded the model's context or spent most of
 * its time re-reading old turns. Twice this many messages is this many turns,
 * since a turn is a question and its answer.
 *
 * Trimming on push rather than at send time keeps the array itself bounded, so
 * the memory it holds is capped too and not just the payload.
 */
const HISTORY_MESSAGE_LIMIT = 40
let turnSeq = 0

/**
 * How many settled turns the page keeps on screen, newest kept.
 *
 * The list is a place to look back a little, not an archive — the transcript
 * page is the archive, and it loads one turn at a time. Keeping every turn meant
 * a long session held all of them in full: hundreds of blocks, each with a
 * whole answer, all laid out at once.
 */
const TURN_LIMIT = 30
/**
 * Characters of a settled turn kept for display.
 *
 * Long enough to recognise a turn while scrolling past, short enough that thirty
 * of them stay cheap. The ellipsis is honest about the cut: the full text is one
 * tap away on the transcript page, and pretending otherwise would have people
 * reading a silently clipped answer.
 */
const TURN_PREVIEW_CHARS = 600

/** Truncates for display, leaving short values untouched. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** Appends a turn's messages, dropping the oldest once the window is full. */
function rememberTurn(question: string, answer: string) {
  history.push({ content: question, role: 'user' })
  history.push({ content: answer, role: 'assistant' })

  if (history.length > HISTORY_MESSAGE_LIMIT) {
    history.splice(0, history.length - HISTORY_MESSAGE_LIMIT)
  }
}

/**
 * Rendered HTML for the open answer, recomputed only when the text changes.
 *
 * A `computed` rather than the previous inline `rendered()` call: the template
 * used to invoke the function on every render, and `reply` changed on every poll,
 * so the whole answer was re-parsed and handed to `<rich-text>` as a brand-new
 * node tree roughly once a second. The incremental renderer keeps the settled
 * prefix cached, so an update now re-parses only the paragraph being written.
 */
const answerHtml = computed(() => {
  if (!latestAnswer.value)
    return ''

  return renderIncremental(latestAnswer.value).html
})

const hasAnswer = computed(() => Boolean(latestAnswer.value.trim()))

// Reads `sending` alone, not `status`.
//
// `status` flips to 'done' on the gateway's replayed `session.completed`
// for the previous turn, which happened constantly right after a question
// was sent — and because the button was keyed off `status === 'live'` it fell
// back to 发送 the moment the answer began arriving. The panel was still
// showing 正在输出…, so the button contradicted the text above it. Whether a
// turn is open is a fact about this page's own turn, which is `sending`.
const isStreaming = computed(() => sending.value)

function append(text: string) {
  latestAnswer.value += text
  scrollToEnd()
}

/**
 * Keeps the newest line in view, but only when the reader is already at the end.
 *
 * The previous version scrolled unconditionally, which made it impossible to read
 * back through a long answer while it was still being written — every delta
 * yanked the view to the bottom. `stickToEnd` is cleared when the user scrolls
 * away and restored when they return, which is the behaviour of every chat UI.
 */
const stickToEnd = ref(true)
let scrollPending = false

function scrollToEnd() {
  if (!stickToEnd.value || scrollPending)
    return

  scrollPending = true
  void nextTick(() => {
    scrollPending = false
    uni.pageScrollTo({ duration: 0, scrollTop: 100_000 })
  })
}

/**
 * Re-arms auto-follow when the reader scrolls back down.
 *
 * `enablePullDownRefresh` is off, so this is the page's `onPageScroll` hook
 * rather than a scroll-view event.
 */
function handlePageScroll(event: { scrollTop: number }) {
  if (stickToEnd.value)
    return

  // Re-attach only when the reader is genuinely back at the tail.
  //
  // The earlier check was `scrollTop > 0`, which is true for every position
  // except the very top: the moment you scrolled up even slightly the page
  // re-armed auto-follow and `scrollToEnd()` yanked it back to the bottom. A
  // long reply could not be read at all — every attempt to scroll up was undone
  // on the next frame, which reads as "the page will not drag".
  //
  // Tolerance rather than an exact comparison: `scrollTop` is fractional while
  // scrolling settles, and the last line is a few pixels from the end.
  const NEAR_END_TOLERANCE = 40

  uni.getSystemInfo({
    fail: () => {},
    success: (info) => {
      const viewport = Number(info.windowHeight) || 0

      if (!viewport)
        return

      // Query the document height to tell "near the bottom" from "somewhere in
      // the middle"; `onPageScroll` only reports the offset.
      uni.createSelectorQuery()
        .select('.page')
        .boundingClientRect((rect) => {
          const contentHeight = Number((rect as { height?: number } | null)?.height) || 0

          if (!contentHeight)
            return

          const distanceFromEnd = contentHeight - event.scrollTop - viewport

          if (distanceFromEnd <= NEAR_END_TOLERANCE) {
            stickToEnd.value = true
            scrollToEnd()
          }
        })
        .exec()
    },
  })
}

/** Called when the reader scrolls up: stop following the tail. */
function onScrollAway() {
  stickToEnd.value = false
}

/**
 * How long after a turn starts a stop request is ignored.
 *
 * The composer holds one button that swaps between 发送 and 终止 in place, which
 * is right for the layout but wrong for a touch: a press sends DOWN then UP, and
 * the re-render lands between them, so the UP is delivered to the button that
 * has just replaced the one that was pressed. One tap then both started a turn
 * and immediately cancelled it, leaving "已终止，未收到内容" where the answer
 * should be — seen on a device as a question that stops itself the instant it is
 * asked.
 *
 * Long enough to cover a press (a tap is tens of milliseconds; 500ms is a slow
 * one), short enough that nobody who wants to stop has to press twice.
 */
const STOP_GRACE_MS = 500
/** When the current turn was started, for the grace period above. */
let turnStartedAt = 0

/**
 * True while a turn this page started is still being answered.
 *
 * Separate from `sending` on purpose. `sending` gates the composer and the 终止
 * button, and it must track the *turn*; it used to be cleared when the POST
 * resolved, which happens as soon as the gateway accepts the question. The reply
 * arrives afterwards on the session stream, so the button flipped back to 发送
 * while the answer was still appearing — 终止 was unreachable in exactly the
 * situation it exists for. This flag carries the turn across that boundary.
 */
let ownTurn = false

/**
 * Consecutive polls in which the answer did not grow.
 *
 * The second half of "is it finished". `session.completed` covers the streaming
 * case; this covers the fallback, where an answer that stops getting longer is
 * as done as it is going to be. Growth resets it, so a slow model is not
 * mistaken for a finished one.
 */
let stallRounds = 0
/** Answer length at the previous poll, for the growth check above. */
let ownTurnLastLength = 0

/**
 * Closes a turn this page started, once its answer has actually finished.
 *
 * Idempotent: the stream's completion event and the request's own resolution can
 * both reach it, and whichever arrives second is a no-op.
 */
function finalizeOwnTurn(stopped: boolean) {
  if (!ownTurn)
    return

  ownTurn = false
  commitTurn(stopped)
  sending.value = false
  chat = null
}

function applyEvent(event: Record<string, unknown>) {
  const type = String(event.type ?? '')

  // The stream is the text, always.
  //
  // It used to be suppressed while this page had a question open, on the theory
  // that the chat response's deltas were the better source. They are not: the
  // gateway acknowledges that POST immediately and broadcasts the reply here
  // instead, so suppressing the stream meant the answer this page was waiting for
  // arrived on the channel that had just been switched off. What the suppression
  // was really protecting against — two writers assigning `latestAnswer` at once
  // — is handled the other way round now: the chat's own `onDelta` stands down
  // while the stream is live, so there is still exactly one writer.
  //
  // The wording still distinguishes an answer this page is driving from one it
  // is only watching. Stopping is possible in the first case and impossible in
  // the second — `stop()` aborts a local request and there is no server-side
  // cancel — so saying which is which keeps the missing button expected rather
  // than broken.
  const ownTurnOpen = sending.value

  if (type === 'session.snapshot') {
    latestAnswer.value = String(event.text ?? '')

    status.value = 'live'
    statusLabel.value = ownTurnOpen ? '正在输出…' : '别处正在输出…'
    return
  }

  if (type === 'session.delta') {
    const text = event.text

    if (typeof text === 'string' && text) {
      latestAnswer.value = text
    }
    else {
      append(String(event.delta ?? ''))
    }

    status.value = 'live'
    statusLabel.value = ownTurnOpen ? '正在输出…' : '别处正在输出…'
    return
  }

  if (type === 'session.completed') {
    status.value = 'done'
    statusLabel.value = '回答完成'
    // Deliberately does not close the turn.
    //
    // The stream replays the previous turn's completion on subscribe, and a frame
    // carries no turn id, so there is no way to tell that event from this turn's
    // own. Acting on it filed the turn away mid-answer — the question and a
    // truncated reply committed together while the rest was still arriving. The
    // poll's growth check is the ending that cannot be spoofed, so it owns
    // closing; this only reports status.
    return
  }

  if (type === 'session.failed') {
    status.value = 'failed'
    statusLabel.value = '回答失败'
    errorMessage.value = String(event.error ?? '未知错误')
  }
}

/**
 * Starts watching a turn that is already in progress.
 *
 * Two transports, and the ordering between them is the whole design.
 *
 * The SSE stream in `openSessionStream` is the real one: it delivers deltas as
 * the model produces them, which is what makes the App match the IDE. Polling a
 * snapshot every 900ms is the fallback — it can say what the answer is now, but
 * not how it is arriving, so a reply reads as a slideshow of stills.
 *
 * An earlier version of this file concluded the App could not consume SSE at all
 * and put the stream behind `#ifdef H5`. That conclusion came from watching the
 * screen stay at `0 字` while frames were published — but the cause was the
 * request never being made in the first place (the call was compiled out, and
 * `uni.request`'s chunked mode is a mini-program feature that is a no-op here).
 * `plus.net.XMLHttpRequest` with a cumulative `response` is the App runtime's
 * documented incremental transport and is implemented in `openSessionStream`.
 */
const POLL_INTERVAL_MS = 900
/** Consecutive quiet reads before the watcher stops; a turn may simply be late. */
const IDLE_ROUNDS_BEFORE_STOP = 10
/**
 * Quiet polls that end an answer this page asked for.
 *
 * Shorter than the idle threshold on purpose: the answer is being watched, so
 * the question is "has it stopped growing", and four polls (~3.6s) is long
 * enough that a model pausing mid-paragraph is not mistaken for a finished one.
 * This is the only ending that can be trusted — see `session.completed`.
 */
const STALL_ROUNDS = 4

let pollTimer: ReturnType<typeof setTimeout> | null = null
let idleRounds = 0
let watching = false
/**
 * True while the SSE stream is connected and delivering frames.
 *
 * Gates the poll's text writes so the two transports do not fight over
 * `latestAnswer`. Set on the first frame rather than on open, because a socket
 * that connects and then stays silent should not be trusted over a poll that is
 * demonstrably returning content.
 */
let streamLive = false
/**
 * Why the stream is not the thing being used, when it is not.
 *
 * Surfaced instead of hidden: the fallback still works, so a silent downgrade
 * leaves a page that looks healthy while quietly updating once a second, and the
 * one case worth acting on — rejected credentials — is exactly the one a silent
 * path hides longest.
 */
const streamError = ref('')
/** Set by `onUnload` so in-flight work stops touching a page that no longer exists. */
let unloaded = false

function stopWatching() {
  watching = false
  streamLive = false

  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }

  // The stream is torn down here too, and that is not incidental.
  //
  // `stopWatching` used to clear only the poll timer, so the SSE connection
  // outlived every restart of the watcher. `ask()` calls `stopWatching()` then
  // `subscribe()`, so each question left the previous connection open: ten
  // questions meant ten live requests all still delivering frames into
  // `onEvent`, overwriting each other's text and keeping their sockets until the
  // page went away. Releasing it is the point of stopping.
  handle?.close()
  handle = null
}

async function pollOnce() {
  if (!watching || !conversationId.value)
    return

  try {
    const snapshot = await fetchLiveSnapshot(conversationId.value)

    if (snapshot.text) {
      idleRounds = 0

      // Only the poll writes the text, and only when the stream is not feeding
      // it. Both carry the answer and both would otherwise write it: a snapshot
      // is the whole reply so far, so assigning it while deltas are arriving
      // makes the text jump backwards to wherever the last poll landed and then
      // forward again — flicker, not streaming.
      //
      // The stream is authoritative whenever it is live; polling still owns the
      // status line, idle counting and the stop-after-idle rule below, so a
      // stream that dies leaves the fallback fully working.
      if (!streamLive) {
        // The endpoint returns the whole text so far, so replacing (rather than
        // appending) keeps this correct across missed or duplicated polls.
        if (snapshot.text !== latestAnswer.value) {
          latestAnswer.value = snapshot.text
          scrollToEnd()
        }
      }

      // An answer that has stopped getting longer is finished, which is the one
      // ending the fallback transport can detect on its own: it sees lengths, not
      // events. Growth resets the counter, so a slow model is not cut off — it
      // takes ten quiet polls (about nine seconds) to decide.
      if (sending.value && ownTurn) {
        if (latestAnswer.value.length > ownTurnLastLength) {
          ownTurnLastLength = latestAnswer.value.length
          stallRounds = 0
        }
        else if (++stallRounds >= STALL_ROUNDS) {
          stopWatching()
          finalizeOwnTurn(false)

          return
        }
      }

      status.value = 'live'
      statusLabel.value = sending.value ? '正在输出…' : '别处正在输出…'
      errorMessage.value = ''
    }
    else {
      idleRounds += 1

      if (idleRounds >= IDLE_ROUNDS_BEFORE_STOP) {
        // Nothing has started. Stop rather than poll forever; sending a question
        // starts the watcher again.
        stopWatching()
        // A turn this page opened is finished by definition if the conversation
        // has gone quiet: without this it would stay open, holding 终止 on screen
        // for an answer that already stopped arriving.
        finalizeOwnTurn(false)

        return
      }
    }
  }
  catch (error) {
    if (isAuthError(error)) {
      errorMessage.value = REAUTH_HINT
      status.value = 'failed'
      statusLabel.value = '连接失败'
      stopWatching()

      return
    }
    // A transient failure is not worth showing; the next round retries.
  }

  pollTimer = setTimeout(() => void pollOnce(), POLL_INTERVAL_MS)
}

function subscribe() {
  if (!conversationId.value)
    return

  watching = true
  idleRounds = 0

  // The stream is opened first and the poll only as a fallback, in that order.
  //
  // This used to be the other way round, with the stream behind `#ifdef H5`, so
  // the App — the only platform that needs it — compiled the call away and fell
  // back to polling. Polling asks "what is the whole answer so far?" every
  // 900ms, so a reply arrived as a slideshow of snapshots with up to a second of
  // lag, while the IDE showed it token by token. `openSessionStream` already
  // carries a working `plus.net.XMLHttpRequest` reader for exactly this runtime;
  // it simply was not being called here.
  //
  // Polling stays: it is what recovers a stream that never opened (an old shell
  // without the native bridge) and it seeds the first snapshot, since
  // `session.delta` frames carry only new text. It stops on its own once idle.
  try {
    handle = openSessionStream({
      conversationId: conversationId.value,
      onError: (message) => {
        // A dropped stream hands the text back to the poll, which is the only
        // transport guaranteed to work.
        //
        // The message is no longer discarded. On its own a silent downgrade is
        // indistinguishable from normal operation: `openSessionStream` reports
        // "credentials rejected" and "no native bridge" separately, and throwing
        // both away meant a 401 looked exactly like a healthy page that simply
        // had nothing to show. The distinction matters most for the credential
        // case, where the user's next step is to re-enter it.
        streamLive = false
        streamError.value = message

        if (isAuthError(message)) {
          errorMessage.value = REAUTH_HINT
          status.value = 'failed'
          statusLabel.value = '连接失败'
        }
      },
      onEvent: (event) => {
        streamLive = true
        streamError.value = ''
        idleRounds = 0
        applyEvent(event)
      },
    })
  }
  catch (error) {
    // `openSessionStream` throws when no transport is available; polling below
    // remains the whole mechanism in that case, which is why it is not fatal.
    //
    // It is still recorded, because "no transport" is not nothing: on the App it
    // means the native bridge is missing or older than the streaming API, and
    // the page is about to fall back to a visibly slower refresh. Silent is how
    // that went unnoticed.
    streamError.value = error instanceof Error
      ? error.message
      : '实时连接不可用，已降级为轮询刷新'
  }

  void pollOnce()
}

/** The question whose answer is currently on screen. */
const pendingQuestion = ref('')

/** Commits the open turn to the list so the next question starts a fresh one. */
function commitTurn(stopped: boolean) {
  const question = pendingQuestion.value
  const answer = latestAnswer.value

  if (!question && !answer)
    return

  turns.value.push({
    // Trimmed for display only: the whole answer is on the transcript page, and
    // this list is a scrolling history rather than a record. A long session used
    // to keep every turn in full, so the page accumulated hundreds of blocks of
    // tens of thousands of characters each and the App ran out of room laying
    // them out.
    answer: clip(answer, TURN_PREVIEW_CHARS),
    id: (turnSeq += 1),
    question: clip(question, TURN_PREVIEW_CHARS),
    stopped,
  })

  if (turns.value.length > TURN_LIMIT) {
    turns.value.splice(0, turns.value.length - TURN_LIMIT)
  }

  // Only a completed turn belongs in the history sent upstream: replaying a
  // cancelled answer would feed the model its own truncated output.
  if (!stopped && question) {
    rememberTurn(question, answer)
  }

  pendingQuestion.value = ''
  latestAnswer.value = ''
  resetIncrementalRender()
}

async function ask() {
  const text = draft.value.trim()

  if (!text || sending.value)
    return

  // Guarded here rather than relying on the composer being hidden: `onLoad`
  // reports a missing id, but the composer is rendered from state that a failed
  // subscribe does not change, so the send button stays live. Posting without an
  // id would drop the question into whatever conversation the gateway defaults
  // to — the user would believe it went to the one on screen.
  if (!conversationId.value) {
    uni.showToast({ icon: 'none', title: '缺少会话标识，无法提问' })

    return
  }

  // A previous turn is still on screen: fold it into the list before starting.
  if (pendingQuestion.value) {
    commitTurn(false)
  }
  else if (latestAnswer.value) {
    // An answer that arrived while this page was only watching: it belongs to the
    // conversation but not to a turn opened here, and a turn without a question
    // is not worth keeping. Left in place it would be shown as the answer to the
    // question about to be asked, which is worse than dropping it — the real
    // text is on the conversation record either way.
    latestAnswer.value = ''
    resetIncrementalRender()
  }

  sending.value = true
  ownTurn = true
  ownTurnLastLength = 0
  stallRounds = 0
  // Stamped so `stopTurn` can tell a deliberate press from the tail of the tap
  // that started the turn. See the grace period there.
  turnStartedAt = Date.now()
  errorMessage.value = ''
  stickToEnd.value = true
  pendingQuestion.value = text
  draft.value = ''
  status.value = 'live'
  statusLabel.value = '正在提交…'

  // Restart the watcher so the reply is picked up even if it had gone idle.
  stopWatching()
  subscribe()

  chat = sendChatMessage({
    conversationId: conversationId.value,
    message: text,
    // The whole history, so a follow-up has the earlier turns in front of it.
    messages: [...history, { content: text, role: 'user' }],
    // Stands down while the stream is live, so only one of them writes the text.
    // In practice the stream is the one that carries the reply; this is here for
    // the case where the request itself streams instead.
    onDelta: (delta) => {
      if (!streamLive) {
        append(delta)
      }
    },
    onError: (message) => {
      errorMessage.value = message
      status.value = 'failed'
      statusLabel.value = '回答失败'
    },
    onDone: () => {
      status.value = 'done'
      statusLabel.value = '回答完成'
    },
    onStart: () => {
      statusLabel.value = '正在输出…'
    },
  })

  const outcome = await chat.done

  // The page can be gone by the time the turn ends: the user backs out while a
  // reply is streaming, and `onUnload` stopping the chat is what resolves this
  // promise. Writing refs after teardown is harmless on the dead instance, but
  // the `scrollToEnd` inside `commitTurn` reaches a live page — the next session
  // the user opens — and jumps it.
  if (unloaded)
    return

  if (outcome.stopped) {
    status.value = 'done'
    statusLabel.value = '已终止'
    finalizeOwnTurn(true)
  }

  // A resolved request is not a finished answer.
  //
  // Nothing here closes the turn, and that is the point.
  //
  // This endpoint acknowledges the question immediately; the reply is broadcast
  // on the session stream afterwards. So this promise settling says nothing at
  // all about the answer — it can resolve before the first character arrives, or
  // after the last one. Closing here on "some text has arrived" committed the
  // answer at whatever length it had reached, which on a device looked like the
  // turn ending with `答 Here` while the rest of the reply kept streaming into a
  // question that had already been filed away.
  //
  // The ending belongs to the watcher, and specifically to the poll's growth
  // check: it sees the answer stop getting longer, which no replayed event can
  // fake, and it also covers the case where nothing ever arrives.
}

/** Ends the turn in progress, keeping the text received so far. */
function stopTurn() {
  if (!chat || !sending.value)
    return

  // A stop that arrives in the same gesture as the send is the button swap, not
  // a person changing their mind. Ignoring it is what keeps a question from
  // being answered with "已终止，未收到内容".
  if (Date.now() - turnStartedAt < STOP_GRACE_MS) {
    return
  }

  chat.stop()
  stopWatching()
}

function copyReply() {
  const text = latestAnswer.value

  if (!text)
    return

  uni.setClipboardData({
    data: text,
    success: () => uni.showToast({ icon: 'none', title: '已复制' }),
  })
}

/** Re-sends the last question after a failure, without retyping it. */
function retryLast() {
  const last = turns.value.at(-1)

  if (!last?.question)
    return

  draft.value = last.question
  void ask()
}

onLoad((query) => {
  const raw = String((query as Record<string, string>)?.conversationId ?? '')

  // `decodeURIComponent` throws `URIError` on a lone `%` or a malformed escape,
  // and the value comes straight from the route — a deep link or a hand-edited
  // URL is enough. Unhandled it aborted `onLoad`, which shows as a blank page
  // rather than as the bad parameter it is.
  try {
    conversationId.value = decodeURIComponent(raw)
  }
  catch {
    conversationId.value = raw
  }

  // Without an id there is nothing to watch and nowhere to send: `subscribe`
  // and `pollOnce` both return immediately on an empty id, so the page would sit
  // on "没有正在进行的输出" while still accepting a question — and `ask()` would
  // post it with no conversation context at all, landing it in whatever stream
  // the gateway picks by default. Saying so is better than pretending.
  if (!conversationId.value) {
    status.value = 'failed'
    statusLabel.value = '缺少会话标识'
    errorMessage.value = '这个页面没有拿到会话标识，无法读取或提问。请从会话列表重新进入。'

    return
  }

  subscribe()
})

/**
 * uni's page-level scroll hook. Wired here rather than through a `<scroll-view>`
 * because the transcript uses the page's own scrolling, which is what makes
 * `uni.pageScrollTo` work.
 *
 * The hook is only useful for *re-attaching*: detaching happens on the touch that
 * starts a scroll up, which this event cannot distinguish from a programmatic
 * scroll to the bottom. `onTouchMove` covers that side, so a reader who scrolls
 * up is not yanked back by the next delta.
 */
onPageScroll(handlePageScroll)

onUnload(() => {
  // Set first, so anything already in flight sees it. `chat.stop()` below
  // resolves the pending `ask()`; without this flag that continuation would
  // commit a turn into a page that no longer exists.
  unloaded = true

  // Keep what arrived before tearing anything down.
  //
  // Leaving mid-answer used to discard the turn outright: the partial reply was
  // never committed, so coming back showed nothing and the reader had to ask
  // again — with no way to tell whether anything had been received at all. The
  // text is already on screen at this point, so dropping it was strictly worse
  // than keeping it.
  //
  // Committed as stopped, which is what the reader did by leaving: it keeps the
  // text out of `history` (a truncated answer must not be replayed upstream as
  // if the model had produced it) while still showing it in the list.
  if (sending.value || pendingQuestion.value || latestAnswer.value) {
    commitTurn(true)
  }

  stopWatching()
  chat?.stop()
  chat = null
  resetIncrementalRender()
})
</script>

<template>
  <!-- Detach auto-follow the moment the reader touches the page: `onPageScroll`
       cannot tell a finger from a programmatic scroll, so without this a delta
       arriving mid-gesture would snap the view back to the bottom.

       `@touchstart` rather than `@touchmove`: both detach, but binding move on
       the root container puts every drag through this handler during gesture
       arbitration, which made vertical scrolling feel sticky. The intent is
       "the reader took control", which a touch already expresses. -->
  <view class="page" @touchstart="onScrollAway">
    <view class="status">
      <view class="status-dot" :class="[`dot-${status}`]" />
      <text class="status-label">{{ statusLabel }}</text>
      <text class="status-count">{{ latestAnswer.length }} 字</text>
      <button v-if="hasAnswer" class="status-copy" @tap="copyReply">
        复制
      </button>
    </view>

    <view v-if="errorMessage" class="error">
      <text class="error-text">{{ errorMessage }}</text>
      <button class="error-action" @tap="retryLast">
        重试
      </button>
    </view>

    <!-- Shown only when the stream is not the active transport and something
         went wrong with it. The page still works through polling, so without
         this the downgrade is invisible: everything looks healthy while the text
         updates once a second. -->
    <view v-if="streamError && !errorMessage" class="notice">
      <text class="notice-text">{{ streamError }}</text>
    </view>

    <!-- Settled turns. Kept as plain text excerpts: they are already committed
         and re-rendering them would put the streaming cost back. -->
    <view v-for="turn in turns" :key="turn.id" class="turn">
      <view class="turn-question">
        <text class="turn-role">你</text>
        <text class="turn-text">{{ turn.question }}</text>
      </view>
      <view class="turn-answer">
        <text class="turn-role turn-role-answer">答</text>
        <text class="turn-text turn-text-answer">{{ turn.answer || '（已终止，未收到内容）' }}</text>
        <text v-if="turn.stopped" class="turn-flag">已终止</text>
      </view>
    </view>

    <!-- Open turn -->
    <view v-if="pendingQuestion || hasAnswer" class="panel">
      <view v-if="pendingQuestion" class="panel-question">
        <text class="turn-role">你</text>
        <text class="turn-text">{{ pendingQuestion }}</text>
      </view>
      <rich-text v-if="hasAnswer" class="content" :nodes="answerHtml" />
      <StateBlock
        v-else
        variant="plain"
        :loading="sending"
        :text="sending ? '正在等待回答…' : '还没有内容'"
      />
    </view>

    <StateBlock
      v-else-if="turns.length === 0"
      text="该会话当前没有正在进行的输出。"
      hint="在下方提问，或在 IDE 里发起请求后会实时出现在这里。"
    />

    <view class="composer">
      <textarea
        v-model="draft"
        class="composer-input"
        :disabled="sending"
        placeholder="向这个会话提问…"
        auto-height
        :focus="draftFocused"
        @focus="draftFocused = true"
        @blur="draftFocused = false"
      />
      <button
        v-if="!isStreaming"
        class="composer-send"
        :disabled="!draft.trim()"
        @tap="ask"
      >
        发送
      </button>
      <!-- Replaces 发送 while a turn is open: one primary action at a time, and
           stopping is the only thing the user can usefully do. -->
      <button v-else class="composer-stop" @tap="stopTurn">
        终止
      </button>
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: 20rpx $gap-page 260rpx;
  box-sizing: border-box;
  background-color: $color-page;
}

.status {
  display: flex;
  align-items: center;
  gap: $gap-inline;
  padding: 16rpx 20rpx;
  border-radius: $radius-control;
  background-color: $color-surface;
}

.status-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background-color: #c8ccd2;
}

.dot-live {
  background-color: $color-primary;
}

.dot-done {
  background-color: $color-success;
}

.dot-failed {
  background-color: $color-danger;
}

.status-label {
  font-size: $font-label;
  color: $color-text;
}

.status-count {
  margin-left: auto;
  font-size: $font-meta;
  color: $color-text-muted;
}

.status-copy {
  font-size: $font-meta;
  color: $color-primary;
  display: inline-block;
  width: auto;
  margin: 0;
  padding: 4rpx 12rpx;
  line-height: 1.5;
  background-color: transparent;
}

.status-copy::after {
  border: none;
}

.error {
  display: flex;
  align-items: center;
  gap: $gap-inline;
  margin-top: 16rpx;
  padding: 16rpx 20rpx;
  border-radius: $radius-control;
  background-color: $color-danger-surface;
  font-size: $font-meta;
  color: $color-danger;
}

/* Deliberately quieter than `.error`: the page is still working, just not
   optimistically, and colouring it like a failure would overstate it. */
.notice {
  margin-top: 12rpx;
  padding: 12rpx 20rpx;
  border-radius: $radius-control;
  background-color: $color-surface;
  font-size: $font-micro;
  line-height: 1.6;
  color: $color-text-faint;
}

.notice-text {
  line-height: 1.6;
}

.error-text {
  flex: 1;
  line-height: 1.6;
}

.error-action {
  flex: none;
  padding: 6rpx 24rpx;
  border: 1rpx solid $color-danger;
  border-radius: $radius-pill;
  color: $color-danger;
  display: inline-block;
  width: auto;
  margin: 0;
  line-height: 1.5;
  font-size: $font-meta;
  background-color: transparent;
}

.error-action::after {
  border: none;
}

/* Settled turns: a compact transcript rather than a second copy of the answer. */
.turn {
  margin-top: 16rpx;
  padding: 20rpx;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.turn-question,
.turn-answer {
  display: flex;
  gap: $gap-inline;
  align-items: flex-start;
}

.turn-answer {
  margin-top: 14rpx;
  padding-top: 14rpx;
  border-top: 1rpx solid $color-border-strong;
}

.turn-role {
  flex: none;
  width: 40rpx;
  height: 40rpx;
  border-radius: 10rpx;
  background-color: $color-primary;
  font-size: $font-micro;
  line-height: 40rpx;
  text-align: center;
  color: #ffffff;
}

.turn-role-answer {
  background-color: $color-text-secondary;
}

.turn-text {
  flex: 1;
  font-size: $font-body;
  line-height: 1.7;
  color: $color-text;
  word-break: break-word;
}

.turn-text-answer {
  color: $color-text-secondary;
}

.turn-flag {
  flex: none;
  align-self: flex-start;
  margin-left: $gap-inline;
  padding: 4rpx 16rpx;
  border-radius: $radius-pill;
  background-color: $color-page;
  font-size: $font-micro;
  color: $color-text-muted;
}

.panel {
  margin-top: 16rpx;
  padding: 24rpx;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.panel-question {
  display: flex;
  gap: $gap-inline;
  align-items: flex-start;
  padding-bottom: 18rpx;
  margin-bottom: 18rpx;
  border-bottom: 1rpx solid $color-border-strong;
}

.content {
  font-size: $font-section;
  line-height: 1.75;
  color: $color-text;
  word-break: break-word;
}

.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 16rpx;
  padding: 20rpx $gap-page calc(20rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
  background-color: $color-surface;
  border-top: 1rpx solid $color-border;
}

.composer-input {
  flex: 1;
  min-height: 76rpx;
  max-height: 240rpx;
  padding: 18rpx 20rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-page;
  font-size: $font-body;
  color: $color-text;
}

.composer-send,
.composer-stop {
  flex: none;
  min-width: 150rpx;
  height: 76rpx;
  line-height: 76rpx;
  margin: 0;
  padding: 0 24rpx;
  border-radius: $radius-control;
  font-size: $font-body;
  color: #ffffff;
}

.composer-send {
  background-color: $color-primary;
}

.composer-send[disabled] {
  background-color: $color-primary-disabled;
  color: #ffffff;
}

/* Danger-tinted so it does not read as "send again". */
.composer-stop {
  background-color: $color-danger;
}
</style>
