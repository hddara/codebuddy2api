<script setup lang="ts">
import type { BiometricSupport } from '@/utils/biometric'
import type { StoredVerdict } from '@/utils/unlock-verdict'

import { onLoad, onShow } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'
import { clearManualBaseUrlVerdict } from '@/api/core/base-url'
import { fetchSessions, loginWithPassword, renewSession } from '@/api/sessions'
import { useAuthStore } from '@/store/authStore'
import { useBiometricStore } from '@/store/biometricStore'
import { parseStored } from '@/store/persist'
import {
  authenticateBiometric,
  biometricLabel,
  describeBiometricFailure,
} from '@/utils/biometric'
import { isAuthError } from '@/utils/errors'
import { consumePendingRoute } from '@/utils/launch-route'
import { classifyStoredCredential, describeUnlockFailure } from '@/utils/unlock-verdict'

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

/**
 * The biometric opt-in, shared with the settings page.
 *
 * Held in a store rather than a private ref because two screens offer the same
 * switch, and reading one preference from two places is how a toggle ends up
 * disagreeing with itself.
 */
const biometric = useBiometricStore()

const baseUrl = ref('')
/** Account credentials — the login a user can actually complete. */
const username = ref('admin')
const password = ref('')
/** Advanced path: a session cookie copied from a signed-in browser. */
const adminCookie = ref('')
/** Whether the advanced (cookie) fields are shown instead of the account form. */
const useCookieMode = ref(false)
const cookieVisible = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const statusText = ref('')

/** True when a usable credential is already on the device. */
const hasStored = ref(false)

/**
 * Device capability, read through the store so both screens share one answer.
 *
 * Probing means calling into the SOTER bridge, and on a build that did not
 * bundle the module that call raises a dialog the user cannot dismiss. The
 * store therefore only probes once the user opted in — a build without the
 * module is never probed automatically and degrades to the form silently.
 *
 * Asynchronous because the bridge is; a synchronous reader would always see the
 * state from before the callback and report a Face-ID phone as unsupported.
 *
 * `probeSupport()` is re-run on every `onShow`: a user who leaves to enrol a
 * face and comes straight back must not be told the device still cannot do it.
 */
async function probeSupport(): Promise<BiometricSupport> {
  // Only probe when the feature is in play. An opted-out user never touches the
  // bridge, which is what keeps a module-less build from raising a dialog.
  if (!biometric.enabled && biometric.support === 'unknown') {
    return 'unsupported'
  }

  return biometric.refreshSupport()
}

const canSubmit = computed(() => {
  if (!baseUrl.value.trim())
    return false

  return useCookieMode.value
    ? Boolean(adminCookie.value.trim())
    : Boolean(username.value.trim() && password.value.trim())
})

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

/**
 * Confirms the stored credential still works before letting the user in.
 *
 * The classification itself lives in `utils/unlock-verdict.ts`: it is a decision
 * about an error, and keeping it as a pure function is what makes it testable
 * without a network. This wrapper only supplies the request.
 */
async function verifyStored(): Promise<StoredVerdict> {
  try {
    await fetchSessions(1_440)
    return classifyStoredCredential(null)
  }
  catch (error) {
    return classifyStoredCredential(error)
  }
}

/**
 * Extends the stored session, and stores the replacement.
 *
 * Returns the new token, or an empty string when the gateway would not renew —
 * which includes the case that matters most: the session has already lapsed, so
 * there is nothing left to extend and the user genuinely must sign in again.
 *
 * The write is deliberately synchronous-through-`setAdminCookie` rather than a
 * direct assignment: that setter is what normalises the value and recomputes
 * `isLoggedIn`, and the persisted snapshot is taken from the store by the Pinia
 * plugin, so the new token is on disk by the time the next launch reads it.
 */
async function renewStoredSession(): Promise<string> {
  try {
    const token = await renewSession()

    if (token) {
      auth.setAdminCookie(token)
    }

    return token
  }
  catch {
    // A failed renewal is not fatal on its own — the session may well still be
    // valid and simply could not be extended this time. The caller decides,
    // based on whether the credential itself still works.
    return ''
  }
}

