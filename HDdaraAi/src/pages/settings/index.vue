<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'

import { clearManualBaseUrlVerdict } from '@/api/core/base-url'
import { useAuthStore } from '@/store/authStore'
import { parseStored } from '@/store/persist'
import { ensureUnlocked } from '@/utils/app-guard'

definePage({
  name: 'settings',
  style: { navigationBarTitleText: '设置' },
})

const auth = useAuthStore()

const baseUrl = ref('')
const adminCookie = ref('')
// 默认隐藏；设成 true 才能看见自己粘进去的值对不对。
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

const storageProbe = ref('')

/**
 * Reads the persisted snapshot and describes it.
 *
 * Shown on the settings page so the storage state is observable on the device
 * itself: there is no way to inspect the App sandbox from `adb` on a production
 * build, and "did the write land" cannot be answered by looking at the UI alone.
 */
function probeStorage(): void {
  // #ifdef APP-PLUS
  try {
    const parsed = parseStored(uni.getStorageSync('auth'))

    if (!parsed) {
      storageProbe.value = '存储：空'
      return
    }

    const cookie = (parsed.adminCookie as string | undefined) ?? ''
    const url = (parsed.baseUrl as string | undefined) ?? ''

    storageProbe.value = `存储：${cookie ? `cookie(${cookie.length})` : '无 cookie'} / ${url || '无地址'}`
  }
  catch (error) {
    storageProbe.value = `存储读取失败：${String(error)}`
  }
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

function clear() {
  auth.logout()
  adminCookie.value = ''
  apiKey.value = ''
  cookieVisible.value = false
  saved.value = false

  uni.showToast({ icon: 'none', title: '已清除凭据' })
}

onShow(() => {
  if (!ensureUnlocked())
    return

  load()
})
</script>

<template>
  <view class="page">
    <view class="section">
      <text class="section-title">网关地址</text>
      <input
        v-model="baseUrl"
        class="input"
        placeholder="https://code.apimesh.cn"
        type="text"
      >
    </view>

    <view class="section">
      <view class="section-head">
        <text class="section-title">控制台 Cookie</text>
        <!-- 默认遮蔽：这个值可以直接冒充管理员会话，设置页又常被截图分享。
             需要核对时再手动展开。 -->
        <text class="section-toggle" @tap="toggleCookieVisible">
          {{ cookieVisible ? '隐藏' : '显示' }}
        </text>
      </view>
      <text class="section-hint">
        在浏览器登录控制台后，从开发者工具复制 Cookie 头里的
        codebuddy_admin_session 值。
      </text>
      <input
        v-model="adminCookie"
        class="input"
        placeholder="codebuddy_admin_session=..."
        :password="!cookieVisible"
        type="text"
      >
    </view>

    <view class="section">
      <text class="section-title">网关 API Key（可选）</text>
      <text class="section-hint">
        用于直接调用 /v1 模型接口，查看会话不需要填。
      </text>
      <input
        v-model="apiKey"
        class="input"
        placeholder="cb2_..."
        type="text"
      >
    </view>

    <view class="actions">
      <button class="primary" :disabled="!canSave" @tap="save">
        保存
      </button>
      <button class="ghost" @tap="clear">
        清除凭据
      </button>
    </view>

    <view class="actions">
      <button class="ghost" @tap="restoreDefaultBaseUrl">
        恢复默认地址
      </button>
    </view>

    <view class="section-hint hint-block">
      地址不可达时 App 会自动回退到内置地址，无需手动清理。
    </view>

    <view class="status">
      <text>当前状态：{{ auth.hasCredentials ? '已配置' : '未配置' }}</text>
      <text v-if="saved" class="status-saved">{{ persistStatus || '已保存' }}</text>
    </view>
    <view v-if="storageProbe" class="status">
      <text class="status-saved">{{ storageProbe }}</text>
    </view>

    <view class="about">
      <text class="about-title">HDdaraAi v0.1.0</text>
      <text class="about-text">
        用于随时查看 AI 会话状态。会话列表与实时输出来自网关的
        /admin-api/sessions 接口。
      </text>
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

.section {
  margin-bottom: 24rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.section-title {
  display: block;
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 12rpx;
}

.section-hint {
  display: block;
  font-size: 24rpx;
  color: #8a8f99;
  line-height: 1.6;
  margin-bottom: 16rpx;
}

/* 说明文字独立成段：贴在按钮下方，不再依赖所在 section 的下间距。 */
.hint-block {
  margin: 16rpx 8rpx 0;
}

.input {
  width: 100%;
  height: 80rpx;
  padding: 0 20rpx;
  box-sizing: border-box;
  border-radius: 14rpx;
  background-color: #f5f6f8;
  font-size: 26rpx;
  color: #1f2329;
}

/* 标题与「显示/隐藏」同排；标题原有的下间距在这里由容器承担。 */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.section-head .section-title {
  margin-bottom: 0;
}

.section-toggle {
  font-size: 24rpx;
  color: #0a84ff;
}

.actions {
  display: flex;
  gap: 20rpx;
  margin-top: 8rpx;
}

.primary {
  flex: 1;
  background-color: #0a84ff;
  color: #ffffff;
  font-size: 28rpx;
  border-radius: 14rpx;
}

/* Dimmed rather than merely inert, so the state is visible before the tap. */
.primary[disabled] {
  background-color: #b9d4f5;
  color: #ffffff;
}

.ghost {
  flex: 1;
  background-color: #ffffff;
  color: #4a4f57;
  font-size: 28rpx;
  border-radius: 14rpx;
}

.status {
  display: flex;
  justify-content: space-between;
  padding: 24rpx 8rpx;
  font-size: 24rpx;
  color: #8a8f99;
}

.status-saved {
  color: #22a06b;
}

.about {
  margin-top: 40rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.about-title {
  display: block;
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 10rpx;
}

.about-text {
  font-size: 24rpx;
  color: #8a8f99;
  line-height: 1.7;
}
</style>
