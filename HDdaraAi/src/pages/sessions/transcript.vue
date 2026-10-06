<script setup lang="ts">
import type { TranscriptEntry } from '@/api/sessions'
import { onLoad } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { fetchTranscripts } from '@/api/sessions'
import StateBlock from '@/components/StateBlock.vue'
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

const conversationId = ref('')

const question = computed(() => extractQuestion(entry.value?.question ?? ''))
/**
 * The question is rendered as Markdown too.
 *
 * It used to be a plain `<text>`, so a question containing a code snippet or a
 * list looked different from the same content in the answer below it. Both sides
 * of a Q&A go through the same renderer now.
 */
const questionHtml = computed(() => {
  const text = question.value

  return text ? renderMarkdown(text, { codeMaxHeight: 320 }) : ''
})

const answerHtml = computed(() =>
  entry.value?.answer ? renderMarkdown(entry.value.answer) : '',
)

/**
 * Whether the answer itself failed.
 *
 * Shown *instead of* the answer, not above it: the error was previously rendered
 * alongside `answerHtml`, so a failed turn displayed both the failure and
 * whatever partial content had been captured, with no way to tell which was
 * authoritative.
 */
const answerFailed = computed(
  () => entry.value?.status === 'failed' || Boolean(entry.value?.error),
)

/** Opens the live page on this conversation, so a follow-up can be asked. */
function continueInSession() {
  if (!conversationId.value)
    return

  uni.navigateTo({
    url: `/pages/sessions/live?conversationId=${encodeURIComponent(conversationId.value)}`,
  })
}

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

  conversationId.value = decodeURIComponent(String(params?.conversationId ?? ''))
  void load(
    conversationId.value,
    decodeURIComponent(String(params?.entryId ?? '')),
  )
})
</script>

<template>
  <view class="page">
    <StateBlock v-if="loading" :loading="true" text="加载中…" />

    <StateBlock
      v-else-if="errorMessage"
      tone="danger"
      :text="errorMessage"
      hint="记录可能已被裁剪，或该会话不再保留这么久的问答。"
    />

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
        <rich-text v-if="questionHtml" class="rich" :nodes="questionHtml" />
        <text v-else class="muted">
          （这条记录没有捕获到提问文本）
        </text>
      </view>

      <view class="card">
        <view class="card-head">
          <text class="card-title">回答</text>
          <text v-if="entry.answer" class="card-action" @tap="copyAnswer">复制</text>
        </view>

        <!-- Failure and content are mutually exclusive: showing both left the
             reader unable to tell whether the partial text was the answer. -->
        <StateBlock
          v-if="answerFailed"
          variant="plain"
          tone="danger"
          text="这一轮回答失败"
          :hint="entry.error || '网关没有返回内容'"
        />

        <rich-text v-else-if="answerHtml" class="rich" :nodes="answerHtml" />
        <text v-else class="muted">
          （没有回答内容）
        </text>
      </view>

      <view class="footnote">
        回答共 {{ entry.answerChars }} 字，提问 {{ entry.questionChars }} 字。
      </view>

      <!-- Ask a follow-up on the same conversation without going back through
           the list to find the live page. -->
      <button class="primary" @tap="continueInSession">
        在这个会话里继续提问
      </button>
    </template>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: 20rpx $gap-page 60rpx;
  box-sizing: border-box;
  background-color: $color-page;
}

.muted {
  font-size: $font-label;
  color: $color-text-muted;
  line-height: 1.8;
}

.meta {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 0 4rpx 16rpx;
}

.meta-time {
  font-size: $font-meta;
  color: $color-text-muted;
}

.meta-status {
  font-size: $font-meta;
}

.status-completed {
  color: $color-success;
}

.status-failed {
  color: $color-danger;
}

.meta-model {
  margin-left: auto;
  font-size: $font-micro;
  color: $color-text-faint;
}

.card {
  margin-bottom: $gap-section;
  padding: 24rpx;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.card-title {
  font-size: $font-label;
  font-weight: 600;
  color: $color-text;
}

.card-action {
  font-size: $font-meta;
  color: $color-primary;
}

/* One class for both question and answer now that both are rendered HTML. */
.rich {
  display: block;
  font-size: $font-section;
  line-height: 1.75;
  color: $color-text;
  word-break: break-word;
}

.footnote {
  padding: 8rpx 4rpx 20rpx;
  font-size: $font-micro;
  color: $color-text-faint;
  text-align: center;
}

.primary {
  height: 88rpx;
  line-height: 88rpx;
  border-radius: $radius-control;
  background-color: $color-primary;
  color: #ffffff;
  font-size: $font-section;
}
</style>
