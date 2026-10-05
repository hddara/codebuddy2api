<script setup lang="ts">
import type { StreamHandle, TranscriptEntry } from '@/api/sessions'
import { onLoad, onUnload } from '@dcloudio/uni-app'

import { ref } from 'vue'
import {
  fetchTranscripts,
  openSessionStream,
  sendChatMessage,
} from '@/api/sessions'

definePage({
  name: 'session-detail',
  style: { navigationBarTitleText: '会话详情' },
})

const conversationId = ref('')
const replyText = ref('')
const status = ref<'idle' | 'live' | 'done' | 'failed'>('idle')
const statusLabel = ref('等待活动')
const errorMessage = ref('')
const model = ref('')
const eventCount = ref(0)
const history = ref<TranscriptEntry[]>([])
const historyLoaded = ref(false)
const historyError = ref('')
const expandedIds = ref<string[]>([])

const draft = ref('')
const sending = ref(false)
const sendError = ref('')

let handle: StreamHandle | null = null

/**
 * Loads the stored history for this conversation.
 *
 * A history failure must not blank out the screen — the live stream is the
 * primary purpose of this page — but it must not be invisible either: silently
 * swallowing it made "history is always empty" indistinguishable from "this
 * conversation has no turns", which is exactly the bug that hid here once.
 */
async function loadHistory() {
  if (!conversationId.value)
    return

  try {
    const payload = await fetchTranscripts(conversationId.value)

    history.value = payload.entries ?? []
    historyError.value = ''
  }
  catch (error) {
    history.value = []
    historyError.value
      = error instanceof Error ? error.message : '历史问答加载失败'
  }
  finally {
    historyLoaded.value = true
  }
}

function toggleEntry(id: string) {
  expandedIds.value = expandedIds.value.includes(id)
    ? expandedIds.value.filter(item => item !== id)
    : [...expandedIds.value, id]
}

/**
 * Reduces a stored question to what the user actually typed.
 *
 * The IDE sends its prompt wrapped in system scaffolding — `<additional_data>`
 * carrying editor context, and the real request inside `<user_query>`. Stored
 * verbatim that renders as a wall of instructions, and the question is buried
 * in the middle. When the tags are present the inner query is preferred; older
 * records without tags are shown as-is (trimmed of the scaffolding if any).
 */
function readableQuestion(raw: string): string {
  if (!raw)
    return ''

  const inner = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i)

  if (inner?.[1]?.trim()) {
    return inner[1].trim()
  }

  // No explicit query tag: drop known scaffolding blocks and keep the rest.
  const withoutBlocks = raw
    .replace(/<additional_data>[\s\S]*?<\/additional_data>/gi, '')
    .replace(/<\/?[a-z_]+>/gi, '')
    .trim()

  return withoutBlocks || raw.trim()
}

function formatClock(value: string): string {
  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime()))
    return value

  return parsed.toLocaleTimeString()
}

function applyEvent(event: Record<string, unknown>) {
  eventCount.value += 1

  const type = String(event.type ?? '')

  if (type === 'stream.ready') {
    status.value = 'live'
    statusLabel.value = '已连接，等待模型输出'
    return
  }

  if (type === 'session.started') {
    status.value = 'live'
    statusLabel.value = '模型开始回答'
    model.value = String(event.model ?? '')
    replyText.value = ''
    return
  }

  if (type === 'session.snapshot') {
    // Sent when this client connected mid-reply: the deltas that produced the
    // text so far were published before we were listening.
    model.value = String(event.model ?? '')
    replyText.value = String(event.text ?? '')
    status.value = 'live'
    statusLabel.value = '正在输出…'
    return
  }

  if (type === 'session.delta') {
    // Deltas carry only the new text, so the reply is assembled locally. A
    // legacy server that still sends the accumulated text wins when present,
    // which also repairs any delta lost in transit.
    const text = event.text

    replyText.value
      = typeof text === 'string' && text
        ? text
        : `${replyText.value}${String(event.delta ?? '')}`
    status.value = 'live'
    statusLabel.value = '正在输出…'
    return
  }

  if (type === 'session.completed') {
    status.value = 'done'
    statusLabel.value = '回答完成'
    // The finished turn is persisted by the gateway, so re-read history to show
    // it in the list instead of waiting for the next app launch.
    void loadHistory()
    return
  }

  if (type === 'session.failed') {
    status.value = 'failed'
    statusLabel.value = '回答失败'
    errorMessage.value = String(event.error ?? '未知错误')
    void loadHistory()
    return
  }

  if (type === 'session.overflow') {
    errorMessage.value = '网关订阅已满，请稍后重试'
  }
}

/**
 * Sends the draft to the gateway and streams the answer into the reply panel.
 *
 * The reply panel is shared with the live SSE stream on purpose: whether the
 * text arrives because the IDE asked something or because the user did, it is
 * the same conversation and it should read as one continuous transcript.
 */
