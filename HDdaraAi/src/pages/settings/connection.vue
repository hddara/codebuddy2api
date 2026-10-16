<script setup lang="ts">
/**
 * How the app reaches the gateway: origin, console cookie, model API key.
 *
 * Split out of `settings/index` because that page had grown into a list of
 * nine unrelated settings stacked end to end — connection details, a biometric
 * switch, the theme picker, three navigation entries, and a destructive action
 * — with no hierarchy between them. The three fields here are one decision
 * ("where do I connect, and as whom"), they are edited together, and they are
 * the only thing on this screen: nothing else competes for attention while the
 * user is pasting a 43-character token.
 *
 * This is NOT the same subject as `settings/gateway`. That page configures the
 * gateway's own behaviour (check-in, rate-limit windows, log level); this one
 * configures the client's connection to it. Keeping them on separate screens is
 * the point — they change for different reasons.
 */

import { onShow } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'

import { clearManualBaseUrlVerdict } from '@/api/core/base-url'
import { useNativeChrome } from '@/composables/useNativeChrome'
import { useAuthStore } from '@/store/authStore'
import { parseStored } from '@/store/persist'
import { ensureUnlocked } from '@/utils/app-guard'

definePage({
  name: 'settings-connection',
  style: { navigationBarTitleText: '连接配置' },
})

useNativeChrome()

const auth = useAuthStore()

const baseUrl = ref('')
const adminCookie = ref('')
// Hidden by default; setting this to true is how the user checks what they
// pasted in.
const cookieVisible = ref(false)
const apiKey = ref('')
const saved = ref(false)
const persistStatus = ref('')

/**
 * Whether there is anything to save.
 *
 * The button used to be unconditional, so pressing 保存 with every field empty
 * wrote an empty credential over a working one and reported success. A gateway
 * address or a cookie is the minimum, and either of them alone is a legitimate
 * configuration, so both count.
 */
const canSave = computed(
  () => Boolean(baseUrl.value.trim()) || Boolean(adminCookie.value.trim()),
)

const storageProbe = ref('')

/**
 * Storage state, in the app's own words.
 *
 * The line exists because a production build's sandbox cannot be inspected from
 * outside, so "did the credential actually land on disk" has to be answerable
 * from the device. It used to print `存储：cookie(43) / https://…` — a debug
 * dump: the address is already in the field above it, and a character count is
 * not something a user asked for.
 */
function probeStorage(): void {
  // #ifdef APP-PLUS
  try {
    const parsed = parseStored(uni.getStorageSync('auth'))

    storageProbe.value = parsed?.adminCookie || parsed?.apiKey
      ? '本机凭据已保存'
      : '本机未保存凭据'
  }
  catch {
    storageProbe.value = '本机凭据读取失败'
  }
  // #endif
}

/**
 * True when the saved credentials can be read back from persistent storage.
 *
 * The write itself is asynchronous on the App runtime (it retries until the 5+
 * storage engine is up), so a negative result here means "not stored yet"
 * rather than "lost" — the value is still in the store and will be flushed.
 */
function verifyPersisted(): boolean {
  // #ifdef APP-PLUS
  try {
    if (parseStored(uni.getStorageSync('auth'))?.adminCookie) {
      return true
    }

    // Retry shortly: the storage write itself retries until the bridge is up.
    setTimeout(() => {
      try {
        const landed = Boolean(parseStored(uni.getStorageSync('auth'))?.adminCookie)

        persistStatus.value = landed ? '已保存' : '保存未生效'
        probeStorage()
      }
      catch {
        persistStatus.value = '保存未生效'
      }
    }, 1800)

    return false
  }
  catch {
    return false
  }
  // #endif

  // #ifndef APP-PLUS
  return true
  // #endif
}

function load() {
  // Prefer whatever is in the store, but fall back to the persisted snapshot:
  // on a cold start the store may not have been hydrated yet when the first
  // page is shown, and filling the form from an empty store would look like the
  // credentials were lost even though they are on disk.
  const persisted = parseStored(uni.getStorageSync('auth')) ?? {}

  // Persisted value first: the store is not hydrated yet on a cold start, and
  // `auth.baseUrl` can still hold the previous value for a moment after the user
  // changed the field, which showed a stale address next to a fresh snapshot.
  baseUrl.value
    = (persisted.baseUrl as string | undefined)
      || auth.baseUrl
      || String(import.meta.env.VITE_API_BASE_URL ?? '')
  adminCookie.value = auth.adminCookie || (persisted.adminCookie as string | undefined) || ''
  apiKey.value = auth.apiKey || (persisted.apiKey as string | undefined) || ''
  saved.value = false
  persistStatus.value = ''
  probeStorage()
}

