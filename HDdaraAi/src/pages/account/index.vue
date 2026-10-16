<script setup lang="ts">
import type { AdminSessionSummary, StoredPasskey } from '@/api/account'
import { onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  beginPasskeyRegistration,
  changeAdminPassword,
  deletePasskey,
  fetchAdminSession,
  fetchPasskeys,
  finishPasskeyRegistration,
  logoutAdminSession,
} from '@/api/account'
import { consoleErrorMessage } from '@/api/core/console'
import { useNativeChrome } from '@/composables/useNativeChrome'
import { useAuthStore } from '@/store/authStore'
import { ensureUnlocked } from '@/utils/app-guard'
import { formatRelative } from '@/utils/format'
import {
  createPasskeyCredential,
  isUserCancellation,
  webAuthnUnsupportedReason,
} from '@/utils/webauthn'

definePage({
  name: 'account',
  style: { navigationBarTitleText: '账户管理' },
})

// Repaints this page's native title bar; it is per-webview and would
// otherwise revert to the light default on each navigation.
useNativeChrome()
const auth = useAuthStore()

/** See the note in `settings/index.vue`: component-scoped so it stays reactive. */
const { t } = useI18n()

const session = ref<AdminSessionSummary | null>(null)
const passkeys = ref<StoredPasskey[]>([])
const loading = ref(true)
const errorMessage = ref('')
const busy = ref(false)

/** Result of a write, shown under the form that produced it. */
const notice = ref('')

const currentPassword = ref('')
const nextPassword = ref('')
const nextUsername = ref('')
const passwordVisible = ref(false)
const confirmLogout = ref(false)

/**
 * Why passkey registration cannot be offered here, or `null` when it can.
 *
 * Resolved once rather than per render: it reads `navigator` and
 * `window.isSecureContext`, neither of which changes while the page is open, and
 * a computed would re-evaluate on unrelated state changes.
 */
const passkeyBlockedKey = webAuthnUnsupportedReason()

/** The same reason, translated — and reactive, unlike the probe above. */
const passkeyBlockedReason = computed(() =>
  passkeyBlockedKey ? t(passkeyBlockedKey) : '',
)

const registering = ref(false)
const draftPasskeyName = ref('')

/**
 * The username field is prefilled from the session, and a blank one is sent as
 * "leave it alone" rather than "clear it" — the server treats an absent username
 * as unchanged, so a user editing only the password cannot accidentally rename
 * the account to nothing.
 */
const usernameChanged = computed(
  () =>
    Boolean(session.value)
    && nextUsername.value.trim() !== ''
    && nextUsername.value.trim() !== session.value?.username,
)

/**
 * Only the password being non-empty is required to submit.
 *
 * A rename without a password change is not offered: the server verifies the
 * current password on every call, so asking for one field and checking two
 * would just move the error further away.
 */
const canSubmit = computed(
  () =>
    currentPassword.value.length > 0
    && (nextPassword.value.length > 0 || usernameChanged.value),
)

const passwordTooShort = computed(
  () => nextPassword.value.length > 0 && nextPassword.value.trim().length < 8,
)

async function load() {
  loading.value = true
  errorMessage.value = ''

  try {
    const [sessionPayload, passkeyList] = await Promise.all([
      fetchAdminSession(),
      // Passkeys need an authenticated session and fail without one; the list is
      // secondary to the page, so a failure here must not blank the whole screen.
      fetchPasskeys().catch(() => [] as StoredPasskey[]),
    ])

    session.value = sessionPayload.session
    passkeys.value = passkeyList
    nextUsername.value = sessionPayload.session.username
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取账户信息失败')
  }
  finally {
    loading.value = false
  }
}

async function submitPassword() {
  if (!canSubmit.value || busy.value || passwordTooShort.value) {
    return
  }

  busy.value = true
  notice.value = ''
  errorMessage.value = ''

  try {
    await changeAdminPassword({
      currentPassword: currentPassword.value,
      ...(nextPassword.value ? { nextPassword: nextPassword.value } : {}),
      ...(usernameChanged.value ? { username: nextUsername.value.trim() } : {}),
    })

    // The server drops every other session on success, so this device's own
    // session is the only one left — saying so is the difference between a
    // change that worked and one the user thinks half-failed.
    notice.value = '已保存。其它设备上的登录已失效，需要重新登录。'
    currentPassword.value = ''
    nextPassword.value = ''
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '保存失败')
  }
  finally {
    busy.value = false
  }
}

async function removePasskey(passkey: StoredPasskey) {
  if (busy.value) {
    return
  }

  busy.value = true
  errorMessage.value = ''
  notice.value = ''

  try {
    await deletePasskey(passkey.id)
    notice.value = `已删除「${passkey.name}」`
    await load()
  }
  catch (error) {
    // The server refuses to drop the last passkey while no password is set, and
    // its wording says exactly what to do — so it is shown rather than replaced.
    errorMessage.value = consoleErrorMessage(error, '删除失败')
  }
  finally {
    busy.value = false
  }
}

