<script setup lang="ts">
import type { CredentialLimit, CredentialListItem, CurrentCredential } from '@/api/credentials'
import { onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { consoleErrorMessage } from '@/api/core/console'
import {
  clearCredentialLimits,
  deleteCredential,
  describeCredential,
  fetchCredentialLimits,
  fetchCredentials,
  fetchCurrentCredential,
  selectCredential,
} from '@/api/credentials'
import { ensureUnlocked } from '@/utils/app-guard'
import { formatDateTime } from '@/utils/format'

definePage({
  name: 'credentials',
  style: { navigationBarTitleText: '凭证管理' },
})

const credentials = ref<CredentialListItem[]>([])
const current = ref<CurrentCredential | null>(null)
const limits = ref<CredentialLimit[]>([])
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
/** Filename of the row a write is in flight for; empty when idle. */
const pending = ref('')
/** Index awaiting a delete confirmation. */
const confirmIndex = ref<number | null>(null)

const limitByFilename = computed(() => {
  const map = new Map<string, CredentialLimit>()

  for (const limit of limits.value) {
    map.set(limit.filename, limit)
  }

  return map
})

/** Which credential the next request will use, when the gateway is round-robining. */
const nextFilename = computed(() => {
  const value = current.value

  if (!value || value.status === 'no_credentials') {
    return null
  }

  return value.next_filename ?? null
})

const limitedCount = computed(() => limits.value.length)

async function load() {
  loading.value = true
  errorMessage.value = ''

  try {
    // The three reads are independent; a failure in one must not blank the
    // others, because each still tells the user something useful on its own.
    const [list, cursor, limitList] = await Promise.all([
      fetchCredentials(),
      fetchCurrentCredential().catch(() => null),
      fetchCredentialLimits().catch(() => [] as CredentialLimit[]),
    ])

    credentials.value = list
    current.value = cursor
    limits.value = limitList
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取凭据失败')
  }
  finally {
    loading.value = false
  }
}

async function useNext(item: CredentialListItem) {
  if (pending.value) {
    return
  }

  pending.value = item.filename
  notice.value = ''
  errorMessage.value = ''

  try {
    const result = await selectCredential(item.index)

    // The endpoint answers 200 with `success: false` for an out-of-range index,
    // so the flag has to be read — trusting the status would report a change
    // that never happened.
    if (!result.success) {
      errorMessage.value = result.message || '切换失败'
      return
    }

    notice.value = `下一次请求将使用 ${item.email || item.filename}`
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '切换失败')
  }
  finally {
    pending.value = ''
  }
}

async function remove(item: CredentialListItem) {
  if (pending.value) {
    return
  }

  if (confirmIndex.value !== item.index) {
    confirmIndex.value = item.index

    return
  }

  confirmIndex.value = null
  pending.value = item.filename
  notice.value = ''
  errorMessage.value = ''

  try {
    const result = await deleteCredential(item.index)

    if (!result.success) {
      errorMessage.value = result.message || '删除失败'
      return
    }

    notice.value = '凭据已删除'
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '删除失败')
  }
  finally {
    pending.value = ''
  }
}

async function clearLimits(item?: CredentialListItem) {
  if (pending.value) {
    return
  }

  pending.value = item?.filename ?? '*'
  notice.value = ''
  errorMessage.value = ''

  try {
    const result = await clearCredentialLimits(item?.filename)

    notice.value = result.cleared
      ? `已解除 ${result.cleared} 个限流标记`
      : '没有需要解除的限流'
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '解除限流失败')
  }
  finally {
    pending.value = ''
  }
}

/**
 * The line under the email.
 *
 * State first, because that is what explains a failure; the domain and user id
 * come after for telling two accounts on the same provider apart.
 */
function subtitle(item: CredentialListItem): string {
  const parts = [describeCredential(item)]

  if (item.domain) {
    parts.push(item.domain)
  }

  if (item.user_id) {
    parts.push(item.user_id)
  }

  return parts.join(' · ')
}

function limitText(limit: CredentialLimit): string {
  const kind = limit.kind === 'quota' ? '配额受限' : '频率受限'
  const until = limit.resumeAt ? `，${formatDateTime(limit.resumeAt)} 恢复` : ''

  return `${kind}${until}`
}

/**
 * Navigation out of the page.
 *
 * A method rather than `uni.navigateTo` in the template: `uni` is a runtime
 * global, not something the template has in scope, so the call there fails to
 * resolve and nothing happens when the row is pressed.
 */
function openAccessKeys() {
  uni.navigateTo({ url: '/pages/credentials/keys' })
}

onShow(() => {
  if (!ensureUnlocked()) {
    return
  }

  void load()
})
</script>

