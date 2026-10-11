<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'

import { clearManualBaseUrlVerdict } from '@/api/core/base-url'
import { clearTranscripts as clearStoredTranscripts } from '@/api/sessions'
import { useAuthStore } from '@/store/authStore'
import { parseStored } from '@/store/persist'
import { ensureUnlocked } from '@/utils/app-guard'
import { getAppVersion } from '@/utils/app-info'
import { describeError } from '@/utils/errors'

definePage({
  name: 'settings',
  style: { navigationBarTitleText: '设置' },
})

const auth = useAuthStore()

/**
 * The gateway-side screens, in the order a user is likely to want them.
 *
 * Declared here rather than as markup repeated four times, so the icon, the
 * label and the destination stay in one place — the three drifted apart in the
 * console's own navigation for exactly this reason.
 */
const accountEntries = [
  {
    hint: '登录方式、修改密码、通行密钥',
    icon: 'i-carbon:user-avatar',
    label: '账户管理',
    path: '/pages/account/index',
  },
  {
    hint: '剩余额度、套餐明细、每日签到',
    icon: 'i-carbon:chart-line-data',
    label: '账户数据',
    path: '/pages/account/usage',
  },
  {
    hint: '上游账号的轮询、限流与模型',
    icon: 'i-carbon:credentials',
    label: '凭证管理',
    path: '/pages/credentials/index',
  },
] as const

/**
 * Opens one of the account sub-pages.
 *
 * A method rather than `uni.navigateTo` in the template: `uni` is a runtime
 * global and the template scope does not have it, so the call there silently
 * resolves to nothing and the row appears dead.
 */
function openAccountPage(path: string) {
  uni.navigateTo({ url: path })
}

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

/**
 * The running version, from the same source the gateway is told about.
 *
 * The page used to carry a literal (`HDdaraAi v0.1.0`), which no release ever
 * updated — the app would report one version to the gateway and show another to
 * the person holding it, which is the exact contradiction `app-info` documents
 * having been reported before.
 */
const appVersion = getAppVersion() || '未知'

const storageProbe = ref('')

/**
 * Storage state, in the app's own words.
 *
 * The line exists because a production build's sandbox cannot be inspected from
 * `adb`, so "did the credential actually land on disk" has to be answerable from
 * the device. It used to print `存储：cookie(43) / https://…` — a debug dump: the
 * address is already in the field above it, and a character count is not
 * something a user asked for.
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

const clearing = ref(false)

/**
 * Clears the gateway's stored turns, after confirming.
 *
 * Destructive and server-side, so it gets its own section instead of sitting
 * next to the credential buttons — and it is the app's answer to a history that
 * cannot be repaired: turns stored before the gateway read `<user_query>` first
 * hold a prompt instead of a question, and nothing on the device can rewrite
 * them.
 */
function confirmClearTranscripts() {
  uni.showModal({
    cancelText: '取消',
    confirmText: '清空',
    content: '将删除网关上保存的全部问答记录（所有会话），无法恢复。',
    success: async (result) => {
      if (!result.confirm)
        return

      clearing.value = true

      try {
        const removed = await clearStoredTranscripts()
        uni.showToast({ icon: 'none', title: `已清空 ${removed} 条记录` })
      }
      catch (error) {
        uni.showToast({ icon: 'none', title: describeError(error, '清空失败') })
      }
      finally {
        clearing.value = false
      }
    },
    title: '清空会话记录',
  })
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
        <button class="section-toggle" @tap="toggleCookieVisible">
          {{ cookieVisible ? '隐藏' : '显示' }}
        </button>
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
      <!-- The tick carries the "it worked" reading on its own, so the state is
           legible without parsing the sentence beside it. -->
      <view v-if="saved" class="status-saved">
        <view class="status-icon i-carbon:checkmark" />
        <text>{{ persistStatus || '已保存' }}</text>
      </view>
    </view>
    <view v-if="storageProbe" class="status">
      <view class="status-saved">
        <view class="status-icon i-carbon:checkmark" />
        <text>{{ storageProbe }}</text>
      </view>
    </view>

    <view class="section">
      <text class="section-title">账户与凭据</text>
      <text class="section-hint">
        网关侧的账户设置。凭据是真实的上游账号，访问密钥是给客户端用的令牌。
      </text>

      <!-- Rows rather than one button per destination: they are all the same
           kind of thing (a sub-page), and the chevron says so. -->
      <button
        v-for="entry in accountEntries"
        :key="entry.path"
        class="nav-row"
        @tap="openAccountPage(entry.path)"
      >
        <view class="nav-icon" :class="entry.icon" />
        <view class="nav-body">
          <text class="nav-label">{{ entry.label }}</text>
          <text class="nav-hint">{{ entry.hint }}</text>
        </view>
        <view class="nav-chevron i-carbon:chevron-right" />
      </button>
    </view>

    <view class="section">
      <text class="section-title">会话记录</text>
      <text class="section-hint">
        网关保存的每次问答构成 App 里的历史列表。清空后无法恢复，
        但之后的问答会继续记录。
      </text>
      <button class="danger" :disabled="clearing" @tap="confirmClearTranscripts">
        {{ clearing ? '清空中…' : '清空会话记录' }}
      </button>
    </view>

    <view class="about">
      <text class="about-title">HDdaraAi v{{ appVersion }}</text>
      <text class="about-text">
        用于随时查看 AI 会话状态。会话列表与实时输出来自网关的
        /admin-api/sessions 接口。
      </text>
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  background-color: $color-page;
  padding: $gap-page;
  box-sizing: border-box;
}

