<script setup lang="ts">
import type { AccountStatusSnapshot } from '@/api/account-status'
import { onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { claimCheckin, creditPercentage, fetchAccountStatus, formatCredits } from '@/api/account-status'
import { consoleErrorMessage } from '@/api/core/console'
import { useNativeChrome } from '@/composables/useNativeChrome'
import { ensureUnlocked } from '@/utils/app-guard'
import { formatDateTime } from '@/utils/format'

definePage({
  name: 'account-usage',
  style: { navigationBarTitleText: '账户数据' },
})

// Repaints this page's native title bar; it is per-webview and would
// otherwise revert to the light default on each navigation.
useNativeChrome()
const statuses = ref<AccountStatusSnapshot[]>([])
const loading = ref(true)
const refreshing = ref(false)
const errorMessage = ref('')
const notice = ref('')
/** Filename currently being claimed, so only that row shows progress. */
const claiming = ref('')

/**
 * Accounts that answered, and those that did not.
 *
 * Split because they need different treatment: an account that reported nothing
 * is not an empty account, and listing it under a "0 credits" heading would
 * state something the gateway never said.
 */
const answered = computed(() => statuses.value.filter(item => !item.error))
const failed = computed(() => statuses.value.filter(item => Boolean(item.error)))

const totalRemaining = computed(() =>
  answered.value.reduce((sum, item) => sum + (item.credits.remaining ?? 0), 0),
)

const totalCapacity = computed(() =>
  answered.value.reduce((sum, item) => sum + (item.credits.total ?? 0), 0),
)

const overallPercentage = computed(() => {
  if (totalCapacity.value <= 0) {
    return null
  }

  return Math.min(100, Math.max(0, Math.round((totalRemaining.value / totalCapacity.value) * 100)))
})

const claimableCount = computed(
  () => answered.value.filter(item => item.checkin.claimed === false).length,
)

async function load(options: { silent?: boolean } = {}) {
  if (options.silent) {
    refreshing.value = true
  }
  else {
    loading.value = true
  }

  errorMessage.value = ''

  try {
    const payload = await fetchAccountStatus()

    statuses.value = payload.statuses
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取账户数据失败')
  }
  finally {
    loading.value = false
    refreshing.value = false
  }
}

async function checkin(target?: AccountStatusSnapshot) {
  if (claiming.value) {
    return
  }

  claiming.value = target?.filename ?? '*'
  notice.value = ''
  errorMessage.value = ''

  try {
    const payload = await claimCheckin(target?.filename)
    const next = payload.statuses

    // The single-account branch answers with `status` instead of `statuses`, so
    // a targeted claim replaces just that account and leaves the rest of the
    // page — and the scroll position — alone.
    if (target && next.length === 0) {
      notice.value = '已提交签到'
      await load({ silent: true })

      return
    }

    statuses.value = next.length ? next : statuses.value
    notice.value = target ? `已为 ${target.filename} 提交签到` : '已为全部账户提交签到'
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '签到失败')
  }
  finally {
    claiming.value = ''
  }
}

/** A plan may span several packages, so the label is the joined names. */
function planLabel(item: AccountStatusSnapshot): string {
  return item.credits.plan || '未知套餐'
}

function packageMeta(pkg: AccountStatusSnapshot['credits']['packages'][number]): string {
  const parts: string[] = []

  if (pkg.cycleEndTime) {
    parts.push(`至 ${formatDateTime(pkg.cycleEndTime)}`)
  }

  // `3` is the upstream's expired marker; the totals exclude those rows, and a
  // reader has to be able to see why their sum disagrees with the list.
  if (pkg.status === 3) {
    parts.push('已过期')
  }

  return parts.join(' · ')
}

function checkinLabel(item: AccountStatusSnapshot): string {
  if (item.checkin.claimed === true) {
    return '今日已签到'
  }

  if (item.checkin.claimed === false) {
    return '今日可签到'
  }

  return '签到状态未知'
}