function beginRegisterPasskey() {
  notice.value = ''
  errorMessage.value = ''
  draftPasskeyName.value = ''
  registering.value = true
}

/**
 * Registers a passkey.
 *
 * Three steps that must not be reordered or merged: ask for a challenge, run the
 * browser ceremony, hand the attestation back. The middle one is the only part
 * the user sees, and it is also the one that fails in the ordinary course of
 * things — a dismissed sheet is a cancellation, not an error, and reporting it as
 * one would put a red banner on a successful no-op.
 */
async function submitRegisterPasskey() {
  if (busy.value) {
    return
  }

  busy.value = true
  errorMessage.value = ''
  notice.value = ''

  try {
    const begun = await beginPasskeyRegistration(draftPasskeyName.value.trim())
    const response = await createPasskeyCredential(begun.options)

    // The server's echoed name, not the input: it applied the `Passkey N`
    // fallback for a blank field, and the record is stored under that.
    await finishPasskeyRegistration(begun.name, response)

    registering.value = false
    notice.value = `${t('account.passkeyRegisteredPrefix')}${begun.name}${t('account.passkeyRegisteredSuffix')}`
    await load()
  }
  catch (error) {
    if (isUserCancellation(error)) {
      // Kept open with the typed name intact: cancelling usually means the user
      // meant to pick a different authenticator, and retyping the name is friction
      // for no reason.
      errorMessage.value = t('account.passkeyCancelled')
    }
    else {
      errorMessage.value = consoleErrorMessage(error, t('account.passkeyFailed'))
    }
  }
  finally {
    busy.value = false
  }
}

async function signOut() {
  if (busy.value) {
    return
  }

  busy.value = true
  errorMessage.value = ''

  try {
    await logoutAdminSession()
    auth.logout()
    auth.lock()
    uni.reLaunch({ url: '/pages/login/index' })
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '退出登录失败')
    busy.value = false
  }
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

    <AppSkeleton v-else-if="loading" :rows="3" />

    <template v-else>
      <view class="section">
        <text class="section-title">账户</text>

        <view class="row">
          <text class="row-label">用户名</text>
          <text class="row-value">{{ session?.username || '—' }}</text>
        </view>
        <view class="row">
          <text class="row-label">密码</text>
          <text class="row-value">
            {{ session?.passwordConfigured ? '已设置' : '未设置' }}
          </text>
        </view>
        <view class="row">
          <text class="row-label">通行密钥</text>
          <text class="row-value">{{ passkeys.length }} 个</text>
        </view>
        <view class="row row-last">
          <text class="row-label">登录保护</text>
          <!-- `warning` rather than `muted` when off: the console being open to
               anyone who can reach the gateway is a state worth noticing. -->
          <StatusTag :tone="session?.authEnabled ? 'success' : 'warning'">
            {{ session?.authEnabled ? '已开启' : '已关闭' }}
          </StatusTag>
        </view>

        <text
          v-if="session && !session.authEnabled"
          class="section-hint"
        >
          未开启登录保护时，任何能访问网关的人都可以查看会话与账户数据。
        </text>
      </view>

      <view class="section">
        <text class="section-title">修改密码 / 用户名</text>
        <text class="section-hint">
          需要验证当前密码。保存后其它设备上的登录会失效。
        </text>

        <view class="field">
          <text class="field-label">当前密码</text>
          <input
            v-model="currentPassword"
            class="input"
            :password="!passwordVisible"
            placeholder="用于验证身份"
            type="text"
          >
        </view>

        <view class="field">
          <view class="field-head">
            <text class="field-label">新密码</text>
            <button class="field-toggle" @tap="passwordVisible = !passwordVisible">
              {{ passwordVisible ? '隐藏' : '显示' }}
            </button>
          </view>
          <input
            v-model="nextPassword"
            class="input"
            :password="!passwordVisible"
            placeholder="至少 8 位，留空则不修改"
            type="text"
          >
          <text v-if="passwordTooShort" class="field-error">密码至少 8 位</text>
        </view>

        <view class="field">
          <text class="field-label">用户名</text>
          <input
            v-model="nextUsername"
            class="input"
            placeholder="3–64 位，留空则不修改"
            type="text"
          >
        </view>

        <AppButton
          variant="solid"
          block
          :disabled="!canSubmit || passwordTooShort || busy"
          @tap="submitPassword"
        >
          {{ busy ? '保存中…' : '保存' }}
        </AppButton>

        <view v-if="notice" class="notice">
          <view class="notice-icon i-carbon:checkmark" />
          <text>{{ notice }}</text>
        </view>
      </view>

      <view class="section">
        <text class="section-title">{{ t('account.passkeys') }}</text>
        <text class="section-hint">
          通行密钥在注册它的设备上使用。删除后该设备无法再凭它登录。
        </text>

        <StateBlock
          v-if="!passkeys.length && !registering"
          variant="plain"
          icon="i-carbon:password"
          :text="t('account.passkeyEmpty')"
          :hint="passkeyBlockedReason || t('account.passkeyEmptyHint')"
        />

        <view v-else-if="passkeys.length" class="key-list">
          <view v-for="item in passkeys" :key="item.id" class="key-row">
            <view class="key-body">
              <text class="key-name">{{ item.name }}</text>
              <text class="key-meta">
                {{ item.deviceType || '未知设备' }}
                <template v-if="item.createdAt">
                  · {{ formatRelative(item.createdAt) }}注册
                </template>
                <template v-if="item.backedUp"> · 已同步</template>
              </text>
            </view>
            <button class="key-remove" @tap="removePasskey(item)">
              删除
            </button>
          </view>
        </view>

        <!-- The name is optional server-side, but asking turns a row of
             indistinguishable `Passkey 3` entries into a list a user can act on. -->
        <view v-if="registering" class="field">
          <text class="field-label">{{ t('account.passkeyName') }}</text>
          <input
            v-model="draftPasskeyName"
            class="input"
            :placeholder="t('account.passkeyNamePlaceholder')"
            type="text"
          >
          <text class="field-hint">
            {{ t('account.passkeyNameHint') }}
          </text>
          <view class="register-actions">
            <AppButton variant="tonal" @tap="registering = false">
              {{ t('common.cancel') }}
            </AppButton>
            <AppButton variant="solid" :disabled="busy" @tap="submitRegisterPasskey">
              {{ busy ? t('account.passkeyRegistering') : t('account.passkeyStart') }}
            </AppButton>
          </view>
        </view>

        <template v-else-if="passkeyBlockedReason">
          <text class="section-hint blocked-hint">{{ passkeyBlockedReason }}</text>
        </template>

        <AppButton
          v-else
          variant="solid"
          block
          :disabled="busy"
          @tap="beginRegisterPasskey"
        >
          {{ t('account.addPasskey') }}
        </AppButton>
      </view>

      <view class="section">
        <text class="section-title">退出登录</text>
        <text class="section-hint">
          只退出这台设备。账户与凭据都保留，其它设备继续可用。
        </text>

        <template v-if="confirmLogout">
          <view class="confirm">
            <text class="confirm-text">确定要退出登录吗？</text>
            <view class="confirm-actions">
              <AppButton variant="tonal" @tap="confirmLogout = false">
                取消
              </AppButton>
              <AppButton variant="solid" tone="danger" @tap="signOut">
                退出
              </AppButton>
            </view>
          </view>
        </template>
        <AppButton
          v-else
          variant="tonal"
          tone="danger"
          block
          @tap="confirmLogout = true"
        >
          退出登录
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
  /* Sub-page: nothing is drawn over the webview, but the home indicator still
     sits on top of the final card on notched devices. */
  padding-bottom: $gap-page-bottom;
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

