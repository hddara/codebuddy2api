<script setup lang="ts">
import type { ThemePreference } from '@/store/themeStore'
import { onShow } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'

import { useI18n } from 'vue-i18n'
import { clearTranscripts as clearStoredTranscripts } from '@/api/sessions'
import AppTabBar from '@/components/AppTabBar.vue'
import { useNativeChrome } from '@/composables/useNativeChrome'
import { useAuthStore } from '@/store/authStore'
import { useBiometricStore } from '@/store/biometricStore'

import { useThemeStore } from '@/store/themeStore'
import { ensureUnlocked } from '@/utils/app-guard'
import { getAppVersion } from '@/utils/app-info'
import { biometricLabel, describeBiometricFailure } from '@/utils/biometric'
import { describeError } from '@/utils/errors'

definePage({
  name: 'settings',
  style: { navigationBarTitleText: '设置' },
})

const auth = useAuthStore()

/**
 * Translations for this page.
 *
 * `useI18n()` rather than the module-level `t` from `locales/index.ts`: inside a
 * component it registers the render effect that re-runs the template when the
 * locale changes. The module-level one would translate the first render and then
 * never update.
 */
const { t } = useI18n()

/**
 * The biometric opt-in, owned here as well as on the lock screen.
 *
 * This page is where it belongs: the lock screen shows the switch only to a
 * user who already has a credential stored, so anyone who signed in once and
 * stayed signed in had no way to turn the feature on or off at all.
 */
const biometric = useBiometricStore()

/** Biometric row state, refreshed on every show so it cannot go stale. */
const biometricHint = ref('')
const togglingBiometric = ref(false)

const biometricEnabled = computed({
  get: () => biometric.enabled,
  set: value => biometric.setEnabled(value),
})

/**
 * The row's title, named for this device's actual sensor.
 *
 * A computed rather than a constant so it is read once at render and does not
 * repeat the platform probe — `biometricLabel()` calls `uni.getSystemInfoSync`,
 * which is a bridge round-trip and not something to do inside a template.
 */
const biometricTitle = computed(() => biometricLabel(true))

/**
 * Appearance.
 *
 * Three options rather than a switch, because "follow the system" and "dark" are
 * different intents: a user on the system setting expects the app to change when
 * their phone does, which a two-state switch cannot express without silently
 * breaking that behaviour the first time it is touched.
 */
const theme = useThemeStore()

// Repaints this page's native title bar on every show; it is per-webview and
// reverts to the light default on each navigation otherwise.
useNativeChrome()

/**
 * Labels come from the catalogue rather than being written here.
 *
 * A computed, not a plain array: `t` re-runs when the locale changes, and a
 * constant array would keep the labels it was built with — the switch would
 * translate everything except its own options.
 */
const themeOptions = computed<{ label: string, value: ThemePreference }[]>(
  () => [
    { label: t('settings.followSystem'), value: 'system' },
    { label: t('settings.light'), value: 'light' },
    { label: t('settings.dark'), value: 'dark' },
  ],
)

/**
 * Built by concatenation rather than a `{theme}` placeholder.
 *
 * The App build resolves `vue-i18n` to its runtime-only entry, which has no
 * message compiler — a placeholder is rendered verbatim there, so the screen
 * showed the literal `{theme}`. Joining three plain strings needs no compiler on
 * any target and reads the same on all of them.
 */
const themeHint = computed(() => {
  if (theme.preference !== 'system') {
    return t('settings.fixedHint')
  }

  const resolved = theme.resolved === 'dark'
    ? t('settings.themeDark')
    : t('settings.themeLight')

  return `${t('settings.followSystemHintPrefix')}${resolved}${t('settings.followSystemHintSuffix')}`
})

/**
 * The gateway-side screens, grouped by what they act on.
 *
 * Two lists rather than one flat list of five: `account` rows change the gateway
 * account itself, `data` rows only read what the gateway recorded. The split is
 * what the section headings say out loud, and it is why they are separate
 * arrays — a single list could not be rendered under two headings without
 * slicing it by index, which breaks the moment a row moves.
 *
 * Icons/labels/destinations are declared here rather than as markup repeated
 * per row, so the three cannot drift apart.
 */
