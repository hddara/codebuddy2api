<script setup lang="ts">
/**
 * Layout-preserving placeholder for a list that is still loading.
 *
 * Why this exists: the first paint used to be a centred spinner that replaced
 * the whole screen, so the content arrived with a jump and the page felt like it
 * had reloaded. A skeleton keeps the shape of what is coming, which makes the
 * wait read as "the list is filling in" rather than "nothing here yet"
 * (design spec 3.2.2).
 *
 * `rows` should match the expected page size closely enough that the height does
 * not visibly change when real data lands.
 */
withDefaults(defineProps<{
  /** Number of placeholder cards. */
  rows?: number
  /** Adds a leading line inside each card, for list rows with a title. */
  withTitle?: boolean
}>(), {
  rows: 4,
  withTitle: true,
})
</script>

<template>
  <view class="skeleton">
    <view v-for="row in rows" :key="row" class="skeleton-card">
      <view v-if="withTitle" class="skeleton-line skeleton-line-title" />
      <view class="skeleton-line skeleton-line-body" />
      <view v-if="withTitle" class="skeleton-line skeleton-line-body skeleton-line-short" />
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.skeleton {
  display: flex;
  flex-direction: column;
}

.skeleton-card {
  margin-bottom: $gap-section;
  padding: $gap-section;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.skeleton-line {
  height: 28rpx;
  border-radius: 8rpx;
  background-color: $color-border-strong;
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}

.skeleton-line-title {
  width: 42%;
  height: 32rpx;
}

.skeleton-line-body {
  width: 100%;
  margin-top: 20rpx;
}

.skeleton-line-short {
  width: 64%;
}

@keyframes skeleton-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.45;
  }
}
</style>
