<script setup lang="ts">
import type { GatewaySettings, SettingField } from '@/api/settings'
import { onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { consoleErrorMessage } from '@/api/core/console'
import {
  EDITABLE_SETTING_FIELDS,
  fetchGatewaySettings,
  isSettingEditable,
  isSettingEnabled,
  saveGatewaySettings,
  settingFlag,
} from '@/api/settings'
import AppButton from '@/components/AppButton.vue'
import AppSwitch from '@/components/AppSwitch.vue'
import StateBlock from '@/components/StateBlock.vue'
import { useNativeChrome } from '@/composables/useNativeChrome'
import { ensureUnlocked } from '@/utils/app-guard'

definePage({
  name: 'gateway-settings',
  style: { navigationBarTitleText: '网关设置' },
})

/**
 * A working copy of the configuration.
 *
 * Edits are held locally and written on save rather than applied on each
 * keystroke: every write reaches the running gateway and can trip its
 * check-in rescheduling, so a half-typed log level should not be one.
 */

// Repaints this page's native title bar; it is per-webview and would
// otherwise revert to the light default on each navigation.
useNativeChrome()
const settings = ref<GatewaySettings>({
  CODEBUDDY_API_ENDPOINT: '',
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: '',
  CODEBUDDY_AUTH_MODE: '',
  CODEBUDDY_AUTO_CHECKIN_ENABLED: 'false',
  CODEBUDDY_AUTO_CHECKIN_TIME: '',
  CODEBUDDY_CREDENTIAL_LIMIT_HOURS: '',
  CODEBUDDY_INTERNET_ENVIRONMENT: '',
  CODEBUDDY_LOG_LEVEL: '',
})

const loading = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const notice = ref('')

/** Only the fields a phone should offer; see `EDITABLE_SETTING_FIELDS`. */
const fields = EDITABLE_SETTING_FIELDS

async function load() {
  loading.value = true
  errorMessage.value = ''

  try {
    const payload = await fetchGatewaySettings()
    settings.value = { ...settings.value, ...payload.settings }
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取网关设置失败')
  }
  finally {
    loading.value = false
  }
}

/**
 * Writes back the editable subset.
 *
 * Only these keys: sending the whole object would include the two the app
 * deliberately does not manage, and a stale copy of those would revert a change
 * made in the web console.
 */
async function save() {
  if (saving.value)
    return

  saving.value = true
  errorMessage.value = ''
  notice.value = ''

  try {
    const patch = fields.reduce<Partial<Record<keyof GatewaySettings, string>>>(
      (result, field) => ({ ...result, [field.key]: settings.value[field.key] }),
      {},
    )

    settings.value = { ...settings.value, ...(await saveGatewaySettings(patch)) }
    notice.value = '已保存'
    uni.showToast({ icon: 'none', title: '已保存' })
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '保存失败')
  }
  finally {
    saving.value = false
  }
}

/** Current value of one field, as the control expects it. */
function valueOf(key: keyof GatewaySettings): string {
  return String(settings.value[key] ?? '')
}

function setValue(key: keyof GatewaySettings, value: string) {
  settings.value = { ...settings.value, [key]: value }
}

/**
 * `@input` handler for the two text fields.
 *
 * A method rather than an inline expression: the payload is a platform event
 * whose shape has to be narrowed, and the App runtime's template compiler
 * rejects a type assertion written in the template.
 */
function onInput(key: keyof GatewaySettings, event: unknown) {
  const detail = (event as { detail?: { value?: unknown } })?.detail

  setValue(key, String(detail?.value ?? ''))
}

/** Labels come from the gateway so the app does not invent its own wording. */
const checkinEnabled = computed(() =>
  isSettingEnabled(settings.value.CODEBUDDY_AUTO_CHECKIN_ENABLED))

function toggleCheckin(next: boolean) {
  setValue('CODEBUDDY_AUTO_CHECKIN_ENABLED', settingFlag(next))
}

function editable(field: SettingField): boolean {
  return isSettingEditable(field, settings.value)
}

onShow(() => {
  if (!ensureUnlocked())
    return

  void load()
})
</script>

