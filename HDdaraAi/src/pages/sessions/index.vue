<script setup lang="ts">
import type { SessionRow } from '@/api/sessions'
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { fetchSessions } from '@/api/sessions'
import { useAuthStore } from '@/store/authStore'

definePage({
  name: 'sessions',
  style: { navigationBarTitleText: '会话' },
})

const auth = useAuthStore()
const loading = ref(false)
const errorMessage = ref('')
const sessions = ref<SessionRow[]>([])
const totals = ref({ calls: 0, sessions: 0, totalTokens: 0 })
const ungroupedEvents = ref(0)
const windowMinutes = ref(24 * 60)

const windowOptions = [
  { label: '1 小时', value: 60 },
  { label: '6 小时', value: 6 * 60 },
  { label: '24 小时', value: 24 * 60 },
  { label: '7 天', value: 7 * 24 * 60 },
]

const windowLabel = computed(
  () =>
    windowOptions.find(option => option.value === windowMinutes.value)
      ?.label ?? '',
)

async function load() {
  if (!auth.hasCredentials) {
    errorMessage.value = '尚未登录，请先到「设置」填写控制台凭据'
    sessions.value = []
    return
  }

  loading.value = true
  errorMessage.value = ''

  try {
    const payload = await fetchSessions(windowMinutes.value)

    sessions.value = payload.sessions ?? []
    totals.value = payload.totals ?? {
      calls: 0,
      sessions: 0,
      totalTokens: 0,
    }
    ungroupedEvents.value = payload.ungroupedEvents ?? 0
  }
  catch (error) {
    errorMessage.value
      = error instanceof Error ? error.message : '加载会话失败'
    sessions.value = []
  }
  finally {
    loading.value = false
  }
}

async function changeWindow(value: number) {
  windowMinutes.value = value
  await load()
}

function formatRelative(value: string): string {
  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime()))
    return value

  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000)

  if (seconds < 60)
    return `${seconds} 秒前`
  if (seconds < 3600)
    return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86_400)
    return `${Math.round(seconds / 3600)} 小时前`

  return `${Math.round(seconds / 86_400)} 天前`
}

function openDetail(item: SessionRow) {
  uni.navigateTo({
    url: `/pages/sessions/detail?conversationId=${encodeURIComponent(item.conversationId)}`,
  })
}

onShow(() => {
  void load()
})

onPullDownRefresh(async () => {
  await load()
  uni.stopPullDownRefresh()
})
</script>

<template>
  <view class="page">
    <view class="toolbar">
      <scroll-view class="chips" scroll-x>
        <view
          v-for="option in windowOptions"
          :key="option.value"
          class="chip" :class="[option.value === windowMinutes ? 'chip-active' : '']"
          @tap="changeWindow(option.value)"
        >
          {{ option.label }}
        </view>
      </scroll-view>
    </view>

    <view class="summary">
      <text class="summary-main">
        {{ totals.sessions }} 个会话 / {{ totals.calls }} 次请求
      </text>
      <text v-if="ungroupedEvents > 0" class="summary-sub">
        另有 {{ ungroupedEvents }} 条请求未带 conversation-id
      </text>
    </view>

    <view v-if="errorMessage" class="error">
      {{ errorMessage }}
    </view>

    <view v-if="loading" class="hint">
      加载中…
    </view>

    <view v-else-if="!sessions.length" class="hint">
      该时间范围内没有会话
    </view>

    <view v-else class="list">
      <view
        v-for="item in sessions"
        :key="item.conversationId"
        class="card"
        @tap="openDetail(item)"
      >
        <view class="card-head">
          <text class="card-id">{{ item.conversationId.slice(0, 12) }}…</text>
          <text class="card-time">{{ formatRelative(item.lastActiveAt) }}</text>
        </view>
        <view class="card-meta">
          <text>{{ item.models.join(', ') || '-' }}</text>
        </view>
        <view class="card-stats">
          <text>{{ item.callCount }} 次请求</text>
          <text>{{ item.totalTokens }} tokens</text>
        </view>
      </view>
    </view>

    <view class="footer-hint">
      当前范围：{{ windowLabel }}
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

.toolbar {
  margin-bottom: 16rpx;
}

.chips {
  white-space: nowrap;
}

.chip {
  display: inline-block;
  padding: 12rpx 28rpx;
  margin-right: 16rpx;
  border-radius: 999rpx;
  background-color: #ffffff;
  color: #4a4f57;
  font-size: 26rpx;
}

.chip-active {
  background-color: #0a84ff;
  color: #ffffff;
}

.summary {
  display: flex;
  flex-direction: column;
  padding: 8rpx 4rpx 20rpx;
}

.summary-main {
  font-size: 26rpx;
  color: #4a4f57;
}

.summary-sub {
  margin-top: 6rpx;
  font-size: 24rpx;
  color: #8a8f99;
}

.error {
  margin-bottom: 16rpx;
  padding: 20rpx;
  border-radius: 16rpx;
  background-color: #fff1f0;
  color: #cf1322;
  font-size: 26rpx;
}

.hint {
  padding: 60rpx 0;
  text-align: center;
  color: #8a8f99;
  font-size: 26rpx;
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
}

.card-id {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
}

.card-time {
  font-size: 24rpx;
  color: #8a8f99;
}

.card-meta {
  margin-top: 10rpx;
  font-size: 24rpx;
  color: #4a4f57;
}

.card-stats {
  margin-top: 14rpx;
  display: flex;
  gap: 32rpx;
  font-size: 24rpx;
  color: #8a8f99;
}

.footer-hint {
  padding: 20rpx 0 40rpx;
  text-align: center;
  font-size: 22rpx;
  color: #a8adb5;
}
</style>