async function send() {
  const text = draft.value.trim()

  if (!text || sending.value)
    return

  sending.value = true
  sendError.value = ''
  replyText.value = ''
  status.value = 'live'
  statusLabel.value = '正在提交问题…'

  try {
    await sendChatMessage({
      conversationId: conversationId.value,
      message: text,
      onDelta: (delta) => {
        replyText.value += delta
        statusLabel.value = '正在输出…'
      },
      onError: (message) => {
        sendError.value = message
        status.value = 'failed'
        statusLabel.value = '回答失败'
      },
      onStart: () => {
        statusLabel.value = '正在输出…'
      },
    })

    if (!sendError.value) {
      status.value = 'done'
      statusLabel.value = '回答完成'
      draft.value = ''
      // The turn was persisted by the gateway, so pull the history back rather
      // than waiting for the next launch to show it.
      void loadHistory()
    }
  }
  finally {
    sending.value = false
  }
}

/**
 * Last transport step reached, rendered on the page.
 *
 * `adb` cannot read the App sandbox on a production build and `console.log` does
 * not reach logcat here, so the page itself is the only place these facts can be
 * observed. It is removed once streaming works.
 */
const streamDebug = ref('')

function connect() {
  streamDebug.value = `id=${conversationId.value ? 'ok' : 'empty'}`

  if (!conversationId.value)
    return

  try {
    handle?.close()
    streamDebug.value = 'closed'
  }
  catch (error) {
    streamDebug.value = `close 失败：${String(error)}`
    return
  }

  // Wrapped because an exception thrown synchronously here is swallowed by the
  // navigation lifecycle: the page simply stays on "等待活动" with no error and
  // no request, which is indistinguishable from a hang.
  try {
    handle = openSessionStream({
      conversationId: conversationId.value,
      onError: (message) => {
        errorMessage.value = message
        status.value = 'failed'
        statusLabel.value = '连接失败'
        streamDebug.value = `已上报：${message}`
      },
      onEvent: applyEvent,
    })
    streamDebug.value = `handle=${handle ? 'ok' : 'null'}`
  }
  catch (error) {
    status.value = 'failed'
    statusLabel.value = '连接失败'
    errorMessage.value = `实时连接初始化失败：${String(error)}`
    streamDebug.value = `抛出：${String(error)}`
  }
}

function disconnect() {
  handle?.close()
  handle = null
}

function copyReply() {
  if (!replyText.value)
    return

  uni.setClipboardData({
    data: replyText.value,
    success: () => uni.showToast({ icon: 'none', title: '已复制' }),
  })
}

onLoad((query) => {
  const id = String((query as Record<string, string>)?.conversationId ?? '')

  conversationId.value = decodeURIComponent(id)
  connect()
  void loadHistory()
})

onUnload(() => {
  disconnect()
})
</script>

<template>
  <view class="page">
    <view class="panel">
      <view class="row">
        <text class="label">会话</text>
        <text class="value">{{ conversationId || '-' }}</text>
      </view>
      <view class="row">
        <text class="label">状态</text>
        <text class="status" :class="[`status-${status}`]">{{ statusLabel }}</text>
      </view>
      <view v-if="model" class="row">
        <text class="label">模型</text>
        <text class="value">{{ model }}</text>
      </view>
      <view class="row">
        <text class="label">事件</text>
        <text class="value">{{ eventCount }}</text>
      </view>
    </view>

    <view v-if="errorMessage" class="error">
      {{ errorMessage }}
    </view>

    <view class="reply">
      <view class="reply-head">
        <text class="reply-title">实时回复</text>
        <text class="reply-action" @tap="copyReply">复制</text>
      </view>
      <text v-if="streamDebug" class="reply-debug">{{ streamDebug }}</text>
      <text v-if="!replyText" class="reply-empty">
        该会话当前没有正在进行的输出。在 IDE 里发起请求后会实时出现在这里。
      </text>
      <text v-else class="reply-text">{{ replyText }}</text>
    </view>

    <view class="compose">
      <text class="reply-title">继续提问</text>
      <text class="compose-hint">
        回答会直接发往网关，与 IDE 使用同一个会话。
      </text>
      <textarea
        v-model="draft"
        class="compose-input"
        :disabled="sending"
        placeholder="输入问题…"
      />
      <view class="compose-actions">
        <text v-if="sending" class="compose-status">正在回答…</text>
        <text v-else-if="sendError" class="compose-error">{{ sendError }}</text>
        <text v-else class="compose-status" />
        <button
          class="compose-send"
          :disabled="sending || !draft.trim()"
          @tap="send"
        >
          {{ sending ? '发送中' : '发送' }}
        </button>
      </view>
    </view>

    <view class="history">
      <view class="history-head">
        <text class="reply-title">历史问答</text>
        <text class="history-count">{{ history.length }} 条</text>
      </view>

      <text v-if="historyError" class="history-error">
        {{ historyError }}
      </text>

      <text v-else-if="historyLoaded && !history.length" class="history-empty">
        还没有记录。网关会保存每次问答，可在设置里调整保留天数与条数。
      </text>

      <view
        v-for="entry in history"
        :key="entry.id"
        class="entry"
        @tap="toggleEntry(entry.id)"
      >
        <view class="entry-head">
          <text class="entry-time">{{ formatClock(entry.completedAt) }}</text>
          <text
            class="entry-status"
            :class="[`entry-status-${entry.status}`]"
          >
            {{ entry.status === 'failed' ? '失败' : '完成' }}
          </text>
        </view>
        <text class="entry-question">{{ readableQuestion(entry.question) || '(无提问文本)' }}</text>
        <text
          v-if="expandedIds.includes(entry.id)"
          class="entry-answer"
        >
          {{ entry.answer || '(无回答内容)' }}
        </text>
        <text v-else class="entry-preview">
          {{ (entry.answer || '(无回答内容)').slice(0, 80) }}{{ entry.answerChars > 80 ? '…' : '' }}
        </text>
        <text v-if="entry.error" class="entry-error">{{ entry.error }}</text>
      </view>
    </view>

    <view class="tip">
      提示：本页用于查看实时输出与历史记录；在下方提问会直接调用网关，
      不经过 IDE 界面。
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background-color: #f5f6f8;
  padding: 24rpx;
  box-sizing: border-box;
}