<template>
  <view class="page" :class="themeClass">
    <StateBlock v-if="loading" :loading="true" text="读取网关设置…" />

    <StateBlock
      v-else-if="errorMessage && !notice"
      tone="danger"
      icon="i-carbon:warning-alt"
      :text="errorMessage"
      retry-text="重试"
      @retry="load"
    />

    <template v-else>
      <view v-if="notice" class="notice">
        <view class="notice-icon i-carbon:checkmark" />
        <text>{{ notice }}</text>
      </view>

      <view class="section">
        <text class="section-hint">
          这些设置作用于网关本身，会影响所有客户端，不只是这台手机。
          上游地址与通行密钥域名涉及网关自身的可访问性，保留在网页控制台修改。
        </text>
      </view>

      <view class="section">
        <text class="section-title">自动签到</text>

        <button class="switch-row" @tap="toggleCheckin(!checkinEnabled)">
          <view class="switch-body">
            <text class="switch-label">开启自动签到</text>
            <text class="switch-hint">
              按设定时间自动为所有上游账号签到，领取每日额度。
            </text>
          </view>
          <AppSwitch :on="checkinEnabled" />
        </button>

        <view class="field">
          <text class="field-label">签到时间</text>
          <input
            class="input"
            :disabled="!checkinEnabled"
            placeholder="09:00"
            :value="valueOf('CODEBUDDY_AUTO_CHECKIN_TIME')"
            @input="onInput('CODEBUDDY_AUTO_CHECKIN_TIME', $event)"
          >
          <text class="field-hint">服务器本地时间，格式 HH:mm。</text>
        </view>
      </view>

      <view class="section">
        <text class="section-title">账号轮询</text>

        <view class="field">
          <text class="field-label">限流自动解除（小时）</text>
          <input
            class="input"
            placeholder="24"
            type="number"
            :value="valueOf('CODEBUDDY_CREDENTIAL_LIMIT_HOURS')"
            @input="onInput('CODEBUDDY_CREDENTIAL_LIMIT_HOURS', $event)"
          >
          <text class="field-hint">
            账号被上游限流后，超过这个时长自动解除并重新参与轮询。
          </text>
        </view>
      </view>

      <view class="section">
        <text class="section-title">运行环境</text>

        <view class="field">
          <text class="field-label">网络环境</text>
          <view class="options">
            <button
              v-for="option in fields.find(item => item.key === 'CODEBUDDY_INTERNET_ENVIRONMENT')?.options ?? []"
              :key="option.value"
              class="option"
              :class="{ 'option-on': valueOf('CODEBUDDY_INTERNET_ENVIRONMENT') === option.value }"
              @tap="setValue('CODEBUDDY_INTERNET_ENVIRONMENT', option.value)"
            >
              {{ option.label }}
            </button>
          </view>
          <text class="field-hint">内网环境需要服务器能访问腾讯内网。</text>
        </view>

        <view class="field">
          <text class="field-label">日志级别</text>
          <view class="options">
            <button
              v-for="option in fields.find(item => item.key === 'CODEBUDDY_LOG_LEVEL')?.options ?? []"
              :key="option.value"
              class="option"
              :class="{ 'option-on': valueOf('CODEBUDDY_LOG_LEVEL') === option.value }"
              @tap="setValue('CODEBUDDY_LOG_LEVEL', option.value)"
            >
              {{ option.label }}
            </button>
          </view>
          <text class="field-hint">排查问题时调高，平时保持「信息」即可。</text>
        </view>
      </view>

      <view v-if="editable(fields[1])" class="section-hint hint-block">
        修改会立即作用于网关，正在进行的请求不受影响。
      </view>

      <view class="actions">
        <AppButton
          variant="solid"
          block
          :disabled="saving"
          @tap="save"
        >
          {{ saving ? '保存中…' : '保存设置' }}
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
  font-size: $font-label;
  font-weight: 600;
  color: $color-text;
}

.section-hint {
  display: block;
  font-size: $font-micro;
  line-height: 1.6;
  color: $color-text-muted;
}

.hint-block {
  margin: 0 8rpx $gap-section;
}

.notice {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-bottom: $gap-section;
  padding: $gap-inline $gap-page;
  border-radius: $radius-control;
  background-color: $color-success-surface;
  font-size: $font-meta;
  color: $color-success;
}

.notice-icon {
  width: 30rpx;
  height: 30rpx;
}

.field {
  margin-top: $gap-page;
}

.field-label {
  display: block;
  margin-bottom: 8rpx;
  font-size: $font-meta;
  color: $color-text-secondary;
}

.field-hint {
  display: block;
  margin-top: 8rpx;
  font-size: $font-micro;
  line-height: 1.55;
  color: $color-text-muted;
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

/* A disabled dependent field must look disabled, not merely ignore taps. */
.input[disabled] {
  color: $color-text-faint;
}

/* Segmented options rather than a picker: the sets are small and every choice
   fits on one line, which makes the current value visible without opening
   anything (spec 3.3.1 — inline over navigation). */
.options {
  display: flex;
  flex-wrap: wrap;
  gap: $gap-inline;
}

.option {
  flex: none;
  width: auto;
  margin: 0;
  padding: 10rpx 28rpx;
  border-radius: $radius-pill;
  background-color: $color-surface-sunken;
  font-size: $font-meta;
  line-height: 1.5;
  color: $color-text-secondary;
}

.option::after {
  border: none;
}

.option-on {
  background-color: $color-primary-surface;
  color: $color-primary;
  font-weight: 600;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: $gap-section;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
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
  font-size: $font-label;
  color: $color-text;
}

.switch-hint {
  display: block;
  margin-top: 4rpx;
  font-size: $font-micro;
  line-height: 1.55;
  color: $color-text-muted;
}

.actions {
  margin-top: $gap-section;
  padding-bottom: 40rpx;
}
</style>