onShow(() => {
  if (!ensureUnlocked()) {
    return
  }

  void load()
})
</script>

<template>
  <view class="page" :class="themeClass">
    <StateBlock
      v-if="errorMessage"
      tone="danger"
      icon="i-carbon:warning-alt"
      :text="errorMessage"
      retry-text="重试"
      @retry="load"
    />

    <AppSkeleton v-else-if="loading" :rows="4" />

    <template v-else>
      <view v-if="answered.length" class="summary">
        <text class="summary-label">剩余额度合计</text>
        <view class="summary-figure">
          <text class="summary-value">{{ formatCredits(totalRemaining) }}</text>
          <text class="summary-total">/ {{ formatCredits(totalCapacity) }}</text>
        </view>
        <view v-if="overallPercentage !== null" class="bar">
          <view class="bar-fill" :style="{ width: `${overallPercentage}%` }" />
        </view>
        <text class="summary-meta">
          {{ answered.length }} 个账户
          <template v-if="claimableCount"> · {{ claimableCount }} 个可签到</template>
        </text>
      </view>

      <view v-if="claimableCount || answered.length" class="actions">
        <AppButton
          variant="solid"
          block
          :disabled="Boolean(claiming)"
          @tap="checkin()"
        >
          {{ claiming === '*' ? '签到中…' : '全部签到' }}
        </AppButton>
      </view>

      <view v-if="notice" class="notice">
        <view class="notice-icon i-carbon:checkmark" />
        <text>{{ notice }}</text>
      </view>

      <view
        v-for="item in answered"
        :key="item.filename"
        class="section"
      >
        <view class="section-head">
          <text class="section-title">{{ planLabel(item) }}</text>
          <StatusTag :tone="item.checkin.claimed === false ? 'warning' : 'success'">
            {{ checkinLabel(item) }}
          </StatusTag>
        </view>

        <text class="section-file">{{ item.filename }}</text>

        <view class="metrics">
          <view class="metric">
            <text class="metric-label">剩余</text>
            <text class="metric-value">{{ formatCredits(item.credits.remaining) }}</text>
          </view>
          <view class="metric">
            <text class="metric-label">已用</text>
            <text class="metric-value">{{ formatCredits(item.credits.used) }}</text>
          </view>
          <view class="metric">
            <text class="metric-label">总量</text>
            <text class="metric-value">{{ formatCredits(item.credits.total) }}</text>
          </view>
        </view>

        <view v-if="creditPercentage(item.credits) !== null" class="bar">
          <view
            class="bar-fill"
            :style="{ width: `${creditPercentage(item.credits)}%` }"
          />
        </view>

        <view v-if="item.credits.resetAt" class="line">
          <text class="line-label">额度重置</text>
          <text class="line-value">{{ formatDateTime(item.credits.resetAt) }}</text>
        </view>

        <view v-if="item.models.length" class="line">
          <text class="line-label">可用模型</text>
          <text class="line-value">{{ item.models.join('、') }}</text>
        </view>

        <view v-if="item.credits.packages.length" class="packages">
          <text class="packages-title">套餐明细（{{ item.credits.packages.length }}）</text>
          <view
            v-for="(pkg, index) in item.credits.packages"
            :key="`${item.filename}-${index}`"
            class="package"
          >
            <view class="package-head">
              <text class="package-name">{{ pkg.packageName || '未命名套餐' }}</text>
              <text class="package-remain">
                {{ formatCredits(pkg.capacityRemain) }} / {{ formatCredits(pkg.capacitySize) }}
              </text>
            </view>
            <text v-if="packageMeta(pkg)" class="package-meta">{{ packageMeta(pkg) }}</text>
          </view>
        </view>

        <AppButton
          variant="tonal"
          block
          :disabled="Boolean(claiming) || item.checkin.claimed === true"
          @tap="checkin(item)"
        >
          {{ claiming === item.filename ? '签到中…' : checkinLabel(item) }}
        </AppButton>

        <text class="stamp">更新于 {{ formatDateTime(item.queriedAt) }}</text>
      </view>

      <view v-if="failed.length" class="section">
        <text class="section-title">未能读取（{{ failed.length }}）</text>
        <text class="section-hint">
          这些账户没有返回数据，可能是凭据已过期或上游暂时不可用。
        </text>
        <view
          v-for="item in failed"
          :key="item.filename"
          class="failed-row"
        >
          <text class="failed-file">{{ item.filename }}</text>
          <text class="failed-reason">{{ item.error }}</text>
        </view>
      </view>

      <StateBlock
        v-if="!statuses.length"
        icon="i-carbon:data-table"
        text="还没有可统计的账户"
        hint="先在「凭证管理」里添加一个上游账号。"
      />
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