const allEntries = [
  {
    hint: '登录方式、修改密码、通行密钥',
    icon: 'i-carbon:user-avatar',
    label: '账户管理',
    path: '/pages/account/index',
  },
  {
    hint: '上游账号的轮询、限流与模型',
    icon: 'i-carbon:credentials',
    label: '凭证管理',
    path: '/pages/credentials/index',
  },
  {
    hint: '自动签到、限流解除时长、运行环境',
    icon: 'i-carbon:settings-adjust',
    label: '网关设置',
    path: '/pages/settings/gateway',
  },
  {
    hint: '给客户端用的令牌、绑定与模型别名',
    icon: 'i-carbon:key',
    label: '访问密钥',
    path: '/pages/credentials/keys',
  },
  // The read-only entries come last. Order is by intent, not by alphabet or by
  // which service answers them: a user opening this list is far more often here
  // to change something than to look something up, so the rows that change
  // state are the ones nearest the thumb.
  {
    hint: '剩余额度、套餐明细、每日签到',
    icon: 'i-carbon:chart-line-data',
    label: '账户数据',
    path: '/pages/account/usage',
  },
  {
    hint: '最近 7 天各账号与模型的调用次数',
    icon: 'i-carbon:chart-bar',
    label: '调用统计',
    path: '/pages/account/stats',
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

/**
 * The running version, from the same source the gateway is told about.
 *
 * The page used to carry a literal (`HDdaraAi v0.1.0`), which no release ever
 * updated — the app would report one version to the gateway and show another to
 * the person holding it, which is the exact contradiction `app-info` documents
 * having been reported before.
 */
const appVersion = getAppVersion() || '未知'

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

/**
 * Re-reads the device capability and phrases the row's second line.
 *
 * Re-read rather than cached: the user is sent to system settings to enrol a
 * face when the device reports nothing enrolled, and coming back must show the
 * new state. A memoised probe would keep saying "未设置" until a relaunch.
 */
async function refreshBiometricHint(): Promise<void> {
  const support = await biometric.refreshSupport()

  if (support === 'available') {
    biometricHint.value = biometric.enabled
      ? '已开启，每次启动需验证身份'
      : '用系统指纹或面容代替重输凭据'
    return
  }

  // Both remaining states are device-side problems, and `describeBiometricFailure`
  // owns that wording so the lock screen and this page cannot disagree.
  biometricHint.value = describeBiometricFailure(support)
}

/**
 * Flips the switch, proving the device can do it before turning on.
 *
 * Turning it off never prompts — leaving must not be gated behind the thing
 * being switched off. Turning it on runs a real authentication, because the
 * capability probe only reports that a bridge exists, not that this person's
 * finger will match; without it the switch could be set on a device whose
 * prompt always fails, discovered only on the next cold start.
 */
async function toggleBiometric() {
  if (togglingBiometric.value)
    return

  if (biometricEnabled.value) {
    biometric.disable()
    void refreshBiometricHint()
    uni.showToast({ icon: 'none', title: '已关闭快速解锁' })
    return
  }

  const support = await biometric.refreshSupport()

  if (support !== 'available') {
    void refreshBiometricHint()
    uni.showToast({
      icon: 'none',
      title: describeBiometricFailure(support),
    })
    return
  }

  togglingBiometric.value = true
  const failure = await biometric.enableWithConfirmation()
  togglingBiometric.value = false
  void refreshBiometricHint()

  if (!failure) {
    uni.showToast({ icon: 'none', title: '已开启快速解锁' })
    return
  }

  // A cancel is the user changing their mind, not a failure to report.
  if (failure.reason !== 'cancelled') {
    uni.showToast({
      icon: 'none',
      title: failure.message || describeBiometricFailure(support),
    })
  }
}

/**
 * What the connection row says under its label.
 *
 * The origin, not "已配置": this is the one screen where the user can see at a
 * glance *which* gateway the app is talking to, and that question comes up far
 * more often than whether credentials exist. Falls back to the state word when
 * no origin is set, so the row never renders empty.
 */
const connectionHint = computed(() => {
  const origin = auth.baseUrl?.trim()

  if (origin)
    return origin.replace(/^https?:\/\//, '')

  return auth.hasCredentials ? '已保存凭据，使用内置地址' : '尚未配置'
})

onShow(() => {
  if (!ensureUnlocked())
    return

  biometric.loadEnabled()
  void refreshBiometricHint()
})
</script>

<template>
  <view class="page" :class="themeClass">
    <!-- ==================================================================
         连接配置。

         此前这里是三张内联表单卡（地址、Cookie、API Key）加一组状态和按钮，
         占掉整页第一个屏幕；而它其实是一年改一次的东西。同样的三个字段搬到
         独立页后，这一页只剩「入口」，用户一眼能看到本页到底有哪几件事。

         入口行而不是分组标题：标题只说明分类，行还能说明现在是什么状态，
         这正是本页最该回答的问题。
         ================================================================== -->
    <view class="group">
      <text class="group-title">网关连接</text>

      <view class="section section-flush">
        <button class="nav-row" @tap="openAccountPage('/pages/settings/connection')">
          <view class="nav-icon i-carbon:plug" />
          <view class="nav-body">
            <text class="nav-label">连接配置</text>
            <text class="nav-hint">{{ connectionHint }}</text>
          </view>
          <view class="nav-chevron i-carbon:chevron-right" />
        </button>
      </view>
    </view>

    <!-- ==================================================================
         分组二：安全。新分组，此前面容/指纹在本页完全没有入口——开关只存在
         于登录页，而登录页仅在「已存凭据」时渲染它，等于登录后就再也找不到。
         ================================================================== -->
    <view class="group">
      <text class="group-title">安全</text>

      <view class="section">
        <button
          class="switch-row"
          :disabled="togglingBiometric"
          @tap="toggleBiometric"
        >
          <view class="nav-body">
            <text class="nav-label">{{ biometricTitle }}</text>
            <text class="nav-hint">
              {{ togglingBiometric ? '等待验证…' : biometricHint }}
            </text>
          </view>
          <AppSwitch :on="biometricEnabled" />
        </button>
      </view>
    </view>

    <!-- ==================================================================
         分组三：外观。独立成组而非并入「安全」——主题与登录保护没有关系，
         二者共处只会让「安全」这个标题名不副实。
         ================================================================== -->
    <view class="group">
      <text class="group-title">{{ t('settings.appearance') }}</text>

      <view class="section">
        <view class="segment">
          <button
            v-for="option in themeOptions"
            :key="option.value"
            class="segment-item"
            :class="{ 'segment-on': theme.preference === option.value }"
            @tap="theme.setPreference(option.value)"
          >
            {{ option.label }}
          </button>
        </view>
        <text class="nav-hint segment-hint">{{ themeHint }}</text>
      </view>
    </view>

    <!-- ==================================================================
         分组四：网关。两组子页按「改账户」与「看数据」分开——此前五类入口
         混在一张卡里，账户管理与用量查询是两种意图。
         ================================================================== -->
    <!-- ==================================================================
         账户与数据。

         两组入口合成一张卡：此前它们是两个分组标题加两张同样的卡，而两组
         的差别只是「改」和「看」——用户在一个列表里找「凭证管理」时，不会
         先想清楚它属于哪一类。合成一张后，六个入口一次看全，分组标题省下来
         的空间还给了说明文字。
         ================================================================== -->
    <view class="group">
      <text class="group-title">账户与数据</text>

      <view class="section section-flush">
        <button
          v-for="entry in allEntries"
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
    </view>

    <!-- ==================================================================
         分组四：危险区。清空会话是不可逆的服务端操作，此前与常规设置同权，
         只靠文字色区分。独立分组 + 显式破坏性标题，让它在滚动时一眼可辨。
         ================================================================== -->
    <view class="group">
      <text class="group-title group-title-danger">危险操作</text>

      <view class="section">
        <text class="section-hint">
          网关保存的每次问答构成 App 里的历史列表。清空后无法恢复，
          但之后的问答会继续记录。
        </text>
        <button class="danger" :disabled="clearing" @tap="confirmClearTranscripts">
          {{ clearing ? '清空中…' : '清空全部会话记录' }}
        </button>
      </view>
    </view>

    <view class="about">
      <text class="about-title">HDdaraAi v{{ appVersion }}</text>
      <text class="about-text">
        用于随时查看 AI 会话状态。会话列表与实时输出来自网关的
        /admin-api/sessions 接口。
      </text>
    </view>
  </view>

  <AppTabBar active="/pages/settings/index" />
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  background-color: $color-page;
  padding: $gap-page;
  /* This page sits behind the native tab bar, which is drawn over the webview.
     The previous value cleared only the bottom-sheet area (~36px) and left the
     tail of the page under the bar: the last two groups — 网关设置 and 调用统计
     — could not be scrolled to and could not be tapped. */
  padding-bottom: $gap-tabbar-clearance;
  box-sizing: border-box;
}

/* ---------------------------------------------------------------------------
 * Groups — the page's top-level rhythm.
 *
 * The cards used to be a flat run of six equally-weighted surfaces, so nothing
 * said which ones belonged together. A group is a label in the secondary type
 * level (spec 2.2.3: section titles sit outside the card, in the "faint" role)
 * plus the cards that answer to it, separated by more space than the cards use
 * among themselves. That gap is what makes the grouping readable without any
 * extra chrome.
 *
 * The scale was too tight to read that way. `$gap-section` (20rpx) sat barely
 * above `$gap-inline` (12rpx), so "space between cards" and "space inside a
 * card" were nearly the same number and the grouping collapsed into one flat
 * run — the failure the label was added to fix. The values below separate the
 * three levels by ratio rather than by a few rpx:
 *
 *   inside a card   16rpx (rows)      the tightest
 *   between cards   20rpx             a card boundary
 *   between groups  56rpx             a topic boundary, ~3x a card boundary
 *
 * Dark mode made it worse rather than causing it: the surfaces are closer in
 * lightness there, so a boundary that relied on a subtle colour step needs the
 * spacing step to carry it.
 * ------------------------------------------------------------------------- */
.group {
  margin-bottom: 56rpx;
}

.group:last-child {
  margin-bottom: 0;
}

.group-title {
  display: block;
  /* `$gap-page` rather than 8rpx: the label has to line up with the card's own
     text column, or it reads as belonging to the page margin instead of to the
     cards under it. */
  margin: 0 0 16rpx #{$gap-page};
  font-size: $font-micro;
  font-weight: 600;
  letter-spacing: 1rpx;
  color: $color-text-faint;
}

.group-title-danger {
  color: $color-danger;
}

.section {
  margin-bottom: $gap-section;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

/* Last card in a group: the group's own bottom margin supplies the gap, so a
   trailing margin would double it. */
.section:last-child {
  margin-bottom: 0;
}

/* Body padding removed for rows that draw their own (lists). */
.section-flush {
  padding: $gap-inline $gap-page;
}

/* A metadata card: tighter than a form card, since it carries no inputs. */
.section-tight {
  padding: $gap-inline $gap-page;
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
  font-size: $font-micro;
  color: $color-text-muted;
  line-height: 1.6;
}

.input {
  width: 100%;
  height: $height-control;
  margin-top: $gap-inline;
  padding: 0 20rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  font-size: $font-label;
  color: $color-text;
}

/* Title and its action on one line; the title's own bottom margin is dropped
   because the container's spacing takes over. */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.section-toggle {
  flex: none;
  font-size: $font-micro;
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

/* "可选" and similar qualifiers: a pill, so it reads as a property of the
   title rather than as a second heading. */
.section-badge {
  flex: none;
  padding: 2rpx 14rpx;
  border-radius: $radius-pill;
  background-color: $color-neutral-surface;
  font-size: $font-micro;
  color: $color-text-muted;
}

/* ---------------------------------------------------------------------------
 * Metadata rows — the credential state, folded into the card it describes.
 * ------------------------------------------------------------------------- */
.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10rpx 0;
  font-size: $font-meta;
  color: $color-text-muted;
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
  color: $color-text-secondary;
}

/* Colour plus a word, never colour alone (spec 3.2.3). */
.meta-dot {
  width: 14rpx;
  height: 14rpx;
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
  gap: 6rpx;
  color: $color-success;
}

.status-icon {
  width: 26rpx;
  height: 26rpx;
}

/* ---------------------------------------------------------------------------
 * Group actions — inside the group, so what they act on is not in question.
 *
 * The solid button sits on the right: it is where a left-to-right row ends, and
 * only one of the pair is solid (spec 3.1.2).
 * ------------------------------------------------------------------------- */
.group-actions {
  display: flex;
  gap: $gap-section;
  margin-top: $gap-section;
}

.group-actions > * {
  flex: 1;
}

.primary {
  background-color: $color-primary;
  color: $color-surface;
  font-size: $font-label;
  border-radius: $radius-control;
}

/* Dimmed rather than merely inert, so the state is visible before the tap. */
.primary[disabled] {
  background-color: $color-primary-disabled;
  color: $color-surface;
}

.ghost {
  background-color: $color-surface;
  color: $color-text-secondary;
  font-size: $font-label;
  border-radius: $radius-control;
  border: 1rpx solid $color-border;
}

/* Destructive: the red text is the signal, and it is the only red on the page
   outside the danger group's own heading. */
.danger {
  width: 100%;
  margin-top: $gap-section;
  background-color: $color-danger-surface;
  color: $color-danger;
  font-size: $font-label;
  border-radius: $radius-control;
}

.danger[disabled] {
  background-color: $color-neutral-surface;
  color: $color-text-faint;
}

/* ---------------------------------------------------------------------------
 * Rows — reset the platform button chrome so a row reads as a list item.
 * ------------------------------------------------------------------------- */
.nav-row,
.switch-row {
  display: flex;
  align-items: center;
  gap: $gap-section;
  width: 100%;
  margin: 0;
  padding: $gap-section 0;
  border: none;
  border-radius: 0;
  background-color: transparent;
  line-height: normal;
  text-align: left;
}

.nav-row {
  border-bottom: 1rpx solid $color-border-strong;
}

.nav-row:last-child {
  border-bottom: none;
}

.nav-row::after,
.switch-row::after {
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

/* Segmented control. `$radius-segment` is the inner corner, one step smaller
   than the control's own so the segments nest inside it instead of pushing
   against it — the token exists precisely for this. */
.segment {
  display: flex;
  gap: 4rpx;
  padding: 4rpx;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
}

.segment-item {
  flex: 1;
  width: auto;
  margin: 0;
  padding: 0;
  height: $height-control-compact;
  border: none;
  border-radius: $radius-segment;
  font-size: $font-label;
  line-height: $height-control-compact;
  color: $color-text-secondary;
  background-color: transparent;
}

.segment-item::after {
  border: none;
}

.segment-on {
  font-weight: 600;
  color: $color-text;
  background-color: $color-surface;
}

.segment-hint {
  margin-top: $gap-inline;
}

.nav-chevron {
  flex: none;
  width: 32rpx;
  height: 32rpx;
  color: $color-text-faint;
}

/* ---------------------------------------------------------------------------
 * About — deliberately the quietest block on the page.
 * ------------------------------------------------------------------------- */
.about {
  margin-top: 48rpx;
  padding: 0 $gap-page $gap-page;
}

.about-title {
  display: block;
  font-size: $font-meta;
  font-weight: 600;
  color: $color-text-faint;
  margin-bottom: 8rpx;
}

.about-text {
  font-size: $font-micro;
  color: $color-text-faint;
  line-height: 1.7;
}
</style>
