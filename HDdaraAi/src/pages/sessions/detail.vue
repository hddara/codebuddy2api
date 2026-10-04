<script setup lang="ts">
import type { StreamHandle, TranscriptEntry } from '@/api/sessions'
import { onLoad, onUnload } from '@dcloudio/uni-app'

import { ref } from 'vue'
import { fetchTranscripts, openSessionStream } from '@/api/sessions'

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
const expandedIds = ref<string[]>([])

let handle: StreamHandle | null = null

/**
 * Loads the stored history for this conversation.
 *
 * Failures are swallowed on purpose: the live stream is the primary purpose of
 * this page, so a history problem must not blank out the screen.
 */
async function loadHistory() {
  if (!conversationId.value)
    return

  try {
    const payload = await fetchTranscripts(conversationId.value)

    history.value = payload.entries ?? []
  }
  catch {
    history.value = []
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

function connect() {
  if (!conversationId.value)
    return

  handle?.close()
  handle = openSessionStream({
    conversationId: conversationId.value,
    onError: (message) => {
      errorMessage.value = message
      status.value = 'failed'
      statusLabel.value = '连接失败'
    },
    onEvent: applyEvent,
  })
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
      <text v-if="!replyText" class="reply-empty">
        该会话当前没有正在进行的输出。在 IDE 里发起请求后会实时出现在这里。
      </text>
      <text v-else class="reply-text">{{ replyText }}</text>
    </view>

    <view class="history">
      <view class="history-head">
        <text class="reply-title">历史问答</text>
        <text class="history-count">{{ history.length }} 条</text>
      </view>

      <text v-if="historyLoaded && !history.length" class="history-empty">
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
        <text class="entry-question">{{ entry.question || '(无提问文本)' }}</text>
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
      提示：本页只做实时观察，不会修改 IDE 中的对话内容。
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