async function unlock() {
  if (busy.value)
    return

  busy.value = true
  errorMessage.value = ''
  statusText.value = '正在验证…'

  const result = await authenticateBiometric('验证身份以进入 HDdaraAi')

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

  // Renewed *before* the read rather than after it, so a session that is about
  // to lapse is extended while it is still valid. The other order would work
  // only while the token has life left in it; once it has lapsed the renewal is
  // exactly the call that would be rejected.
  await renewStoredSession()

  const verdict = await verifyStored()

  if (verdict === 'valid') {
    enterApp()
    return
  }

  busy.value = false
  statusText.value = ''

  // The biometric did its job; what failed is the credential. Dropped back to
  // the form, because that is the only route left — but with wording that says
  // the identity check succeeded, since the old sentence arrived seconds after a
  // successful face scan and read as though the scan had failed.
  if (verdict === 'rejected') {
    hasStored.value = false
  }

  // `unreachable` deliberately does *not* clear `hasStored`: the credential is
  // not known to be bad, only unverifiable, so the lock screen stays put with
  // the retry button the user already knows how to press.
  errorMessage.value = describeUnlockFailure(verdict)
}

async function signIn() {
  if (!canSubmit.value || busy.value)
    return

  busy.value = true
  errorMessage.value = ''
  statusText.value = useCookieMode.value ? '正在验证凭据…' : '正在登录…'

  auth.setBaseUrl(baseUrl.value.trim())
  // Typing an address here is the same explicit signal as saving it on the
  // settings page: a previous failed probe must not keep it benched, or the
  // user would type a working address and still be routed elsewhere.
  clearManualBaseUrlVerdict(baseUrl.value.trim())

  try {
    if (useCookieMode.value) {
      auth.setAdminCookie(adminCookie.value.trim())
      // Confirm the pasted cookie works before letting the user in.
      await fetchSessions(1_440)
    }
    else {
      const result = await loginWithPassword(
        username.value.trim(),
        password.value,
      )
      const token = String(result?.token ?? '').trim()

      if (!token) {
        // The server only returns the token to clients that declare themselves
        // cookie-incapable. Getting here means it decided otherwise, and
        // without a token there is nothing to authenticate subsequent calls
        // with — so say so instead of appearing to succeed.
        throw new Error('网关未返回会话令牌，请确认服务端版本已支持 App 登录')
      }

      auth.setAdminCookie(token)
      // Clear the plaintext password the moment it is no longer needed.
      password.value = ''
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '登录失败'

    auth.logout()
    // Detected by status, not by wording: a wrong password is answered with
    // `401 Invalid password`, so matching on the gateway's phrasing passed the
    // English message straight through to a Chinese form.
    errorMessage.value = isAuthError(error)
      ? (useCookieMode.value
          ? '凭据无效，请检查控制台 Cookie'
          : '账号或密码不正确')
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

/** Switches between the account form and the advanced cookie entry. */
function toggleCookieMode() {
  useCookieMode.value = !useCookieMode.value
  errorMessage.value = ''
  statusText.value = ''
  adminCookie.value = ''
  password.value = ''
}

function enterApp() {
  busy.value = false
  statusText.value = ''

  // Marks this launch as unlocked, which is what the page guards check.
  auth.unlock()

  // A launch that named a destination is honoured here — after the unlock, not
  // before it. Claiming clears it, so this cannot send a later unlock back to
  // the same page.
  const requested = consumePendingRoute()

  // `reLaunch` rather than `navigateTo`: the lock screen must not stay on the
  // stack, or "back" would return to it while the session is live.
  uni.reLaunch({ url: requested ? `/${requested}` : '/pages/sessions/index' })
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
 *
 * `enabled` is read through the store so the template stays declarative.
 */
const biometricEnabled = computed(() => biometric.enabled)

/**
 * The switch's label, named for this device's actual sensor.
 *
 * "指纹 / 面容解锁" named both at once, which on an iPhone points at a settings
 * page that does not exist. A computed so the bridge probe runs once.
 */
const biometricTitle = computed(() => biometricLabel(true))

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
  password.value = ''

  try {
    biometric.loadEnabled()
  }
  catch {
    biometric.setEnabled(false)
  }

  if (!(await loadStored()))
    return

  if (!biometric.enabled)
    return

  const capability = await probeSupport()

  if (capability === 'available') {
    // Present the prompt straight away; a stored credential is the common case
    // and making the user tap first would be an extra step every launch.
    void unlock()
  }
  else if (capability === 'unavailable') {
    statusText.value = `未设置${biometricLabel()}，请在下方确认凭据`
  }
})

/**
 * Enters using the credential already on the device.
 *
 * Reached only by an explicit press. This is the path for a build without the
 * fingerprint module: the user still has to act on the lock screen, they just
 * are not asked to retype a 43-character token to get back into their own app.
 *
 * Renewed here too. This path exists precisely for the devices that cannot do
 * biometrics, and leaving it unrenewed would make it the one way to use the app
 * that still hits the 8-hour cliff.
 */
async function enterWithStored() {
  if (busy.value)
    return

  busy.value = true
  errorMessage.value = ''
  statusText.value = '正在确认登录状态…'

  await renewStoredSession()

  const verdict = await verifyStored()

  if (verdict === 'valid') {
    enterApp()
    return
  }

  busy.value = false
  statusText.value = ''

  if (verdict === 'rejected') {
    hasStored.value = false
  }

  errorMessage.value = describeUnlockFailure(verdict)
}

/** Switches to the form, with an empty credential field. */
function useCredentialForm() {
  adminCookie.value = ''
  password.value = ''
  errorMessage.value = ''
  statusText.value = ''
  hasStored.value = false
  // Always start on the account form: it is the path a user can complete.
  useCookieMode.value = false
}

/**
 * Flips the opt-in, proving the device can actually do it before turning on.
 *
 * Turning it on is a promise that every future launch will ask for a face or
 * finger. `biometricSupport()` only says a bridge exists, so the switch used to
 * be settable on a device whose prompt would then always fail — discovered on
 * the *next* cold start, long after the press that caused it. A real
 * authentication here makes the promise honest.
 *
 * Turning it off never prompts: leaving must not be gated behind the thing you
 * are trying to stop using.
 */
async function toggleBiometric() {
  errorMessage.value = ''

  if (biometricEnabled.value) {
    biometric.disable()
    uni.showToast({ icon: 'none', title: '已关闭快速解锁' })
    return
  }

  if (busy.value)
    return

  busy.value = true

  // Probed (and re-probed) right before the attempt: the store may hold a stale
  // 'unavailable' from before the user enrolled a face in system settings.
  const capability = await probeSupport()

  if (capability !== 'available') {
    busy.value = false
    errorMessage.value = describeBiometricFailure(capability)
    return
  }

  statusText.value = '等待验证…'
  const failure = await biometric.enableWithConfirmation()
  busy.value = false
  statusText.value = ''

  if (!failure) {
    uni.showToast({ icon: 'none', title: '已开启快速解锁' })
    return
  }

  // A cancel is not an error — the user simply changed their mind, and saying
  // anything about it would be noise.
  if (failure.reason !== 'cancelled') {
    errorMessage.value = failure.message || describeBiometricFailure(capability)
  }
}

/**
 * Re-reads the capability whenever this screen is shown.
 *
 * The common path is: user turns the switch on, is told to enrol a face, leaves
 * for Settings and comes back. Without this the stale `'unavailable'` would
 * still be displayed and the switch would refuse to turn on.
 */
onShow(() => {
  if (!biometric.enabled) {
    return
  }

  void syncCapability()
})

/** Re-reads the capability and refreshes the status line it drives. */
async function syncCapability(): Promise<void> {
  const capability = await probeSupport()

  if (capability === 'unavailable') {
    statusText.value = `未设置${biometricLabel()}，请在下方确认凭据`
  }
  else if (capability === 'available' && statusText.value.startsWith('未设置')) {
    // The user fixed it; clear the stale complaint rather than leaving it up.
    statusText.value = ''
  }
}
</script>

<template>
  <view class="page" :class="themeClass">
    <view class="brand">
      <view class="brand-mark">
        <view class="brand-bubble">
          <view class="brand-line brand-line-1" />
          <view class="brand-line brand-line-2" />
        </view>
      </view>
      <text class="brand-name">HDdaraAi</text>
      <text class="brand-sub">查看 AI 会话状态</text>
    </view>

    <!-- Unlock path -->
    <AppCard v-if="hasStored" class="card">
      <text class="card-title">欢迎回来</text>
      <text class="card-hint">
        {{ biometricEnabled ? '使用指纹或面容快速解锁' : '已保存登录信息' }}
      </text>

      <!-- A <button> rather than a tappable <view>: on the App runtime a tap that
           lands on a child <text> does not reliably reach a handler bound to the
           parent view, which is why tapping the row did nothing. -->
      <button class="switch-row" @tap="toggleBiometric">
        <view class="switch-body">
          <text class="switch-label">{{ biometricTitle }}</text>
          <text class="switch-hint">
            开启后每次启动需验证身份才能查看会话
          </text>
        </view>
        <AppSwitch :on="biometricEnabled" />
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
    </AppCard>

    <!-- Credential path -->
    <AppCard v-else class="card">
      <text class="card-title">登录</text>
      <text class="card-hint">
        {{ useCookieMode
          ? '粘贴控制台会话 Cookie。仅当你有办法从浏览器取出它时才使用这种方式。'
          : '使用控制台账号登录。网关地址默认已填好，通常无需改动。' }}
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

      <template v-if="!useCookieMode">
        <view class="field">
          <text class="field-label">账号</text>
          <input
            v-model="username"
            class="input"
            placeholder="admin"
            type="text"
          >
        </view>

        <view class="field">
          <view class="field-head">
            <text class="field-label">密码</text>
            <button class="field-toggle" @tap="toggleCookieVisible">
              {{ cookieVisible ? '隐藏' : '显示' }}
            </button>
          </view>
          <input
            v-model="password"
            class="input"
            :password="!cookieVisible"
            placeholder="控制台登录密码"
            type="text"
          >
        </view>
      </template>

      <view v-else class="field">
        <view class="field-head">
          <text class="field-label">控制台 Cookie</text>
          <button class="field-toggle" @tap="toggleCookieVisible">
            {{ cookieVisible ? '隐藏' : '显示' }}
          </button>
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

      <button class="ghost" @tap="toggleCookieMode">
        {{ useCookieMode ? '改用账号密码登录' : '改用 Cookie 登录（高级）' }}
      </button>
    </AppCard>

    <view class="footnote">
      凭据仅保存在本机，用于访问你自己的网关。
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: 120rpx 48rpx 60rpx;
  box-sizing: border-box;
  background-color: $color-page;
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
  /* Not a token: this is the app icon's own corner, drawn as one piece with the
     glyph inside it and sized with the mark. Sharing a radius token with the
     controls would tie the icon's shape to the button scale, which is not a
     relationship that exists. Diameter ÷ 4 is the icon's own proportion. */
  border-radius: 32rpx;
  /* The one place a gradient is allowed: this is the brand mark itself, the
     same artwork that ships as the app icon (design spec 2.3.4). */
  background: linear-gradient(160deg, #0a84ff, #005cd6);
}

.brand-bubble {
  width: 68rpx;
  padding: 16rpx 14rpx 22rpx;
  border-radius: $radius-control;
  background-color: $color-surface;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.brand-line {
  height: 8rpx;
  border-radius: $radius-chip;
  background-color: $color-primary;
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
  color: $color-text;
}

.brand-sub {
  margin-top: 8rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

.card {
  padding: 36rpx 32rpx;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.card-title {
  display: block;
  font-size: $font-title;
  font-weight: 600;
  color: $color-text;
}

.card-hint {
  display: block;
  margin-top: 10rpx;
  font-size: $font-meta;
  color: $color-text-muted;
  line-height: 1.65;
}

/* A <button> carries a default background, border, radius and centring on both
   platforms; all of it is reset here so the row reads as a list item. */
.switch-row {
  display: flex;
  align-items: center;
  gap: $gap-section;
  width: 100%;
  margin: 32rpx 0 0;
  padding: $gap-page 0;
  border: none;
  border-top: 1rpx solid $color-border-strong;
  border-bottom: 1rpx solid $color-border-strong;
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
  font-size: $font-section;
  color: $color-text;
}

.switch-hint {
  display: block;
  margin-top: 6rpx;
  font-size: $font-micro;
  color: $color-text-faint;
  line-height: 1.55;
}

/* The switch itself lives in `AppSwitch.vue`: the settings page offers the same
   opt-in and had drawn its own at a different size. */

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
  margin-bottom: $gap-inline;
  font-size: $font-label;
  color: $color-text-secondary;
}

.field-toggle {
  font-size: $font-meta;
  color: $color-primary;
  display: inline-block;
  width: auto;
  margin: 0;
  padding: 4rpx 12rpx;
  line-height: 1.5;
  background-color: transparent;
}

.field-toggle::after {
  border: none;
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

.error {
  margin-top: $gap-page;
  padding: 18rpx $gap-section;
  border-radius: $radius-control;
  background-color: $color-danger-surface;
  font-size: $font-label;
  color: $color-danger;
  line-height: 1.6;
}

.status {
  margin-top: $gap-page;
  font-size: $font-label;
  color: $color-text-muted;
}

/* The page's one primary action. Everything below is secondary by design
   (design spec 3.1.2) — two solid buttons would make the user read the labels
   to find out which one they came here for. */
.primary {
  margin-top: 36rpx;
  height: $height-control;
  line-height: $height-control;
  border-radius: $radius-control;
  background-color: $color-primary;
  color: $color-surface;
  font-size: $font-section;
}

.primary[disabled] {
  background-color: $color-primary-disabled;
  color: $color-surface;
}

.ghost {
  margin-top: $gap-section;
  height: $height-control;
  line-height: $height-control;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  color: $color-text-secondary;
  font-size: $font-section;
}

.footnote {
  margin-top: 40rpx;
  font-size: $font-micro;
  color: $color-text-faint;
  text-align: center;
  line-height: 1.7;
}
</style>