.panel {
  padding: 8rpx 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f0f1f3;
}

.row:last-child {
  border-bottom: none;
}

.label {
  font-size: 26rpx;
  color: #8a8f99;
}

.value {
  flex: 1;
  margin-left: 24rpx;
  text-align: right;
  font-size: 26rpx;
  color: #1f2329;
  word-break: break-all;
}

.status {
  font-size: 26rpx;
  font-weight: 600;
}

.status-idle {
  color: #8a8f99;
}

.status-live {
  color: #0a84ff;
}

.status-done {
  color: #22a06b;
}

.status-failed {
  color: #cf1322;
}

.error {
  margin-top: 20rpx;
  padding: 20rpx;
  border-radius: 16rpx;
  background-color: #fff1f0;
  color: #cf1322;
  font-size: 26rpx;
}

.reply {
  margin-top: 20rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.reply-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.reply-debug {
  display: block;
  margin-top: 8rpx;
  font-size: 22rpx;
  color: #cf1322;
  word-break: break-all;
}

.reply-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
}

.reply-action {
  font-size: 26rpx;
  color: #0a84ff;
}

.reply-empty {
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.7;
}

.reply-text {
  font-size: 28rpx;
  color: #1f2329;
  line-height: 1.7;
  white-space: pre-wrap;
}

.tip {
  margin-top: 24rpx;
  font-size: 22rpx;
  color: #a8adb5;
  text-align: center;
}

.compose {
  margin-top: 20rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.compose-hint {
  display: block;
  margin-top: 6rpx;
  font-size: 22rpx;
  color: #8a8f99;
  line-height: 1.6;
}

.compose-input {
  width: 100%;
  height: 140rpx;
  margin-top: 16rpx;
  padding: 18rpx;
  box-sizing: border-box;
  border-radius: 14rpx;
  background-color: #f5f6f8;
  font-size: 26rpx;
  color: #1f2329;
}

.compose-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16rpx;
}

.compose-status {
  flex: 1;
  font-size: 22rpx;
  color: #8a8f99;
}

.compose-error {
  flex: 1;
  font-size: 22rpx;
  color: #cf1322;
}

.compose-send {
  margin: 0;
  padding: 0 40rpx;
  height: 68rpx;
  line-height: 68rpx;
  border-radius: 34rpx;
  background-color: #0a84ff;
  color: #ffffff;
  font-size: 26rpx;
}

.compose-send[disabled] {
  background-color: #c8cdd6;
  color: #ffffff;
}

.history {
  margin-top: 20rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.history-count {
  font-size: 24rpx;
  color: #8a8f99;
}

.history-empty {
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.7;
}

.history-error {
  font-size: 24rpx;
  color: #cf1322;
  line-height: 1.7;
}

.entry {
  padding: 20rpx 0;
  border-top: 1rpx solid #f0f1f3;
}

.entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.entry-time {
  font-size: 22rpx;
  color: #a8adb5;
}

.entry-status {
  font-size: 22rpx;
}

.entry-status-completed {
  color: #22a06b;
}

.entry-status-failed {
  color: #cf1322;
}

.entry-question {
  display: block;
  margin-top: 10rpx;
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  line-height: 1.6;
}

.entry-preview {
  display: block;
  margin-top: 8rpx;
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.7;
}

.entry-answer {
  display: block;
  margin-top: 8rpx;
  font-size: 26rpx;
  color: #4a4f57;
  line-height: 1.7;
  white-space: pre-wrap;
}

.entry-error {
  display: block;
  margin-top: 8rpx;
  font-size: 24rpx;
  color: #cf1322;
}
</style>
