<script setup lang="ts">
import type { AccessKeySummary } from '@/api/access-keys'
import type { CredentialListItem } from '@/api/credentials'

import { onShow } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'
import {
  createAccessKey,
  deleteAccessKey,
  fetchAccessKeys,
  fetchAccessKeySecret,
  formatModelAliases,
  parseModelAliases,
} from '@/api/access-keys'
import { consoleErrorMessage } from '@/api/core/console'
import { fetchCredentials } from '@/api/credentials'
import { ensureUnlocked } from '@/utils/app-guard'
import { formatRelative } from '@/utils/format'

definePage({
  name: 'access-keys',
  style: { navigationBarTitleText: '访问密钥' },
})

const keys = ref<AccessKeySummary[]>([])
const credentials = ref<CredentialListItem[]>([])
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
const busy = ref(false)

/** Secret returned once by creation, shown until dismissed. */
const freshSecret = ref<{ name: string, secret: string } | null>(null)
/** A key's plaintext secret, revealed on demand. */
const revealed = ref<{ id: string, secret: string } | null>(null)
const confirmDeleteId = ref('')

const creating = ref(false)
const draftName = ref('')
const draftFilenames = ref<string[]>([])
const draftAliases = ref('')

const canCreate = computed(
  () => draftName.value.trim().length > 0 && draftFilenames.value.length > 0,
)

async function load() {
  loading.value = true
  errorMessage.value = ''

  try {
    const [keyList, credentialList] = await Promise.all([
      fetchAccessKeys(),
      // A key is bound to credentials and cannot be created without any, so the
      // list doubles as the picker's options.
      fetchCredentials().catch(() => [] as CredentialListItem[]),
    ])

    keys.value = keyList
    credentials.value = credentialList
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取访问密钥失败')
  }
  finally {
    loading.value = false
  }
}

function resetDraft() {
  creating.value = false
  draftName.value = ''
  draftFilenames.value = []
  draftAliases.value = ''
}

function beginCreate() {
  notice.value = ''
  errorMessage.value = ''
  creating.value = true
  draftFilenames.value = credentials.value.map(item => item.filename)
}

function toggleCredential(filename: string) {
  const index = draftFilenames.value.indexOf(filename)

  if (index >= 0) {
    draftFilenames.value = draftFilenames.value.filter(item => item !== filename)

    return
  }

  draftFilenames.value = [...draftFilenames.value, filename]
}

async function submitCreate() {
  if (!canCreate.value || busy.value) {
    return
  }

  busy.value = true
  errorMessage.value = ''
  notice.value = ''

  try {
    const result = await createAccessKey({
      credential_filenames: draftFilenames.value,
      model_aliases: parseModelAliases(draftAliases.value),
      name: draftName.value.trim(),
    })

    // Held on screen rather than only toasted: the server never repeats the
    // plaintext, so this is the user's single chance to copy it.
    freshSecret.value = { name: result.access_key.name, secret: result.secret }
    resetDraft()
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '创建失败')
  }
  finally {
    busy.value = false
  }
}

async function reveal(item: AccessKeySummary) {
  if (busy.value) {
    return
  }

  if (revealed.value?.id === item.id) {
    revealed.value = null

    return
  }

  busy.value = true
  errorMessage.value = ''

  try {
    const payload = await fetchAccessKeySecret(item.id)

    revealed.value = { id: item.id, secret: payload.secret }
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取密钥失败')
  }
  finally {
    busy.value = false
  }
}

async function remove(item: AccessKeySummary) {
  if (busy.value) {
    return
  }

  // Two presses, because the key cannot be recovered and anything already
  // configured with it stops working.
  if (confirmDeleteId.value !== item.id) {
    confirmDeleteId.value = item.id

    return
  }

  confirmDeleteId.value = ''
  busy.value = true
  errorMessage.value = ''
  notice.value = ''

  try {
    await deleteAccessKey(item.id)
    notice.value = `已删除「${item.name}」`
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '删除失败')
  }
  finally {
    busy.value = false
  }
}

async function copy(text: string, label: string) {
  uni.setClipboardData({
    data: text,
    success: () => uni.showToast({ icon: 'none', title: `${label}已复制` }),
  })
}

