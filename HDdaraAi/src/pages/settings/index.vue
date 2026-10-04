<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { ref } from 'vue'

import { useAuthStore } from '@/store/authStore'

definePage({
  name: 'settings',
  style: { navigationBarTitleText: '设置' },
})

const auth = useAuthStore()

const baseUrl = ref('')
const adminCookie = ref('')
const apiKey = ref('')
const saved = ref(false)

function load() {
  baseUrl.value = auth.baseUrl || String(import.meta.env.VITE_API_BASE_URL ?? '')
  adminCookie.value = auth.adminCookie
  apiKey.value = auth.apiKey
  saved.value = false
}

function save() {
  auth.setBaseUrl(baseUrl.value.trim())
  auth.setAdminCookie(adminCookie.value)
  auth.setApiKey(apiKey.value)
  saved.value = true

  uni.showToast({ icon: 'none', title: '已保存' })
}

function clear() {
  auth.logout()
  adminCookie.value = ''
  apiKey.value = ''
  saved.value = false

  uni.showToast({ icon: 'none', title: '已清除凭据' })
}

onShow(load)
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
      <text class="section-title">控制台 Cookie</text>
      <text class="section-hint">
        在浏览器登录控制台后，从开发者工具复制 Cookie 头里的
        codebuddy_admin_session 值。
      </text>
      <textarea
        v-model="adminCookie"
        class="textarea"
        placeholder="codebuddy_admin_session=..."
      />
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
      <button class="primary" @tap="save">
        保存
      </button>
      <button class="ghost" @tap="clear">
        清除凭据
      </button>
    </view>

    <view class="status">
      <text>当前状态：{{ auth.hasCredentials ? '已配置' : '未配置' }}</text>
      <text v-if="saved" class="status-saved">已保存</text>
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

.input {
  height: 80rpx;
  padding: 0 20rpx;
  border-radius: 14rpx;
  background-color: #f5f6f8;
  font-size: 26rpx;
  color: #1f2329;
}

.textarea {
  width: 100%;
  height: 160rpx;
  padding: 20rpx;
  box-sizing: border-box;
  border-radius: 14rpx;
  background-color: #f5f6f8;
  font-size: 24rpx;
  color: #1f2329;
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
