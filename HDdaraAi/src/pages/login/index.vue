<script setup lang="ts">
import type { BiometricSupport } from '@/utils/biometric'
import { onLoad } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { clearManualBaseUrlVerdict } from '@/api/core/base-url'
import { fetchSessions } from '@/api/sessions'
import { useAuthStore } from '@/store/authStore'
import { parseStored } from '@/store/persist'
import {
  authenticateBiometric,
  biometricSupport,

} from '@/utils/biometric'

definePage({
  name: 'login',
  style: {
    navigationBarTitleText: '登录',
    // The lock screen is the first thing shown, so the navigation bar would only
    // be a place to tap "back" into a page the user has not unlocked yet.
    navigationStyle: 'custom',
  },
})

const auth = useAuthStore()

const baseUrl = ref('')
const adminCookie = ref('')
const cookieVisible = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const statusText = ref('')

/** True when a usable credential is already on the device. */
const hasStored = ref(false)

/**
 * Biometric capability, probed lazily.
 *
 * Probing means calling into `plus.fingerprint`, and on a build that did not
 * bundle the module that call raises a dialog the user cannot dismiss. So the
 * value stays `unknown` until something actually needs it — which, with the
 * opt-in below, is only ever a user who turned the feature on.
 */
const biometric = ref<BiometricSupport | 'unknown'>('unknown')

function probeBiometric(): BiometricSupport {
  if (biometric.value === 'unknown') {
    biometric.value = biometricSupport()
  }

  return biometric.value
}

const canSubmit = computed(
  () => Boolean(baseUrl.value.trim()) && Boolean(adminCookie.value.trim()),
)

/**
 * Reads the credential from persistent storage.
 *
 * The App's storage engine is not ready the instant the page runs, so this
 * waits briefly rather than concluding "not signed in" from a single miss —
 * that race was misdiagnosed once already.
 */
async function loadStored(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const persisted = parseStored(uni.getStorageSync('auth'))

      if (persisted?.adminCookie) {
        auth.syncLoginState()

        if (auth.baseUrl)
          baseUrl.value = auth.baseUrl
        // The cookie itself is not echoed back into the form: it is already in
        // the store and showing a credential on the lock screen is pointless.
        hasStored.value = true
        return true
      }
    }
    catch {
      // Storage not ready yet; fall through to the retry.
    }

    if (Date.now() >= deadline)
      return false

    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

/** Confirms the stored credential still works before letting the user in. */
async function verifyStored(): Promise<boolean> {
  try {
    await fetchSessions(1_440)
    return true
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''

    // Only an auth rejection should force a re-login. A network problem is not
    // a reason to ask for the password again.
    if (/session required|401|unauthor/i.test(message)) {
      errorMessage.value = '登录已过期，请重新填写凭据'
      return false
    }

    return true
  }
}

async function unlock() {
  if (busy.value)
    return

  busy.value = true
  errorMessage.value = ''
  statusText.value = '正在验证…'

  const result = await authenticateBiometric('验证身份以进入 HDdaraAI')

  if (!result.ok) {
    busy.value = false
    statusText.value = ''

    if (result.reason === 'cancelled') {
      // Staying on the lock screen is the correct outcome for a cancel; no
      // message, since the user already knows what they did.
      return
    }

    errorMessage.value = result.message
      ?? '未能验证身份，请重新填写凭据'
    return
  }

  statusText.value = '正在确认登录状态…'

  if (await verifyStored()) {
    enterApp()
    return
  }

  busy.value = false
  statusText.value = ''
  hasStored.value = false
}

