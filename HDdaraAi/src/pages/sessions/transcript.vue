<script setup lang="ts">
import type { TranscriptEntry } from '@/api/sessions'
import { onLoad } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { fetchTranscripts } from '@/api/sessions'
import { extractQuestion, renderMarkdown } from '@/utils/markdown'

definePage({
  name: 'session-transcript',
  style: { navigationBarTitleText: '问答详情' },
})

const entry = ref<TranscriptEntry | null>(null)
const loading = ref(true)
const errorMessage = ref('')

/**
 * Re-fetches the turn by id rather than receiving it through the URL.
 *
 * The answer can be tens of thousands of characters; a navigation parameter
 * that long is truncated by some runtimes, and the transcript list deliberately
 * fetches a bounded page anyway. Lookup by id keeps the handoff to a short
 * string and makes this page work on a cold deep link too.
 */
async function load(conversationId: string, entryId: string) {
  if (!conversationId) {
    errorMessage.value = '缺少会话标识'
    loading.value = false
    return
  }

  try {
    // The endpoint returns a bounded page per conversation; the target id is
    // matched locally because there is no per-entry route.
    const payload = await fetchTranscripts(conversationId, 200)
    const found = (payload.entries ?? []).find(item => item.id === entryId)

    if (!found) {
      errorMessage.value = '这条记录已不在保留范围内（可能已被裁剪）'
    }
    else {
      entry.value = found
    }
  }
  catch (error) {
    errorMessage.value
      = error instanceof Error ? error.message : '加载记录失败'
  }
  finally {
    loading.value = false
  }
}

const question = computed(() => extractQuestion(entry.value?.question ?? ''))
const answerHtml = computed(() =>
  entry.value?.answer ? renderMarkdown(entry.value.answer) : '',
)

function formatTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return value
  return parsed.toLocaleString()
}

function copyAnswer() {
  if (!entry.value?.answer)
    return
  uni.setClipboardData({
    data: entry.value.answer,
    success: () => uni.showToast({ icon: 'none', title: '已复制回答' }),
  })
}

onLoad((query) => {
  const params = query as Record<string, string>
  void load(
    decodeURIComponent(String(params?.conversationId ?? '')),
    decodeURIComponent(String(params?.entryId ?? '')),
  )
})
</script>

<template>
  <view class="page">
    <view v-if="loading" class="hint">
      加载中…
    </view>

    <view v-else-if="errorMessage" class="error">
      {{ errorMessage }}
    </view>

    <template v-else-if="entry">
      <view class="meta">
        <text class="meta-time">{{ formatTime(entry.completedAt) }}</text>
        <text class="meta-status" :class="[`status-${entry.status}`]">
          {{ entry.status === 'failed' ? '失败' : '完成' }}
        </text>
        <text v-if="entry.model" class="meta-model">{{ entry.model }}</text>
      </view>

      <view class="card">
        <view class="card-head">
          <text class="card-title">提问</text>
        </view>
        <text v-if="question" class="question">
          {{ question }}
        </text>
        <text v-else class="muted">
          （这条记录没有捕获到提问文本）
        </text>
      </view>

      <view class="card">
        <view class="card-head">
          <text class="card-title">回答</text>
          <text class="card-action" @tap="copyAnswer">复制</text>
        </view>

        <text v-if="entry.error" class="answer-error">{{ entry.error }}</text>

        <rich-text v-if="answerHtml" class="answer" :nodes="answerHtml" />
        <text v-else class="muted">
          （没有回答内容）
        </text>
      </view>

      <view class="footnote">
        回答共 {{ entry.answerChars }} 字，提问 {{ entry.questionChars }} 字。
      </view>
    </template>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20rpx 24rpx 60rpx;
  box-sizing: border-box;
  background-color: #f5f6f8;
}

.hint,
.muted {
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.8;
}

.hint {
  padding: 40rpx 0;
  text-align: center;
}

.error {
  padding: 20rpx;
  border-radius: 16rpx;
  background-color: #fff1f0;
  font-size: 26rpx;
  color: #cf1322;
  line-height: 1.7;
}

.meta {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 0 4rpx 16rpx;
}

.meta-time {
  font-size: 24rpx;
  color: #8a8f99;
}

.meta-status {
  font-size: 24rpx;
}

.status-completed {
  color: #22a06b;
}

.status-failed {
  color: #cf1322;
}

.meta-model {
  margin-left: auto;
  font-size: 23rpx;
  color: #a8adb5;
}

.card {
  margin-bottom: 20rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.card-title {
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2329;
}

.card-action {
  font-size: 24rpx;
  color: #0a84ff;
}

.question {
  display: block;
  font-size: 29rpx;
  font-weight: 500;
  color: #1f2329;
  line-height: 1.75;
  word-break: break-word;
}

.answer {
  display: block;
  font-size: 28rpx;
  line-height: 1.75;
  color: #1f2329;
  word-break: break-word;
}

.answer-error {
  display: block;
  margin-bottom: 12rpx;
  font-size: 25rpx;
  color: #cf1322;
}

.footnote {
  padding: 8rpx 4rpx;
  font-size: 22rpx;
  color: #a8adb5;
  text-align: center;
}
</style>
