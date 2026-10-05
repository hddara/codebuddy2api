<script setup lang="ts">
import type { TranscriptEntry } from '@/api/sessions'
import { onLoad, onShow } from '@dcloudio/uni-app'

import { ref } from 'vue'
import { fetchTranscripts } from '@/api/sessions'
import { toSnippet } from '@/utils/markdown'

definePage({
  name: 'session-detail',
  style: { navigationBarTitleText: '会话详情' },
})

/**
 * Conversation overview only.
 *
 * This page used to render the live reply *and* every stored turn inline, which
 * made it a long mixed feed where neither the newest output nor a specific past
 * answer was easy to reach. It is now an index: one entry per destination, each
 * showing just enough to decide whether to open it.
 */
const conversationId = ref('')
const entries = ref<TranscriptEntry[]>([])
const loading = ref(true)
const errorMessage = ref('')
const totalStored = ref(0)

const PREVIEW_LIMIT = 40

async function load() {
  if (!conversationId.value) {
    loading.value = false
    return
  }

  try {
    const payload = await fetchTranscripts(conversationId.value, PREVIEW_LIMIT)

    entries.value = payload.entries ?? []
    totalStored.value = payload.totals?.stored ?? entries.value.length
    errorMessage.value = ''
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '加载记录失败'

    errorMessage.value = /session required|401|unauthor/i.test(message)
      ? '控制台凭据已失效，请到「设置」重新填入新的 Cookie'
      : message
  }
  finally {
    loading.value = false
  }
}

function openLive() {
  uni.navigateTo({
    url: `/pages/sessions/live?conversationId=${encodeURIComponent(conversationId.value)}`,
  })
}

function openTranscript(entry: TranscriptEntry) {
  uni.navigateTo({
    url: `/pages/sessions/transcript?conversationId=${encodeURIComponent(conversationId.value)}`
      + `&entryId=${encodeURIComponent(entry.id)}`,
  })
}

function formatClock(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return value

  const minutes = Math.round((Date.now() - parsed.getTime()) / 60_000)

  if (minutes < 1)
    return '刚刚'
  if (minutes < 60)
    return `${minutes} 分钟前`
  if (minutes < 1_440)
    return `${Math.round(minutes / 60)} 小时前`

  return parsed.toLocaleDateString()
}

onLoad((query) => {
  conversationId.value = decodeURIComponent(
    String((query as Record<string, string>)?.conversationId ?? ''),
  )
})

// Refreshed on every show so returning from a question shows the new turn.
onShow(() => {
  void load()
})
</script>

<template>
  <view class="page">
    <view class="head">
      <text class="head-id">{{ conversationId.slice(0, 20) }}…</text>
      <text class="head-caption">会话标识</text>
    </view>

    <view v-if="errorMessage" class="error">
      {{ errorMessage }}
    </view>

    <!-- Entry 1: live output, kept separate from stored history because it is
         transient and is the thing you want while waiting on an answer. -->
    <view class="entry entry-primary" @tap="openLive">
      <view class="entry-body">
        <text class="entry-title">实时回复</text>
        <text class="entry-sub">
          查看正在输出的内容，或直接向这个会话提问
        </text>
      </view>
      <text class="entry-arrow">›</text>
    </view>

    <!-- Entry 2: stored turns, one row each, preview only. -->
    <view class="section-head">
      <text class="section-title">历史问答</text>
      <text class="section-count">
        {{ totalStored ? `共 ${totalStored} 条` : '' }}
      </text>
    </view>

    <view v-if="loading" class="hint">
      加载中…
    </view>

    <view v-else-if="!entries.length" class="hint">
      还没有记录。网关会保存每次问答，可在设置里调整保留天数与条数。
    </view>

    <view v-else class="list">
      <view
        v-for="entry in entries"
        :key="entry.id"
        class="entry"
        @tap="openTranscript(entry)"
      >
        <view class="entry-body">
          <text class="entry-question">
            {{ toSnippet(entry.question, 80) || '(无提问文本)' }}
          </text>
          <view class="entry-meta">
            <text class="entry-time">{{ formatClock(entry.completedAt) }}</text>
            <text
              class="entry-status"
              :class="[`status-${entry.status}`]"
            >
              {{ entry.status === 'failed' ? '失败' : '完成' }}
            </text>
          </view>
        </view>
        <text class="entry-arrow">›</text>
      </view>
    </view>

    <view v-if="entries.length && totalStored > entries.length" class="footnote">
      仅显示最近 {{ entries.length }} 条，共 {{ totalStored }} 条。
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20rpx 24rpx 60rpx;
  box-sizing: border-box;
  background-color: #f5f6f8;
}

.head {
  padding: 8rpx 4rpx 20rpx;
}

.head-id {
  display: block;
  font-size: 25rpx;
  color: #4a4f57;
  word-break: break-all;
}

.head-caption {
  display: block;
  margin-top: 4rpx;
  font-size: 22rpx;
  color: #a8adb5;
}

.error {
  margin-bottom: 16rpx;
  padding: 18rpx 20rpx;
  border-radius: 16rpx;
  background-color: #fff1f0;
  font-size: 25rpx;
  color: #cf1322;
  line-height: 1.6;
}

.entry {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-bottom: 16rpx;
  padding: 26rpx 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.entry-primary {
  background-color: #eef5ff;
}

.entry-body {
  flex: 1;
  min-width: 0;
}

.entry-title {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  color: #0a84ff;
}

.entry-sub {
  display: block;
  margin-top: 6rpx;
  font-size: 24rpx;
  color: #6b7280;
  line-height: 1.6;
}

.entry-question {
  /* Two lines max: the list is for scanning, the full text lives in the detail. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 28rpx;
  color: #1f2329;
  line-height: 1.6;
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: 14rpx;
  margin-top: 10rpx;
}

.entry-time {
  font-size: 23rpx;
  color: #a8adb5;
}

.entry-status {
  font-size: 23rpx;
}

.status-completed {
  color: #22a06b;
}

.status-failed {
  color: #cf1322;
}

.entry-arrow {
  flex: none;
  font-size: 40rpx;
  color: #c8ccd2;
  line-height: 1;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16rpx 4rpx 12rpx;
}

.section-title {
  font-size: 27rpx;
  font-weight: 600;
  color: #1f2329;
}

.section-count {
  font-size: 23rpx;
  color: #8a8f99;
}

.hint {
  padding: 36rpx 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.8;
}

.footnote {
  padding-top: 16rpx;
  font-size: 22rpx;
  color: #a8adb5;
  text-align: center;
}
</style>