async function signIn() {
  if (!canSubmit.value || busy.value)
    return

  busy.value = true
  errorMessage.value = ''
  statusText.value = '正在验证凭据…'

  auth.setBaseUrl(baseUrl.value.trim())
  auth.setAdminCookie(adminCookie.value.trim())
  // Typing an address here is the same explicit signal as saving it on the
  // settings page: a previous failed probe must not keep it benched, or the
  // user would type a working address and still be routed elsewhere.
  clearManualBaseUrlVerdict(baseUrl.value.trim())

  try {
    await fetchSessions(1_440)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '登录失败'

    auth.logout()
    errorMessage.value = /session required|401|unauthor/i.test(message)
      ? '凭据无效，请检查控制台 Cookie'
      : message
    busy.value = false
    statusText.value = ''
    return
  }

  statusText.value = '正在保存…'

  // The write is asynchronous on the App runtime; polling here means the user
  // is not dropped into the app before the credential is actually on disk.
  const deadline = Date.now() + 6_000

  while (Date.now() < deadline) {
    if (parseStored(uni.getStorageSync('auth'))?.adminCookie)
      break
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  enterApp()
}

function enterApp() {
  busy.value = false
  statusText.value = ''

  // Marks this launch as unlocked, which is what the page guards check.
  auth.unlock()

  // `reLaunch` rather than `navigateTo`: the lock screen must not stay on the
  // stack, or "back" would return to it while the session is live.
  uni.reLaunch({ url: '/pages/sessions/index' })
}

function toggleCookieVisible() {
  cookieVisible.value = !cookieVisible.value
}

/**
 * Whether the user has opted into biometric unlock.
 *
 * Off by default, and that matters here: `plus.fingerprint` exists as an object
 * even when the packaging did not include the module, and calling into it then
 * raises a blocking "模块未添加" dialog that no code can dismiss — it took the
 * whole app down on a cold start. Opting in means a build without the module is
 * never probed automatically, so it degrades to the credential form silently.
 */
const biometricEnabled = ref(false)

onLoad(async () => {
  // The origin is safe to prefill — it is not a secret and typing a URL on a
  // phone is tedious.
  //
  // Read it from persistent storage first, for the same reason the settings page
  // does: on a cold start this page runs before the store is hydrated, so
  // `auth.baseUrl` can still be empty even though an origin is on disk. Relying
  // on the store alone left the field blank and asked the user to retype a URL
  // the app already had. The compiled-in origin is the last resort, and matches
  // what `App.vue` seeds the store with.
  baseUrl.value
    = (parseStored(uni.getStorageSync('auth'))?.baseUrl as string | undefined)
      || auth.baseUrl
      || String(import.meta.env.VITE_API_BASE_URL ?? '')

  // The credential is deliberately NOT prefilled. Prefilling it turned the
  // "改用凭据登录" button into a one-tap bypass: the form was already valid, so a
  // stray tap signed the user straight in and the lock screen stopped being a
  // gate at all. Leaving it empty means reaching the app requires either the
  // biometric match or the credential being typed again.
  adminCookie.value = ''

  try {
    biometricEnabled.value = Boolean(uni.getStorageSync('biometric-enabled'))
  }
  catch {
    biometricEnabled.value = false
  }

  if (!(await loadStored()))
    return

  if (!biometricEnabled.value)
    return

  const capability = probeBiometric()

  if (capability === 'available') {
    // Present the prompt straight away; a stored credential is the common case
    // and making the user tap first would be an extra step every launch.
    void unlock()
  }
  else if (capability === 'unavailable') {
    statusText.value = '设备未设置指纹或面容，请在下方确认凭据'
  }
})

/**
 * Enters using the credential already on the device.
 *
 * Reached only by an explicit press. This is the path for a build without the
 * fingerprint module: the user still has to act on the lock screen, they just
 * are not asked to retype a 43-character token to get back into their own app.
 */
async function enterWithStored() {
  if (busy.value)
    return

  busy.value = true
  errorMessage.value = ''
  statusText.value = '正在确认登录状态…'

  if (await verifyStored()) {
    enterApp()
    return
  }

  busy.value = false
  statusText.value = ''
  hasStored.value = false
}

/** Switches to the form, with an empty credential field. */
function useCredentialForm() {
  adminCookie.value = ''
  errorMessage.value = ''
  statusText.value = ''
  hasStored.value = false
}

function toggleBiometric() {
  biometricEnabled.value = !biometricEnabled.value

  try {
    uni.setStorageSync('biometric-enabled', biometricEnabled.value)
  }
  catch {
    // Storage being unavailable only costs the preference, not the app.
  }

  if (biometricEnabled.value && probeBiometric() !== 'available') {
    errorMessage.value = biometric.value === 'unavailable'
      ? '设备未设置指纹或面容，请先在系统设置中添加'
      : '当前安装包未包含指纹模块，无法启用'
    biometricEnabled.value = false
    try {
      uni.setStorageSync('biometric-enabled', false)
    }
    catch {
      // Only the preference is lost; the feature stays off for this launch.
    }
  }
}
</script>

<template>
  <view class="page">
    <view class="brand">
      <view class="brand-mark">
        <view class="brand-bubble">
          <view class="brand-line brand-line-1" />
          <view class="brand-line brand-line-2" />
        </view>
      </view>
      <text class="brand-name">HDdaraAI</text>
      <text class="brand-sub">查看 AI 会话状态</text>
    </view>

    <!-- Unlock path -->
    <view v-if="hasStored" class="card">
      <text class="card-title">欢迎回来</text>
      <text class="card-hint">
        {{ biometricEnabled ? '使用指纹或面容快速解锁' : '已保存登录信息' }}
      </text>

      <!-- A <button> rather than a tappable <view>: on the App runtime a tap that
           lands on a child <text> does not reliably reach a handler bound to the
           parent view, which is why tapping the row did nothing. -->
      <button class="switch-row" @tap="toggleBiometric">
        <view class="switch-body">
          <text class="switch-label">指纹 / 面容解锁</text>
          <text class="switch-hint">
            开启后每次启动需验证身份才能查看会话
          </text>
        </view>
        <view class="switch" :class="[biometricEnabled ? 'switch-on' : '']">
          <view class="switch-knob" />
        </view>
      </button>

      <view v-if="errorMessage" class="error">
        {{ errorMessage }}
      </view>
      <view v-if="statusText" class="status">
        {{ statusText }}
      </view>

      <button
        v-if="biometricEnabled"
        class="primary"
        :disabled="busy"
        @tap="unlock"
      >
        {{ busy ? '验证中…' : '解锁' }}
      </button>

      <!-- Only offered when biometrics are off, so it cannot compete with the
           prompt. It is a deliberate press rather than a prefilled form, which
           is what keeps the lock screen meaningful while still not stranding
           anyone on a build that has no fingerprint module. -->
      <button
        v-if="!biometricEnabled"
        class="primary"
        :disabled="busy"
        @tap="enterWithStored"
      >
        {{ busy ? '进入中…' : '使用已保存的凭据进入' }}
      </button>

      <button class="ghost" @tap="useCredentialForm">
        改用凭据登录
      </button>
    </view>

    <!-- Credential path -->
    <view v-else class="card">
      <text class="card-title">登录</text>
      <text class="card-hint">
        填入网关地址与控制台 Cookie。Cookie 可在浏览器登录控制台后，
        从开发者工具的请求头里复制 codebuddy_admin_session 的值。
      </text>

      <view class="field">
        <text class="field-label">网关地址</text>
        <input
          v-model="baseUrl"
          class="input"
          placeholder="https://code.apimesh.cn"
          type="text"
        >
      </view>

      <view class="field">
        <view class="field-head">
          <text class="field-label">控制台 Cookie</text>
          <text class="field-toggle" @tap="toggleCookieVisible">
            {{ cookieVisible ? '隐藏' : '显示' }}
          </text>
        </view>
        <input
          v-model="adminCookie"
          class="input"
          :password="!cookieVisible"
          placeholder="codebuddy_admin_session=..."
          type="text"
        >
      </view>

      <view v-if="errorMessage" class="error">
        {{ errorMessage }}
      </view>
      <view v-if="statusText" class="status">
        {{ statusText }}
      </view>

      <button class="primary" :disabled="busy || !canSubmit" @tap="signIn">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </view>

    <view class="footnote">
      凭据仅保存在本机，用于访问你自己的网关。
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 120rpx 48rpx 60rpx;
  box-sizing: border-box;
  background-color: #f5f6f8;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 64rpx;
}