.section {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.section-title {
  display: block;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
  margin-bottom: $gap-inline;
}

.section-hint {
  display: block;
  font-size: $font-meta;
  color: $color-text-muted;
  line-height: 1.6;
  margin-bottom: 16rpx;
}

/* 说明文字独立成段：贴在按钮下方，不再依赖所在 section 的下间距。 */
.hint-block {
  margin: 16rpx 8rpx 0;
}

.input {
  width: 100%;
  height: $height-control;
  padding: 0 20rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  font-size: $font-label;
  color: $color-text;
}

/* 标题与「显示/隐藏」同排；标题原有的下间距在这里由容器承担。 */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $gap-inline;
}

.section-head .section-title {
  margin-bottom: 0;
}

.section-toggle {
  font-size: $font-meta;
  color: $color-primary;
  display: inline-block;
  width: auto;
  margin: 0;
  padding: 4rpx 12rpx;
  line-height: 1.5;
  background-color: transparent;
}

.section-toggle::after {
  border: none;
}

.actions {
  display: flex;
  gap: $gap-section;
  margin-top: 8rpx;
}

/* `.ghost` sits next to it, so only one of the pair is solid (spec 3.1.2). */
.primary {
  flex: 1;
  background-color: $color-primary;
  color: $color-surface;
  font-size: $font-section;
  border-radius: $radius-control;
}

/* Dimmed rather than merely inert, so the state is visible before the tap. */
.primary[disabled] {
  background-color: $color-primary-disabled;
  color: $color-surface;
}

.ghost {
  flex: 1;
  background-color: $color-surface;
  color: $color-text-secondary;
  font-size: $font-section;
  border-radius: $radius-control;
  border: 1rpx solid $color-border;
}

/* Destructive: white surface with red text, so it cannot be mistaken for the
   primary action it sits near. */
.danger {
  width: 100%;
  background-color: $color-surface;
  color: $color-danger;
  font-size: $font-section;
  border-radius: $radius-control;
  border: 1rpx solid $color-border;
}

.danger[disabled] {
  color: $color-text-faint;
}

.status {
  display: flex;
  justify-content: space-between;
  padding: $gap-page 8rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

.status-saved {
  display: flex;
  align-items: center;
  gap: 6rpx;
  color: $color-success;
}

.status-icon {
  width: 26rpx;
  height: 26rpx;
}

/* Reset the platform button chrome so a row reads as a list item, the same
   treatment the login page's switch row needed. */
.nav-row {
  display: flex;
  align-items: center;
  gap: $gap-section;
  width: 100%;
  margin: 0;
  padding: $gap-page 0;
  border: none;
  border-bottom: 1rpx solid $color-border-strong;
  border-radius: 0;
  background-color: transparent;
  line-height: normal;
  text-align: left;
}

.nav-row:last-child {
  border-bottom: none;
}

.nav-row::after {
  border: none;
}

.nav-icon {
  flex: none;
  width: 40rpx;
  height: 40rpx;
  color: $color-primary;
}

.nav-body {
  flex: 1;
  min-width: 0;
}

.nav-label {
  display: block;
  font-size: $font-label;
  color: $color-text;
}

.nav-hint {
  display: block;
  margin-top: 4rpx;
  font-size: $font-micro;
  color: $color-text-muted;
}

.nav-chevron {
  flex: none;
  width: 32rpx;
  height: 32rpx;
  color: $color-text-faint;
}

.about {
  margin-top: 40rpx;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.about-title {
  display: block;
  font-size: $font-label;
  font-weight: 600;
  color: $color-text;
  margin-bottom: 10rpx;
}

.about-text {
  font-size: $font-meta;
  color: $color-text-muted;
  line-height: 1.7;
}
</style>