/**
 * Drops the stored origin so the app goes back to discovery.
 *
 * Needed because a hand-entered origin outranks every automatic candidate, and
 * it is read back from storage on each cold start. Without this the field is a
 * one-way door: once a stale address (a local dev server, a dead tunnel) is in
 * there, the only way out is editing this form — which is unreachable if the
 * app cannot reach anything to begin with. Clearing it restores the compiled-in
 * and remote-config candidates.
 */
function restoreDefaultBaseUrl() {
  baseUrl.value = ''
  auth.setBaseUrl('')
  // The address is gone, so any recorded probe failure for it is meaningless;
  // drop it too, or a later re-entry of the same address would be distrusted.
  clearManualBaseUrlVerdict()
  uni.removeStorageSync('API_BASE_URL_CACHE_V1')
  saved.value = false
  persistStatus.value = ''
  probeStorage()
  uni.showToast({ icon: 'none', title: '已恢复默认地址' })
}

function save() {
  auth.setBaseUrl(baseUrl.value.trim())
  auth.setAdminCookie(adminCookie.value)
  auth.setApiKey(apiKey.value)
  saved.value = true
  // Saving is the user saying "this address is the one to use", so a previous
  // failed probe must not keep it benched.
  clearManualBaseUrlVerdict(baseUrl.value.trim())

  // Verify the credentials actually reached persistent storage. On the App
  // runtime an early `setStorageSync` is dropped silently, and reporting
  // "saved" for a write that never landed is worse than failing loudly.
  persistStatus.value = verifyPersisted() ? '已保存' : '正在写入…'

  uni.showToast({ icon: 'none', title: '已保存' })
}

function toggleCookieVisible() {
  cookieVisible.value = !cookieVisible.value
}

/**
 * Clears the stored credential, after confirming.
 *
 * It shares a row with 保存 and takes effect immediately, so a misplaced tap
 * logged the user out and deleted the credential that would have signed them
 * back in — with no way back short of retyping a 43-character token.
 */
function clear() {
  uni.showModal({
    cancelText: '取消',
    confirmText: '清除',
    content: '将删除本机保存的网关地址与凭据，之后需要重新登录。',
    success: (result) => {
      if (!result.confirm)
        return

      auth.logout()
      adminCookie.value = ''
      apiKey.value = ''
      cookieVisible.value = false
      saved.value = false
      probeStorage()
      uni.showToast({ icon: 'none', title: '已清除凭据' })
    },
    title: '清除凭据',
  })
}

onShow(() => {
  if (!ensureUnlocked())
    return

  load()
})
</script>