<template>
  <view class="page">
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
      <view class="section">
        <text class="section-title">轮询状态</text>
        <view class="row">
          <text class="row-label">凭据总数</text>
          <text class="row-value">{{ credentials.length }} 个</text>
        </view>
        <view class="row">
          <text class="row-label">下次使用</text>
          <text class="row-value">{{ nextFilename || '未指定' }}</text>
        </view>
        <view class="row row-last">
          <text class="row-label">限流中</text>
          <text class="row-value">{{ limitedCount }} 个</text>
        </view>

        <text v-if="nextFilename" class="section-hint hint-block">
          网关在多个账号间自动轮询；「设为下次」只改变下一轮从哪个账号开始，
          不会打断正在进行的回答。
        </text>

        <AppButton
          v-if="limitedCount"
          variant="tonal"
          block
          :disabled="Boolean(pending)"
          @tap="clearLimits()"
        >
          {{ pending === '*' ? '处理中…' : `全部解除限流（${limitedCount}）` }}
        </AppButton>
      </view>

      <view v-if="notice" class="notice">
        <view class="notice-icon i-carbon:checkmark" />
        <text>{{ notice }}</text>
      </view>

      <StateBlock
        v-if="!credentials.length"
        icon="i-carbon:user-multiple"
        text="还没有上游账号"
        hint="在桌面控制台的「凭证」页添加，添加后会出现在这里。"
      />

      <view
        v-for="item in credentials"
        :key="item.filename"
        class="card"
      >
        <view class="card-head">
          <text class="card-title">{{ item.name || item.email }}</text>
          <StatusTag
            :tone="limitByFilename.get(item.filename) ? 'warning' : (item.is_expired ? 'danger' : 'success')"
          >
            {{ describeCredential(item) }}
          </StatusTag>
        </view>

        <text class="card-subtitle">{{ subtitle(item) }}</text>

        <view v-if="limitByFilename.get(item.filename)" class="limit">
          <view class="limit-icon i-carbon:warning-alt" />
          <text class="limit-text">
            {{ limitText(limitByFilename.get(item.filename)!) }}
          </text>
        </view>

        <view class="card-actions">
          <AppButton
            variant="tonal"
            :disabled="Boolean(pending) || item.filename === nextFilename"
            @tap="useNext(item)"
          >
            {{ item.filename === nextFilename ? '当前下次' : '设为下次' }}
          </AppButton>
          <AppButton
            v-if="limitByFilename.get(item.filename)"
            variant="tonal"
            :disabled="Boolean(pending)"
            @tap="clearLimits(item)"
          >
            解除限流
          </AppButton>
          <AppButton
            :variant="confirmIndex === item.index ? 'solid' : 'tonal'" tone="danger"
            :disabled="Boolean(pending)"
            @tap="remove(item)"
          >
            {{ confirmIndex === item.index ? '确认删除' : '删除' }}
          </AppButton>
        </view>
      </view>

      <view class="section">
        <text class="section-title">关于凭证与密钥</text>
        <text class="section-hint">
          这里的每一项是一个真实的上游账号，网关在它们之间轮询。
          「访问密钥」是另一回事：它是给客户端用的 cb2_ 令牌，绑定一组账号后决定客户端能用哪些模型。
        </text>
        <AppButton variant="tonal" block @tap="openAccessKeys">
          管理访问密钥
        </AppButton>
      </view>
    </template>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: $gap-page;
  box-sizing: border-box;
  background-color: $color-page;
}

.section {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.section-title {
  display: block;
  margin-bottom: $gap-inline;
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

.hint-block {
  margin-top: 16rpx;
  margin-bottom: $gap-section;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
  padding: $gap-inline 0;
  border-bottom: 1rpx solid $color-border-strong;
}

.row-last {
  border-bottom: none;
}

.row-label {
  flex: none;
  font-size: $font-label;
  color: $color-text-secondary;
}

.row-value {
  flex: 1;
  min-width: 0;
  font-size: $font-label;
  color: $color-text;
  text-align: right;
  word-break: break-all;
}

.card {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.card-title {
  flex: 1;
  min-width: 0;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-subtitle {
  display: block;
  margin-top: 8rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
  word-break: break-all;
}

.limit {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-top: 14rpx;
  padding: 12rpx 16rpx;
  border-radius: $radius-control;
  background-color: $color-warning-surface;
}

.limit-icon {
  flex: none;
  width: 28rpx;
  height: 28rpx;
  color: $color-warning;
}

.limit-text {
  flex: 1;
  min-width: 0;
  font-size: $font-meta;
  color: $color-warning;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: $gap-inline;
  margin-top: $gap-section;
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
</style>
