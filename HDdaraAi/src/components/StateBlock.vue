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
  /**
   * Icon class shown above the text, e.g. `i-carbon:document-blank`.
   *
   * Left to the caller rather than derived from `tone`: the useful distinction
   * is *why* the panel is empty (nothing collected yet / nothing in this range /
   * the request failed), and only the caller knows which. A default here would
   * put the same glyph on situations that need telling apart.
   */
  icon?: string
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
  icon: '',
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
    <!-- Never alongside the spinner: two competing affordances in one panel read
         as a rendering fault rather than as progress. -->
    <view
      v-else-if="icon"
      class="state-icon"
      :class="icon"
    />
    <text class="state-text">{{ text }}</text>
    <text v-if="hint" class="state-hint">{{ hint }}</text>
    <!-- A <button>, not a <text> with @tap: in the App runtime a tap on a text
         node does not reliably reach a handler, so every retry affordance this
         component renders (it is reused by all four pages) was dead. -->
    <button v-if="retryText" class="state-retry" @tap="emit('retry')">
      {{ retryText }}
    </button>
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

/* Deliberately large and faint: at body-text size an icon reads as a label,
   and at full contrast it competes with the sentence it is meant to introduce. */
.state-icon {
  width: 72rpx;
  height: 72rpx;
  margin-bottom: 20rpx;
  color: $color-text-faint;
}

.state-danger .state-icon {
  color: $color-danger;
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
  line-height: 1.6;
  background-color: transparent;
}

/* uni-app draws a 1px hairline border and a default background on every
   <button>; both would double up with the pill border above. */
.state-retry::after {
  border: none;
}

.state-retry[disabled] {
  color: $color-text-faint;
  border-color: $color-border;
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
