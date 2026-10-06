<script setup lang="ts">
import type { TranscriptEntry } from '@/api/sessions'
import { onLoad, onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { fetchTranscripts } from '@/api/sessions'
import StateBlock from '@/components/StateBlock.vue'
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

/**
 * Shortened conversation id shown in the header.
 *
 * The full value is long and not useful to read, but it is what a person needs
 * when correlating the app with a gateway log, so it is copyable rather than
 * merely truncated.
 */
const shortId = computed(() =>
  conversationId.value ? `${conversationId.value.slice(0, 20)}…` : '',
)

function copyConversationId() {
  if (!conversationId.value)
    return

  uni.setClipboardData({
    data: conversationId.value,
    success: () => uni.showToast({ icon: 'none', title: '已复制会话标识' }),
  })
}

/** Reloads after a failure; previously the only way out was leaving the page. */
function retry() {
  loading.value = true
  void load()
}

async function load() {
  if (!conversationId.value) {
    errorMessage.value = '缺少会话标识'
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
      <view class="head-row">
        <text class="head-id">{{ shortId }}</text>
        <text class="head-copy" @tap="copyConversationId">复制</text>
      </view>
      <text class="head-caption">会话标识</text>
    </view>

    <StateBlock
      v-if="errorMessage"
      tone="danger"
      :text="errorMessage"
      retry-text="重试"
      @retry="retry"
    />

    <!-- Entry 1: live output, kept separate from stored history because it is
         transient and is the thing you want while waiting on an answer.

         A <button>, not a tappable <view>: on the App runtime a tap landing on a
         child <text> does not reliably reach a handler bound to the parent view,
         so these rows silently ignored presses. That is the same defect the
         login screen documents, and it is why "点不动" kept being reported. -->
    <button class="entry entry-primary" @tap="openLive">
      <view class="entry-body">
        <text class="entry-title">实时回复</text>
        <text class="entry-sub">
          查看正在输出的内容，或直接向这个会话提问
        </text>
      </view>
      <text class="entry-arrow">›</text>
    </button>

    <!-- Entry 2: stored turns, one row each, preview only. -->
    <view class="section-head">
      <text class="section-title">历史问答</text>
      <text class="section-count">
        {{ totalStored ? `共 ${totalStored} 条` : '' }}
      </text>
    </view>

    <StateBlock v-if="loading" :loading="true" text="加载中…" />

    <StateBlock
      v-else-if="!entries.length"
      text="还没有记录"
      hint="网关会保存每次问答，可在设置里调整保留天数与条数。"
    />

    <view v-else class="list">
      <button
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
      </button>
    </view>

    <view v-if="entries.length && totalStored > entries.length" class="footnote">
      仅显示最近 {{ entries.length }} 条，共 {{ totalStored }} 条。
    </view>
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

.head {
  padding: 8rpx 4rpx 20rpx;
}

.head-row {
  display: flex;
  align-items: center;
  gap: $gap-inline;
}

.head-id {
  flex: 1;
  min-width: 0;
  font-size: $font-meta;
  color: $color-text-secondary;
  word-break: break-all;
}

.head-copy {
  flex: none;
  font-size: $font-meta;
  color: $color-primary;
}

.head-caption {
  display: block;
  margin-top: 4rpx;
  font-size: $font-micro;
  color: $color-text-faint;
}

/* Reset the platform button chrome so a row still reads as a list item:
   uni gives <button> its own background, border, radius and centring, and its
   ::after pseudo-element draws an extra hairline border. */
.entry {
  display: flex;
  align-items: center;
  gap: 16rpx;
  width: 100%;
  margin: 0 0 16rpx;
  padding: 26rpx 24rpx;
  border: none;
  border-radius: $radius-card;
  background-color: $color-surface;
  font-weight: normal;
  line-height: normal;
  text-align: left;
}

.entry::after {
  border: none;
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
  color: $color-primary;
}

.entry-sub {
  display: block;
  margin-top: 6rpx;
  font-size: $font-meta;
  color: #6b7280;
  line-height: 1.6;
}

.entry-question {
  /* Two lines max: the list is for scanning, the full text lives in the detail. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: $font-section;
  color: $color-text;
  line-height: 1.6;
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: 14rpx;
  margin-top: 10rpx;
}

.entry-time {
  font-size: $font-micro;
  color: $color-text-faint;
}

.entry-status {
  font-size: $font-micro;
}

.status-completed {
  color: $color-success;
}

.status-failed {
  color: $color-danger;
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
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
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