<template>
  <view class="page" :class="themeClass">
    <view class="group">
      <text class="group-title">网关连接</text>

      <view class="section">
        <view class="section-head">
          <text class="section-title">网关地址</text>
          <button class="section-toggle" @tap="restoreDefaultBaseUrl">
            恢复默认
          </button>
        </view>
        <input
          v-model="baseUrl"
          class="input"
          placeholder="https://code.apimesh.cn"
          type="text"
        >
        <text class="section-hint">
          地址不可达时 App 会自动回退到内置地址，无需手动清理。
        </text>
      </view>

      <view class="section">
        <view class="section-head">
          <text class="section-title">控制台 Cookie</text>
          <!-- Masked by default: this value can impersonate an admin session,
               and screenshots of a settings page get shared. -->
          <button class="section-toggle" @tap="toggleCookieVisible">
            {{ cookieVisible ? '隐藏' : '显示' }}
          </button>
        </view>
        <input
          v-model="adminCookie"
          class="input"
          placeholder="codebuddy_admin_session=..."
          :password="!cookieVisible"
          type="text"
        >
        <text class="section-hint">
          在浏览器登录控制台后，从开发者工具复制 Cookie 头里的
          codebuddy_admin_session 值。
        </text>
      </view>

      <view class="section">
        <view class="section-head">
          <text class="section-title">网关 API Key</text>
          <text class="section-badge">可选</text>
        </view>
        <input
          v-model="apiKey"
          class="input"
          placeholder="cb2_..."
          type="text"
        >
        <text class="section-hint">
          用于直接调用 /v1 模型接口。只看会话不需要填。
        </text>
      </view>

      <!-- Status belongs to the group it describes: it reports what the
           credentials above it are doing, and as bare text between cards it
           belonged to neither the section above nor the one below. -->
      <view class="section section-tight">
        <view class="meta-row">
          <text class="meta-label">当前状态</text>
          <view class="meta-value">
            <view
              class="meta-dot"
              :class="auth.hasCredentials ? 'meta-dot-on' : 'meta-dot-off'"
            />
            <text>{{ auth.hasCredentials ? '已配置' : '未配置' }}</text>
          </view>
        </view>
        <view v-if="saved" class="meta-row">
          <view class="status-saved">
            <view class="status-icon i-carbon:checkmark" />
            <text>{{ persistStatus || '已保存' }}</text>
          </view>
        </view>
        <view v-if="storageProbe" class="meta-row">
          <view class="status-saved">
            <view class="status-icon i-carbon:checkmark" />
            <text>{{ storageProbe }}</text>
          </view>
        </view>
      </view>

      <!-- Actions live inside the group: they act on the fields above, and
           floating between cards they had no visible object. Primary at the
           right, which is where the eye finishes. -->
      <view class="group-actions">
        <button class="ghost" @tap="clear">
          清除凭据
        </button>
        <button class="primary" :disabled="!canSave" @tap="save">
          保存
        </button>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  background-color: $color-page;
  padding: $gap-page;
  /* Sub-page: nothing floats over the webview, but the home indicator does. */
  padding-bottom: $gap-page-bottom;
  box-sizing: border-box;
}

.group {
  display: flex;
  flex-direction: column;
  gap: $gap-section;
  margin-bottom: 56rpx;
}

.group-title {
  margin: 0 0 16rpx #{$gap-inline};
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
}

.section {
  display: flex;
  flex-direction: column;
  gap: $gap-inline;
  padding: $gap-section;
  background-color: $color-surface;
  border-radius: $radius-card;
}

/* The status block is a list of one-line facts, not a form: tighter padding so
   it reads as a summary of the section above rather than another input card. */
.section-tight {
  gap: $gap-inline;
  padding: $gap-inline $gap-section;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: $font-label;
  font-weight: 600;
  color: $color-text;
}

.section-badge {
  padding: 2rpx 12rpx;
  font-size: $font-micro;
  color: $color-text-muted;
  background-color: $color-neutral-surface;
  border-radius: $radius-chip;
}

.section-hint {
  font-size: $font-meta;
  line-height: 1.5;
  color: $color-text-muted;
}

/**
 * The inline text button beside a field label.
 *
 * `::after` is cleared because the miniprogram runtime draws a default border
 * on every <button>; left in place it outlines these as full-width controls.
 */
.section-toggle {
  padding: 0;
  margin: 0;
  font-size: $font-meta;
  line-height: 1;
  color: $color-primary;
  background: transparent;

  &::after {
    border: none;
  }
}

.input {
  height: $height-control;
  padding: 0 $gap-inline;
  font-size: $font-body;
  color: $color-text;
  background-color: $color-surface-sunken;
  border-radius: $radius-control;
  box-sizing: border-box;
}

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44rpx;
}

.meta-label {
  font-size: $font-meta;
  color: $color-text-muted;
}

.meta-value {
  display: flex;
  align-items: center;
  gap: 8rpx;
  font-size: $font-meta;
  color: $color-text;
}

.meta-dot {
  width: 12rpx;
  height: 12rpx;
  border-radius: $radius-pill;
}

.meta-dot-on {
  background-color: $color-success;
}

.meta-dot-off {
  background-color: $color-text-faint;
}

.status-saved {
  display: flex;
  align-items: center;
  gap: 8rpx;
  font-size: $font-meta;
  color: $color-success;
}

.status-icon {
  font-size: $font-meta;
}

.group-actions {
  display: flex;
  gap: $gap-inline;
}

.ghost,
.primary {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  height: $height-control;
  font-size: $font-body;
  border-radius: $radius-control;

  &::after {
    border: none;
  }
}

.ghost {
  color: $color-text;
  background-color: $color-surface-sunken;
}

.primary {
  color: #ffffff;
  background-color: $color-primary;
}

.primary[disabled] {
  background-color: $color-primary-disabled;
}
</style>