.summary {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.summary-label {
  display: block;
  font-size: $font-meta;
  color: $color-text-muted;
}

.summary-figure {
  display: flex;
  align-items: baseline;
  gap: 10rpx;
  margin-top: 8rpx;
}

.summary-value {
  font-size: 56rpx;
  font-weight: 600;
  color: $color-text;
}

.summary-total {
  font-size: $font-label;
  color: $color-text-muted;
}

.summary-meta {
  display: block;
  margin-top: 12rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

/* A single flat fill rather than a gradient: the value is the number above it,
   and the bar only has to be comparable between accounts. */
.bar {
  height: 12rpx;
  margin-top: 16rpx;
  border-radius: $radius-pill;
  background-color: $color-surface-sunken;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: $radius-pill;
  background-color: $color-primary;
}

.actions {
  margin-bottom: $gap-page;
}

.section {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.section-title {
  flex: 1;
  min-width: 0;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
}

.section-hint {
  display: block;
  margin-bottom: 16rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
}

.section-file {
  display: block;
  margin-top: 6rpx;
  font-size: $font-micro;
  color: $color-text-faint;
  word-break: break-all;
}

/* Three fixed columns: the figures are meant to be compared down the row, which
   a wrapping flex layout would not let the eye do. */
.metrics {
  display: flex;
  margin-top: 20rpx;
}

.metric {
  flex: 1;
  min-width: 0;
}

.metric-label {
  display: block;
  font-size: $font-micro;
  color: $color-text-muted;
}

.metric-value {
  display: block;
  margin-top: 4rpx;
  font-size: $font-body;
  font-weight: 600;
  color: $color-text;
}

.line {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: $gap-section;
  margin-top: 16rpx;
}

.line-label {
  flex: none;
  font-size: $font-meta;
  color: $color-text-muted;
}

.line-value {
  flex: 1;
  min-width: 0;
  font-size: $font-meta;
  color: $color-text;
  text-align: right;
}

.packages {
  margin-top: 20rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid $color-border-strong;
}

.packages-title {
  display: block;
  margin-bottom: 12rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

.package {
  padding: 12rpx 0;
}

.package-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.package-name {
  flex: 1;
  min-width: 0;
  font-size: $font-label;
  color: $color-text;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.package-remain {
  flex: none;
  font-size: $font-meta;
  color: $color-text-secondary;
}

.package-meta {
  display: block;
  margin-top: 4rpx;
  font-size: $font-micro;
  color: $color-text-faint;
}

.stamp {
  display: block;
  margin-top: 16rpx;
  font-size: $font-micro;
  color: $color-text-faint;
  text-align: center;
}

.notice {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-bottom: $gap-page;
  font-size: $font-meta;
  color: $color-success;
}

.notice-icon {
  flex: none;
  width: 28rpx;
  height: 28rpx;
}

.failed-row {
  padding: $gap-inline 0;
  border-bottom: 1rpx solid $color-border-strong;
}

.failed-row:last-child {
  border-bottom: none;
}

.failed-file {
  display: block;
  font-size: $font-label;
  color: $color-text;
  word-break: break-all;
}

.failed-reason {
  display: block;
  margin-top: 6rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-danger;
}
</style>