/* Label left, value right: the reader scans one column of labels and one of
   values, instead of parsing a sentence per row. */
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
}

.field {
  margin-top: 20rpx;
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

.field-error {
  display: block;
  margin-top: 10rpx;
  font-size: $font-meta;
  color: $color-danger;
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

.notice {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-top: $gap-section;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-success;
}

.notice-icon {
  flex: none;
  width: 28rpx;
  height: 28rpx;
}

.key-list {
  margin-top: 8rpx;
}

.key-row {
  display: flex;
  align-items: center;
  gap: $gap-section;
  padding: $gap-inline 0;
  border-bottom: 1rpx solid $color-border-strong;
}

.key-row:last-child {
  border-bottom: none;
}

.key-body {
  flex: 1;
  min-width: 0;
}

.key-name {
  display: block;
  font-size: $font-label;
  color: $color-text;
}

.key-meta {
  display: block;
  margin-top: 6rpx;
  font-size: $font-micro;
  color: $color-text-muted;
}

.key-remove {
  flex: none;
  width: auto;
  margin: 0;
  padding: 6rpx 20rpx;
  border: 1rpx solid $color-border;
  border-radius: $radius-pill;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-danger;
  background-color: transparent;
}

.key-remove::after {
  border: none;
}

/* Dimmed rather than hidden: an unavailable feature with no explanation reads as
   a bug, and this one has a specific cause worth naming. */
.blocked-hint {
  margin-top: 8rpx;
  margin-bottom: 0;
}

.register-actions {
  display: flex;
  gap: $gap-section;
  margin-top: $gap-section;
}

.confirm {
  padding: $gap-page;
  border-radius: $radius-control;
  background-color: $color-danger-surface;
}

.confirm-text {
  display: block;
  margin-bottom: 16rpx;
  font-size: $font-label;
  color: $color-danger;
}

.confirm-actions {
  display: flex;
  gap: $gap-section;
}
</style>
