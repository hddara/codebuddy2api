<script setup lang="ts">
import type { ChatHandle, ChatMessage, StreamHandle } from '@/api/sessions'
import { onLoad, onPageScroll, onUnload } from '@dcloudio/uni-app'

import { computed, nextTick, ref } from 'vue'
import { fetchLiveSnapshot, openSessionStream, sendChatMessage } from '@/api/sessions'
import StateBlock from '@/components/StateBlock.vue'
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
const statusLabel = ref('等待输出')
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
let turnSeq = 0

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

const isStreaming = computed(() => status.value === 'live' && sending.value)

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

  // Measured against the viewport rather than the content element: the page
  // scrolls the document, so the bound is "scrolled past the end of the screen",
  // which is what `getSystemInfo().windowHeight` reports.
  uni.getSystemInfo({
    fail: () => {},
    success: (info) => {
      const viewport = Number(info.windowHeight) || 0

      if (!viewport)
        return

      // No reliable content height from this hook, so re-attach on any upward
      // return rather than trying to compute the exact distance from the bottom.
      if (event.scrollTop > 0) {
        stickToEnd.value = true
        scrollToEnd()
      }
    },
  })
}

/** Called when the reader scrolls up: stop following the tail. */
function onScrollAway() {
  stickToEnd.value = false
}

function applyEvent(event: Record<string, unknown>) {
  const type = String(event.type ?? '')

  if (type === 'session.snapshot') {
    latestAnswer.value = String(event.text ?? '')
    status.value = 'live'
    statusLabel.value = '正在输出…'
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
    statusLabel.value = '正在输出…'
    return
  }

  if (type === 'session.completed') {
    status.value = 'done'
    statusLabel.value = '回答完成'
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
 * The App polls a snapshot endpoint instead of subscribing to SSE. It does open
 * the SSE request — the gateway logs it — but no bytes ever reach the page, so
 * the screen sat at `0 字` while 29 frames were published against the device.
 * `uni.request`'s chunked mode is a mini-program feature and is a no-op here too,
 * which leaves polling as the only transport the App can actually use.
 */
const POLL_INTERVAL_MS = 900
/** Consecutive quiet reads before the watcher stops; a turn may simply be late. */
const IDLE_ROUNDS_BEFORE_STOP = 10

let pollTimer: ReturnType<typeof setTimeout> | null = null
let idleRounds = 0
let watching = false

function stopWatching() {
  watching = false

  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

async function pollOnce() {
  if (!watching || !conversationId.value)
    return

  try {
    const snapshot = await fetchLiveSnapshot(conversationId.value)

    if (snapshot.text) {
      idleRounds = 0

      // The endpoint returns the whole text so far, so replacing (rather than
      // appending) keeps this correct across missed or duplicated polls.
      if (snapshot.text !== latestAnswer.value) {
        latestAnswer.value = snapshot.text
        scrollToEnd()
      }

      status.value = 'live'
      statusLabel.value = '正在输出…'
      errorMessage.value = ''
    }
    else {
      idleRounds += 1

      if (idleRounds >= IDLE_ROUNDS_BEFORE_STOP) {
        // Nothing has started. Stop rather than poll forever; sending a question
        // starts the watcher again.
        stopWatching()

        return
      }
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '读取实时状态失败'

    if (/session required|401|unauthor/i.test(message)) {
      errorMessage.value = '控制台凭据已失效，请到「设置」重新填入新的 Cookie'
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
  void pollOnce()

  // The browser build keeps SSE, which genuinely streams there. It is additive:
  // the poll above is the source of truth and stops on its own once idle.
  // #ifdef H5
  try {
    handle = openSessionStream({
      conversationId: conversationId.value,
      onError: () => {},
      onEvent: applyEvent,
    })
  }
  catch {
    // Polling still covers this.
  }
  // #endif
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
    answer,
    id: (turnSeq += 1),
    question,
    stopped,
  })

  // Only a completed turn belongs in the history sent upstream: replaying a
  // cancelled answer would feed the model its own truncated output.
  if (!stopped && question) {
    history.push({ content: question, role: 'user' })
    history.push({ content: answer, role: 'assistant' })
  }

  pendingQuestion.value = ''
  latestAnswer.value = ''
  resetIncrementalRender()
}

async function ask() {
  const text = draft.value.trim()

  if (!text || sending.value)
    return

  // A previous turn is still on screen: fold it into the list before starting.
  if (hasAnswer.value || pendingQuestion.value) {
    commitTurn(false)
  }

  sending.value = true
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
    onDelta: delta => append(delta),
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

  if (outcome.stopped) {
    status.value = 'done'
    statusLabel.value = '已终止'
    // Keep whatever arrived; the user asked to stop, not to discard.
    commitTurn(true)
  }

  sending.value = false
  chat = null
}

/** Ends the turn in progress, keeping the text received so far. */
function stopTurn() {
  if (!chat || !sending.value)
    return

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
  conversationId.value = decodeURIComponent(
    String((query as Record<string, string>)?.conversationId ?? ''),
  )
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
  stopWatching()
  chat?.stop()
  handle?.close()
  handle = null
  resetIncrementalRender()
})
</script>

<template>
  <!-- `@touchmove` detaches auto-follow the moment the reader touches the page.
       `onPageScroll` cannot tell a finger from a programmatic scroll, so without
       this a delta arriving mid-gesture would snap the view back to the bottom. -->
  <view class="page" @touchmove="onScrollAway">
    <view class="status">
      <view class="status-dot" :class="[`dot-${status}`]" />
      <text class="status-label">{{ statusLabel }}</text>
      <text class="status-count">{{ latestAnswer.length }} 字</text>
      <text v-if="hasAnswer" class="status-copy" @tap="copyReply">复制</text>
    </view>

    <view v-if="errorMessage" class="error">
      <text class="error-text">{{ errorMessage }}</text>
      <text class="error-action" @tap="retryLast">重试</text>
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
