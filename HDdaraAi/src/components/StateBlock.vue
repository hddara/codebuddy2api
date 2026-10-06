<script setup lang="ts">
/**
 * The loading / empty / error placeholder used by every list and panel.
 *
 * Why a component: each page had its own version, and they disagreed — the
 * sessions list used a centred grey line, the detail page used a white card, the
 * live page used a third style. Same intent, three looks.
 *
 * `variant` picks the surface and colour; `tone` distinguishes an informational
 * empty state from a failure, which previously differed only by a colour literal.
 */
withDefaults(defineProps<{
  /** Optional secondary line, e.g. what to do next. */
  hint?: string
  /** Shows a spinner-ish affordance while a request is in flight. */
  loading?: boolean
  /** Retry affordance. Rendered only when a handler is bound. */
  retryText?: string
  text: string
  /** `card` sits on its own white surface; `plain` blends into its parent. */
  variant?: 'card' | 'plain'
  tone?: 'neutral' | 'danger'
}>(), {
  hint: '',
  loading: false,
  retryText: '',
  tone: 'neutral',
  variant: 'card',
})

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <view class="state" :class="[`state-${variant}`, `state-${tone}`]">
    <view v-if="loading" class="state-spinner" />
    <text class="state-text">{{ text }}</text>
    <text v-if="hint" class="state-hint">{{ hint }}</text>
    <text v-if="retryText" class="state-retry" @tap="emit('retry')">
      {{ retryText }}
    </text>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48rpx 32rpx;
  box-sizing: border-box;
}

.state-card {
  border-radius: $radius-card;
  background-color: $color-surface;
}

/* Inside an existing card, a second white block would read as a nested panel. */
.state-plain {
  background-color: transparent;
}

.state-text {
  font-size: $font-label;
  line-height: 1.7;
  text-align: center;
  color: $color-text-muted;
}

.state-danger .state-text {
  color: $color-danger;
}

.state-hint {
  margin-top: 10rpx;
  font-size: $font-meta;
  line-height: 1.7;
  text-align: center;
  color: $color-text-faint;
}

.state-retry {
  margin-top: 24rpx;
  padding: 12rpx 40rpx;
  border: 1rpx solid $color-primary;
  border-radius: $radius-pill;
  font-size: $font-meta;
  color: $color-primary;
}

.state-spinner {
  width: 36rpx;
  height: 36rpx;
  margin-bottom: 20rpx;
  border: 4rpx solid $color-border;
  border-top-color: $color-primary;
  border-radius: 50%;
  animation: state-spin 0.9s linear infinite;
}

@keyframes state-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
