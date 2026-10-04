<script lang="ts" setup>
const { loadingOptions, currentPage } = storeToRefs(useGlobalLoading())

const { close: closeGlobalLoading } = useGlobalLoading()

const loading = useToast('globalLoading')

// #ifdef MP-ALIPAY
const hackAlipayVisible = ref(false)

nextTick(() => {
  hackAlipayVisible.value = true
})
// #endif

watch(() => loadingOptions.value, (newVal) => {
  if (newVal && newVal.show) {
    // 同 GlobalMessage：路径必须按展示时刻取，setup 时缓存会导致后续页面 loading 不显示
    if (currentPage.value === getCurrentPath()) {
      loading.loading(loadingOptions.value)
    }
  }
  else {
    loading.close()
  }
})
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
  <wd-toast v-if="hackAlipayVisible" selector="globalLoading" :closed="closeGlobalLoading" />
  <!-- #endif -->
  <!-- #ifndef MP-ALIPAY -->
  <wd-toast selector="globalLoading" :closed="closeGlobalLoading" />
  <!-- #endif -->
</template>
