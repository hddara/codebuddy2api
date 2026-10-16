<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { consoleErrorMessage } from '@/api/core/console'
import {
  fetchUsageStats,
  maxUsageCount,
  toUsageRows,
  usageShare,
} from '@/api/stats'
import StateBlock from '@/components/StateBlock.vue'
import { useNativeChrome } from '@/composables/useNativeChrome'
import { ensureUnlocked } from '@/utils/app-guard'

definePage({
  name: 'account-stats',
  style: { navigationBarTitleText: '调用统计' },
})

/**
 * Call counts the gateway itself recorded, over the last seven days.
 *
 * The companion screen (`账户数据`) asks each upstream account how much
 * allowance is left; this one counts what the gateway served. Neither answers
 * the other's question — "3 calls left" and "this account has served 400 of the
 * 500 calls this week" are different facts, and only the second explains why a
 * limit was hit.
 */

// Repaints this page's native title bar; it is per-webview and would
// otherwise revert to the light default on each navigation.
useNativeChrome()
const credentialRows = ref<Array<{ count: number, label: string }>>([])
const modelRows = ref<Array<{ count: number, label: string }>>([])
const loading = ref(true)
const errorMessage = ref('')

const totalCalls = computed(() =>
  modelRows.value.reduce((sum, row) => sum + row.count, 0))

const credentialMax = computed(() => maxUsageCount(credentialRows.value))
const modelMax = computed(() => maxUsageCount(modelRows.value))

async function load() {
  loading.value = true
  errorMessage.value = ''

  try {
    const payload = await fetchUsageStats()

    credentialRows.value = toUsageRows(payload.credential_usage)
    modelRows.value = toUsageRows(payload.model_usage)
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取调用统计失败')
  }
  finally {
    loading.value = false
  }
}

onShow(() => {
  if (!ensureUnlocked())
    return

  void load()
})
</script>

<template>
  <view class="page" :class="themeClass">
    <StateBlock v-if="loading" :loading="true" text="统计中…" />

    <StateBlock
      v-else-if="errorMessage"
      tone="danger"
      icon="i-carbon:warning-alt"
      :text="errorMessage"
      retry-text="重试"
      @retry="load"
    />

    <template v-else>
      <view class="summary">
        <text class="summary-value">{{ totalCalls }}</text>
        <text class="summary-label">最近 7 天总调用</text>
      </view>

      <StateBlock
        v-if="!credentialRows.length && !modelRows.length"
        icon="i-carbon:chart-line-data"
        text="最近 7 天还没有调用"
        hint="在 IDE 里发起一次请求后，这里会按账号和模型统计。"
      />

      <template v-else>
        <view class="section">
          <text class="section-title">按账号</text>
          <text class="section-hint">
            哪个上游账号承接了多少请求。某个账号占比过高，通常就是它先被限流。
          </text>

          <StateBlock
            v-if="!credentialRows.length"
            variant="plain"
            text="没有账号调用记录"
          />
          <view v-else class="rows">
            <view v-for="row in credentialRows" :key="row.label" class="row">
              <view class="row-head">
                <text class="row-label">{{ row.label }}</text>
                <text class="row-count">{{ row.count }}</text>
              </view>
              <view class="bar">
                <view
                  class="bar-fill"
                  :style="{ width: `${usageShare(row.count, credentialMax)}%` }"
                />
              </view>
            </view>
          </view>
        </view>

        <view class="section">
          <text class="section-title">按模型</text>
          <text class="section-hint">
            各模型被调用的次数，用来判断额度主要花在哪里。
          </text>

          <StateBlock
            v-if="!modelRows.length"
            variant="plain"
            text="没有模型调用记录"
          />
          <view v-else class="rows">
            <view v-for="row in modelRows" :key="row.label" class="row">
              <view class="row-head">
                <text class="row-label">{{ row.label }}</text>
                <text class="row-count">{{ row.count }}</text>
              </view>
              <view class="bar">
                <view
                  class="bar-fill"
                  :style="{ width: `${usageShare(row.count, modelMax)}%` }"
                />
              </view>
            </view>
          </view>
        </view>
      </template>
    </template>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: $gap-page;
  /* Sub-page: nothing is drawn over the webview, but the home indicator still
     sits on top of the final card on notched devices. */
  padding-bottom: $gap-page-bottom;
  box-sizing: border-box;
  background-color: $color-page;
}

/* The one number the page exists for, given its own surface so it reads as a
   headline rather than as the first row of a table. */
.summary {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: $gap-page;
  padding: 40rpx $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.summary-value {
  font-size: 72rpx;
  font-weight: 600;
  line-height: 1.1;
  color: $color-text;
}

.summary-label {
  margin-top: 8rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

.section {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.section-title {
  display: block;
  font-size: $font-label;
  font-weight: 600;
  color: $color-text;
}

.section-hint {
  display: block;
  margin-top: 8rpx;
  margin-bottom: $gap-section;
  font-size: $font-micro;
  line-height: 1.6;
  color: $color-text-muted;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: $gap-section;
}

.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: $gap-inline;
}

.row-label {
  flex: 1;
  min-width: 0;
  font-size: $font-meta;
  color: $color-text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-count {
  flex: none;
  font-size: $font-meta;
  font-weight: 600;
  color: $color-text;
}

.bar {
  height: 10rpx;
  margin-top: 10rpx;
  border-radius: $radius-pill;
  background-color: $color-surface-sunken;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: $radius-pill;
  background-color: $color-primary;
}
</style>
