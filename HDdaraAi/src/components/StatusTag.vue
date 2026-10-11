<script setup lang="ts">
/**
 * The small coloured pill that labels a state.
 *
 * Why a component: the same four states were re-styled in four pages, each with
 * its own colour literals, so a "completed" pill was a slightly different green
 * depending on where you looked. One meaning now maps to one colour everywhere
 * (design spec 2.3.2).
 *
 * The dot plus the label carry the meaning together — colour alone is not a
 * channel every user can read (design spec 3.2.3).
 */
withDefaults(defineProps<{
  /** `busy` is the in-flight state; it pulses so it reads as live. */
  tone?: 'danger' | 'info' | 'muted' | 'success' | 'warning' | 'busy'
}>(), {
  tone: 'muted',
})
</script>

<template>
  <view class="tag" :class="`tag-${tone}`">
    <view class="tag-dot" />
    <text class="tag-label"><slot /></text>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.tag {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  padding: 4rpx 16rpx;
  border-radius: $radius-pill;
}

.tag-dot {
  width: 12rpx;
  height: 12rpx;
  margin-right: 8rpx;
  border-radius: 50%;
  background-color: currentColor;
}

.tag-label {
  font-size: $font-micro;
  font-weight: 500;
  line-height: 1.6;
  color: inherit;
}

.tag-success {
  background-color: $color-success-surface;
  color: $color-success;
}

.tag-danger {
  background-color: $color-danger-surface;
  color: $color-danger;
}

.tag-warning {
  background-color: $color-warning-surface;
  color: $color-warning;
}

.tag-info {
  background-color: $color-primary-surface;
  color: $color-primary;
}

.tag-muted {
  background-color: $color-neutral-surface;
  color: $color-neutral;
}

.tag-busy {
  background-color: $color-primary-surface;
  color: $color-primary;
}

.tag-busy .tag-dot {
  animation: tag-pulse 1.4s ease-in-out infinite;
}

@keyframes tag-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.3;
  }
}
</style>
