<script setup lang="ts">
import type { StreamHandle } from '@/api/sessions'
import { onLoad, onUnload } from '@dcloudio/uni-app'

import { nextTick, ref } from 'vue'
import { fetchLiveSnapshot, openSessionStream, sendChatMessage } from '@/api/sessions'
import { renderMarkdown } from '@/utils/markdown'

definePage({
  name: 'session-live',
  style: { navigationBarTitleText: '实时回复' },
})

const conversationId = ref('')
const reply = ref('')
const draft = ref('')
const status = ref<'idle' | 'live' | 'done' | 'failed'>('idle')
const statusLabel = ref('等待输出')
const errorMessage = ref('')
const sending = ref(false)
const eventCount = ref(0)

let handle: StreamHandle | null = null

const rendered = () => (reply.value ? renderMarkdown(reply.value) : '')

/**
 * Appends streamed text and keeps the view pinned to the newest line.
 *
 * Scrolling is deferred to the next tick: the content height is only correct
 * after the render that the assignment triggers, so querying it immediately
 * would scroll to the position the text used to occupy.
 */
function append(text: string) {
  reply.value += text
  eventCount.value += 1
  void nextTick(() => {
    uni.pageScrollTo({ duration: 0, scrollTop: 100_000 })
  })
}

function applyEvent(event: Record<string, unknown>) {
  const type = String(event.type ?? '')

  if (type === 'session.snapshot') {
    reply.value = String(event.text ?? '')
    status.value = 'live'
    statusLabel.value = '正在输出…'
    return
  }

  if (type === 'session.delta') {
    const text = event.text
    if (typeof text === 'string' && text) {
      reply.value = text
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
 * Starts watching the live turn.
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
let stopped = false

function stopWatching() {
  stopped = true
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

async function pollOnce() {
  if (stopped || !conversationId.value)
    return

  try {
    const snapshot = await fetchLiveSnapshot(conversationId.value)

    if (snapshot.text) {
      idleRounds = 0

      // The endpoint returns the whole text so far, so replacing (rather than
      // appending) keeps this correct across missed or duplicated polls.
      if (snapshot.text !== reply.value) {
        reply.value = snapshot.text
        eventCount.value += 1
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

  stopped = false
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

async function ask() {
  const text = draft.value.trim()

  if (!text || sending.value)
    return

  sending.value = true
  errorMessage.value = ''
  reply.value = ''
  eventCount.value = 0
  status.value = 'live'
  statusLabel.value = '正在提交…'

  // Restart the watcher so the reply is picked up even if it had gone idle.
  stopWatching()
  stopped = false
  idleRounds = 0
  pollTimer = setTimeout(() => void pollOnce(), POLL_INTERVAL_MS)

  // Echo the question into the transcript area so the answer has context even
  // before the first delta lands.
  append(`**你：** ${text}\n\n---\n\n`)

  try {
    await sendChatMessage({
      conversationId: conversationId.value,
      message: text,
      onDelta: delta => append(delta),
      onError: (message) => {
        errorMessage.value = message
        status.value = 'failed'
        statusLabel.value = '回答失败'
      },
      onStart: () => {
        statusLabel.value = '正在输出…'
      },
    })

    if (!errorMessage.value) {
      status.value = 'done'
      statusLabel.value = '回答完成'
      draft.value = ''
    }
  }
  catch (error) {
    errorMessage.value = String(error)
    status.value = 'failed'
    statusLabel.value = '提问失败'
  }
  finally {
    sending.value = false
  }
}

function copyReply() {
  if (!reply.value)
    return
  uni.setClipboardData({
    data: reply.value,
    success: () => uni.showToast({ icon: 'none', title: '已复制' }),
  })
}

onLoad((query) => {
  conversationId.value = decodeURIComponent(
    String((query as Record<string, string>)?.conversationId ?? ''),
  )
  subscribe()
})

onUnload(() => {
  stopWatching()
  handle?.close()
  handle = null
})
</script>

<template>
  <view class="page">
    <view class="status">
      <view class="status-dot" :class="[`dot-${status}`]" />
      <text class="status-label">{{ statusLabel }}</text>
      <text class="status-count">{{ reply.length }} 字</text>
      <text class="status-copy" @tap="copyReply">复制</text>
    </view>

    <view v-if="errorMessage" class="error">
      {{ errorMessage }}
    </view>

    <view class="panel">
      <view v-if="!reply" class="empty">
        <text>该会话当前没有正在进行的输出。</text>
        <text class="empty-sub">在下方提问，或在 IDE 里发起请求后会实时出现在这里。</text>
      </view>
      <rich-text v-else class="content" :nodes="rendered()" />
    </view>

    <view class="composer">
      <textarea
        v-model="draft"
        class="composer-input"
        :disabled="sending"
        placeholder="向这个会话提问…"
        auto-height
      />
      <button class="composer-send" :disabled="sending || !draft.trim()" @tap="ask">
        {{ sending ? '发送中…' : '发送' }}
      </button>
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20rpx 24rpx 240rpx;
  box-sizing: border-box;
  background-color: #f5f6f8;
}

.status {
  display: flex;
  align-items: center;
  gap: 12rpx;
  padding: 16rpx 20rpx;
  border-radius: 16rpx;
  background-color: #ffffff;
}

.status-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background-color: #c8ccd2;
}

.dot-live {
  background-color: #0a84ff;
}

.dot-done {
  background-color: #22a06b;
}

.dot-failed {
  background-color: #cf1322;
}

.status-label {
  font-size: 26rpx;
  color: #1f2329;
}

.status-count,
.status-copy {
  font-size: 24rpx;
  color: #8a8f99;
}

/* Pushes 复制 to the right edge without a spacer element. */
.status-count {
  margin-left: auto;
}

.status-copy {
  color: #0a84ff;
}

.error {
  margin-top: 16rpx;
  padding: 16rpx 20rpx;
  border-radius: 16rpx;
  background-color: #fff1f0;
  font-size: 25rpx;
  color: #cf1322;
  line-height: 1.6;
}

.panel {
  margin-top: 16rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.empty {
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.8;
}

.empty-sub {
  display: block;
  margin-top: 8rpx;
  font-size: 24rpx;
  color: #a8adb5;
}

.content {
  font-size: 28rpx;
  line-height: 1.75;
  color: #1f2329;
  word-break: break-word;
}

.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 16rpx;
  padding: 20rpx 24rpx calc(20rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
  background-color: #ffffff;
  border-top: 1rpx solid #e6e8eb;
}

.composer-input {
  flex: 1;
  min-height: 76rpx;
  max-height: 240rpx;
  padding: 18rpx 20rpx;
  box-sizing: border-box;
  border-radius: 16rpx;
  background-color: #f5f6f8;
  font-size: 27rpx;
  color: #1f2329;
}

.composer-send {
  flex: none;
  min-width: 150rpx;
  height: 76rpx;
  line-height: 76rpx;
  margin: 0;
  padding: 0 24rpx;
  border-radius: 16rpx;
  background-color: #0a84ff;
  color: #ffffff;
  font-size: 27rpx;
}

.composer-send[disabled] {
  background-color: #b9d4f5;
  color: #ffffff;
}
</style>
