<script lang="ts" setup>
import { deepClone, isFunction } from 'wot-design-uni/components/common/util'

const { messageOptions, currentPage } = storeToRefs(useGlobalMessage())

const messageBox = useMessage('globalMessage')

// #ifdef MP-ALIPAY
const hackAlipayVisible = ref(false)

nextTick(() => {
  hackAlipayVisible.value = true
})
// #endif

watch(() => messageOptions.value, (newVal) => {
  if (newVal) {
    // 只在「发起调用的页面」展示：必须用展示时刻的当前路径比较。
    // 本组件是 App 级组件只 setup 一次，若在 setup 时把路径缓存下来，
    // 冷启动之后任何页面都与它不等，弹窗会被静默吞掉。
    if (currentPage.value === getCurrentPath()) {
      const option = deepClone(newVal)
      messageBox.show(option).then((res) => {
        if (isFunction(option.success)) {
          option.success(res)
        }
      }).catch((err) => {
        if (isFunction(option.fail)) {
          option.fail(err)
        }
      })
    }
  }
  else {
    messageBox.close()
  }
})

/**
 * 关闭弹窗（若有）：弹窗挂在 App 级组件上，不随页面销毁 ——
 * 弹窗打开时用户「直接返回上一页/切换页面」，弹窗会遗留在新页面上。
 * 因此所有「离开当前页面」的入口都要主动关闭。
 */
function closeMessageIfShowing() {
  if (messageOptions.value) {
    useGlobalMessage().close()
  }
}

// ① uni 路由 API（navigateTo / navigateBack / switchTab 等）
const ROUTE_METHODS = ['navigateTo', 'redirectTo', 'reLaunch', 'switchTab', 'navigateBack']
ROUTE_METHODS.forEach((method) => {
  uni.addInterceptor(method, {
    invoke() {
      closeMessageIfShowing()
      return true
    },
  })
})

// #ifdef H5
// ② H5 浏览器返回/前进（含手机侧滑返回）不走 uni 路由 API，用 popstate 兜底
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', closeMessageIfShowing)
}
// #endif

// #ifdef APP-PLUS
// ③ App（Android）物理返回键不经过 uni.navigateBack，直接监听按键
if (typeof plus !== 'undefined') {
  plus.key.addEventListener('backbutton', closeMessageIfShowing)
}
// #endif
</script>

<script lang="ts">
export default {
  options: {
    virtualHost: true,
    addGlobalClass: true,
    styleIsolation: 'shared',
  },
}
</script>

<template>
  <!-- #ifdef MP-ALIPAY -->
  <wd-message-box v-if="hackAlipayVisible" selector="globalMessage" />
  <!-- #endif -->
  <!-- #ifndef MP-ALIPAY -->
  <wd-message-box selector="globalMessage" />
  <!-- #endif -->
</template>