/* Same speech-bubble-with-lines mark as the tab bar and app icon, drawn with
   views so the lock screen carries no extra image weight. */
.brand-mark {
  width: 128rpx;
  height: 128rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 32rpx;
  background: linear-gradient(160deg, #0a84ff, #005cd6);
}

.brand-bubble {
  width: 68rpx;
  padding: 16rpx 14rpx 22rpx;
  border-radius: 16rpx;
  background-color: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.brand-line {
  height: 8rpx;
  border-radius: 4rpx;
  background-color: #0a84ff;
}

.brand-line-1 {
  width: 100%;
}

.brand-line-2 {
  width: 60%;
}

.brand-name {
  margin-top: 24rpx;
  font-size: 40rpx;
  font-weight: 600;
  color: #1f2329;
}

.brand-sub {
  margin-top: 8rpx;
  font-size: 25rpx;
  color: #8a8f99;
}

.card {
  padding: 36rpx 32rpx;
  border-radius: 24rpx;
  background-color: #ffffff;
}

.card-title {
  display: block;
  font-size: 34rpx;
  font-weight: 600;
  color: #1f2329;
}

.card-hint {
  display: block;
  margin-top: 10rpx;
  font-size: 24rpx;
  color: #8a8f99;
  line-height: 1.65;
}

/* A <button> carries a default background, border, radius and centring on both
   platforms; all of it is reset here so the row reads as a list item. */
.switch-row {
  display: flex;
  align-items: center;
  gap: 20rpx;
  width: 100%;
  margin: 32rpx 0 0;
  padding: 24rpx 0;
  border: none;
  border-top: 1rpx solid #f0f1f3;
  border-bottom: 1rpx solid #f0f1f3;
  border-radius: 0;
  background-color: transparent;
  line-height: normal;
  text-align: left;
}

.switch-row::after {
  border: none;
}

.switch-body {
  flex: 1;
  min-width: 0;
}

.switch-label {
  display: block;
  font-size: 28rpx;
  color: #1f2329;
}

.switch-hint {
  display: block;
  margin-top: 6rpx;
  font-size: 22rpx;
  color: #a8adb5;
  line-height: 1.55;
}

/* Drawn rather than using <switch>: the native control sizes and colours
   differently per platform, and this row needs to match the app's accent. */
.switch {
  flex: none;
  width: 92rpx;
  height: 52rpx;
  padding: 4rpx;
  box-sizing: border-box;
  border-radius: 26rpx;
  background-color: #d8dbe0;
  transition: background-color 0.18s ease;
}

.switch-on {
  background-color: #0a84ff;
}

.switch-knob {
  width: 44rpx;
  height: 44rpx;
  border-radius: 50%;
  background-color: #ffffff;
  transition: transform 0.18s ease;
}

.switch-on .switch-knob {
  transform: translateX(40rpx);
}

.field {
  margin-top: 28rpx;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-label {
  display: block;
  margin-bottom: 12rpx;
  font-size: 26rpx;
  color: #4a4f57;
}

.field-toggle {
  font-size: 24rpx;
  color: #0a84ff;
}

.input {
  width: 100%;
  height: 88rpx;
  padding: 0 22rpx;
  box-sizing: border-box;
  border-radius: 16rpx;
  background-color: #f5f6f8;
  font-size: 27rpx;
  color: #1f2329;
}

.error {
  margin-top: 24rpx;
  padding: 18rpx 20rpx;
  border-radius: 14rpx;
  background-color: #fff1f0;
  font-size: 25rpx;
  color: #cf1322;
  line-height: 1.6;
}

.status {
  margin-top: 24rpx;
  font-size: 25rpx;
  color: #8a8f99;
}

.primary {
  margin-top: 36rpx;
  height: 92rpx;
  line-height: 92rpx;
  border-radius: 18rpx;
  background-color: #0a84ff;
  color: #ffffff;
  font-size: 30rpx;
}

.primary[disabled] {
  background-color: #b9d4f5;
  color: #ffffff;
}

.ghost {
  margin-top: 20rpx;
  height: 88rpx;
  line-height: 88rpx;
  border-radius: 18rpx;
  background-color: #f5f6f8;
  color: #4a4f57;
  font-size: 28rpx;
}

.footnote {
  margin-top: 40rpx;
  font-size: 22rpx;
  color: #a8adb5;
  text-align: center;
  line-height: 1.7;
}
</style>