function bindSummary(item: AccessKeySummary): string {
  const count = item.credentialFilenames.length

  if (!count) {
    return '未绑定账号'
  }

  const aliasCount = Object.keys(item.modelAliases ?? {}).length

  return aliasCount
    ? `${count} 个账号 · ${aliasCount} 个别名`
    : `${count} 个账号`
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
      <!-- Shown above everything else: the plaintext exists only in this
           response, and a user who navigates away has to make a new key. -->
      <view v-if="freshSecret" class="secret-banner">
        <text class="secret-title">「{{ freshSecret.name }}」已创建</text>
        <text class="secret-warning">
          这段密钥只显示这一次。离开后无法再查看，只能重新创建。
        </text>
        <text class="secret-value" selectable>{{ freshSecret.secret }}</text>
        <view class="secret-actions">
          <AppButton variant="solid" @tap="copy(freshSecret.secret, '密钥')">
            复制
          </AppButton>
          <AppButton variant="tonal" @tap="freshSecret = null">
            我已保存
          </AppButton>
        </view>
      </view>

      <view v-if="notice" class="notice">
        <view class="notice-icon i-carbon:checkmark" />
        <text>{{ notice }}</text>
      </view>

      <template v-if="creating">
        <view class="section">
          <text class="section-title">新建访问密钥</text>

          <view class="field">
            <text class="field-label">名称</text>
            <input
              v-model="draftName"
              class="input"
              placeholder="例如：我的手机"
              type="text"
            >
          </view>

          <view class="field">
            <text class="field-label">可用账号（{{ draftFilenames.length }}）</text>
            <text class="field-hint">
              客户端用这个密钥时，只能访问选中的账号与模型。
            </text>
            <StateBlock
              v-if="!credentials.length"
              variant="plain"
              icon="i-carbon:user-multiple"
              text="还没有上游账号"
              hint="先在「凭证管理」里添加。"
            />
            <view v-else class="picker">
              <button
                v-for="item in credentials"
                :key="item.filename"
                class="picker-row"
                @tap="toggleCredential(item.filename)"
              >
                <view
                  class="picker-box"
                  :class="draftFilenames.includes(item.filename) ? 'picker-on i-carbon:checkmark-filled' : 'picker-off'"
                />
                <view class="picker-body">
                  <text class="picker-name">{{ item.name || item.email }}</text>
                  <text class="picker-file">{{ item.filename }}</text>
                </view>
              </button>
            </view>
          </view>

          <view class="field">
            <text class="field-label">模型别名（可选）</text>
            <text class="field-hint">
              每行一条，格式 <text class="field-code">别名 = 模型</text>。
              用来给长模型名一个短名字。
            </text>
            <textarea
              v-model="draftAliases"
              class="textarea"
              placeholder="fast = deepseek-v4.1-flash"
            />
          </view>

          <view class="actions">
            <AppButton variant="tonal" @tap="resetDraft">
              取消
            </AppButton>
            <AppButton
              variant="solid"
              :disabled="!canCreate || busy"
              @tap="submitCreate"
            >
              {{ busy ? '创建中…' : '创建' }}
            </AppButton>
          </view>
        </view>
      </template>

      <AppButton
        v-else
        variant="solid"
        block
        class="create-button"
        :disabled="!credentials.length"
        @tap="beginCreate"
      >
        新建访问密钥
      </AppButton>

      <StateBlock
        v-if="!keys.length"
        icon="i-carbon:key"
        text="还没有访问密钥"
        hint="密钥让客户端用 cb2_ 令牌访问网关，与上游账号分开管理。"
      />

      <view
        v-for="item in keys"
        :key="item.id"
        class="card"
      >
        <view class="card-head">
          <text class="card-title">{{ item.name }}</text>
          <text class="card-time">{{ formatRelative(item.createdAt) }}创建</text>
        </view>

        <text class="card-subtitle">{{ bindSummary(item) }}</text>

        <view class="secret-row">
          <text class="secret-masked">
            {{ revealed?.id === item.id ? revealed.secret : item.maskedSecret }}
          </text>
          <button class="secret-toggle" @tap="reveal(item)">
            {{ revealed?.id === item.id ? '隐藏' : '查看' }}
          </button>
        </view>

        <view v-if="Object.keys(item.modelAliases ?? {}).length" class="aliases">
          <text class="aliases-title">模型别名</text>
          <text class="aliases-body">{{ formatModelAliases(item.modelAliases) }}</text>
        </view>

        <view class="card-actions">
          <AppButton
            variant="tonal"
            :disabled="busy"
            @tap="copy(revealed?.id === item.id ? revealed.secret : item.maskedSecret, '密钥')"
          >
            复制
          </AppButton>
          <AppButton
            :variant="confirmDeleteId === item.id ? 'solid' : 'tonal'"
            :tone="confirmDeleteId === item.id ? 'danger' : 'neutral'"
            :disabled="busy"
            @tap="remove(item)"
          >
            {{ confirmDeleteId === item.id ? '确认删除' : '删除' }}
          </AppButton>
        </view>
      </view>

      <view class="section">
        <text class="section-title">这个密钥怎么用</text>
        <text class="section-hint">
          把密钥填进客户端的 API Key 字段，请求地址指向网关的 /v1 接口。
          密钥决定了能用哪些账号，因此不需要在这里配置网关地址。
        </text>
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

/* Deliberately loud: this is the only time the secret is readable, and a
   quiet banner is one a user scrolls past. */
.secret-banner {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-primary-surface;
}

.secret-title {
  display: block;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
}

.secret-warning {
  display: block;
  margin-top: 8rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-danger;
}

.secret-value {
  display: block;
  margin-top: 16rpx;
  padding: 16rpx;
  border-radius: $radius-control;
  background-color: $color-surface;
  font-size: $font-label;
  color: $color-text;
  word-break: break-all;
}

.secret-actions {
  display: flex;
  gap: $gap-section;
  margin-top: $gap-section;
}

.field {
  margin-top: 20rpx;
}

.field-label {
  display: block;
  margin-bottom: $gap-inline;
  font-size: $font-label;
  color: $color-text-secondary;
}

.field-hint {
  display: block;
  margin-bottom: 12rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
}

.field-code {
  font-size: $font-meta;
  color: $color-text-secondary;
}

.input {
  width: 100%;
  height: $height-control;
  padding: 0 22rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  font-size: $font-body;
  color: $color-text;
}

.textarea {
  width: 100%;
  height: 180rpx;
  padding: 18rpx 22rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  font-size: $font-label;
  line-height: 1.6;
  color: $color-text;
}

.picker {
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  overflow: hidden;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: $gap-inline;
  width: 100%;
  margin: 0;
  padding: $gap-section;
  border: none;
  border-bottom: 1rpx solid $color-border-strong;
  border-radius: 0;
  background-color: transparent;
  line-height: normal;
  text-align: left;
}

.picker-row:last-child {
  border-bottom: none;
}

.picker-row::after {
  border: none;
}

.picker-box {
  flex: none;
  width: 40rpx;
  height: 40rpx;
  border-radius: 8rpx;
}

.picker-off {
  border: 2rpx solid $color-border;
  background-color: $color-surface;
}

.picker-on {
  color: $color-surface;
  background-color: $color-primary;
}

.picker-body {
  flex: 1;
  min-width: 0;
}

.picker-name {
  display: block;
  font-size: $font-label;
  color: $color-text;
}

.picker-file {
  display: block;
  margin-top: 4rpx;
  font-size: $font-micro;
  color: $color-text-faint;
  word-break: break-all;
}

.actions {
  display: flex;
  gap: $gap-section;
  margin-top: $gap-section;
}

.create-button {
  margin-bottom: $gap-page;
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

.card-time {
  flex: none;
  font-size: $font-meta;
  color: $color-text-muted;
}

.card-subtitle {
  display: block;
  margin-top: 8rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

.secret-row {
  display: flex;
  align-items: center;
  gap: $gap-inline;
  margin-top: 14rpx;
  padding: 12rpx 16rpx;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
}

.secret-masked {
  flex: 1;
  min-width: 0;
  font-size: $font-label;
  color: $color-text;
  word-break: break-all;
}

.secret-toggle {
  flex: none;
  width: auto;
  margin: 0;
  padding: 4rpx 12rpx;
  font-size: $font-meta;
  line-height: 1.5;
  color: $color-primary;
  background-color: transparent;
}

.secret-toggle::after {
  border: none;
}

.aliases {
  margin-top: 14rpx;
}

.aliases-title {
  display: block;
  font-size: $font-micro;
  color: $color-text-muted;
}

.aliases-body {
  display: block;
  margin-top: 4rpx;
  font-size: $font-meta;
  line-height: 1.7;
  color: $color-text-secondary;
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
