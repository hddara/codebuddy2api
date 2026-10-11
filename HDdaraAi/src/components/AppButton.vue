<script setup lang="ts">
/**
 * The app's only button.
 *
 * Why a component: every page drew its own `.primary` / `.ghost` / `.danger`,
 * and they had drifted apart — the same "primary" button was 18rpx on the login
 * page and 14rpx in settings, and the secondary button was grey on one page and
 * white on another. Three levels is the whole vocabulary (design spec 3.1.2):
 *
 *   solid     one per screen, the action you came for
 *   tonal     secondary action, sits on the page background
 *   text      tertiary, inline or low-emphasis
 *
 * Never render two `solid` buttons side by side — that is the failure the levels
 * exist to prevent.
 */
withDefaults(defineProps<{
  /** Stretch to the container width. */
  block?: boolean
  disabled?: boolean
  /** Shows a spinner and blocks taps. */
  loading?: boolean
  /** `danger` is reserved for destructive actions, which must confirm first. */
  tone?: 'neutral' | 'danger'
  /** `md` for page-level actions, `sm` for inline ones. */
  size?: 'md' | 'sm'
  /** See the level descriptions above. */
  variant?: 'solid' | 'tonal' | 'text'
}>(), {
  block: false,
  disabled: false,
  loading: false,
  size: 'md',
  tone: 'neutral',
  variant: 'solid',
})

const emit = defineEmits<{
  tap: []
}>()

function onTap() {
  emit('tap')
}
</script>

<template>
  <button
    class="btn"
    :class="[
      `btn-${variant}`,
      `btn-${size}`,
      `btn-tone-${tone}`,
      { 'btn-block': block, 'btn-busy': loading },
    ]"
    :disabled="disabled || loading"
    @tap="onTap"
  >
    <view v-if="loading" class="btn-spinner" />
    <slot />
  </button>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.btn {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  margin: 0;
  padding: 0 32rpx;
  border: none;
  border-radius: $radius-control;
  font-size: $font-label;
  font-weight: 600;
  line-height: 1.4;
}

/* uni-app draws a hairline border and a background on every <button>. */
.btn::after {
  border: none;
}

.btn-md {
  height: $height-control;
}

.btn-sm {
  height: $height-control-compact;
  padding: 0 24rpx;
  font-size: $font-meta;
}

.btn-block {
  width: 100%;
}

/* Solid — the one real call to action on the screen. */
.btn-solid {
  background-color: $color-primary;
  color: $color-surface;
}

.btn-solid.btn-tone-danger {
  background-color: $color-danger;
}

.btn-solid[disabled] {
  background-color: $color-primary-disabled;
  color: $color-surface;
}

/* Tonal — secondary, reads as a surface rather than as emphasis. */
.btn-tonal {
  background-color: $color-surface;
  color: $color-text-secondary;
  border: 1rpx solid $color-border;
}

.btn-tonal.btn-tone-danger {
  color: $color-danger;
}

.btn-tonal[disabled] {
  color: $color-text-faint;
}

/* Text — tertiary; no container at all. */
.btn-text {
  height: auto;
  padding: 12rpx 8rpx;
  background-color: transparent;
  color: $color-primary;
  font-weight: 500;
}

.btn-text.btn-tone-danger {
  color: $color-danger;
}

.btn-text[disabled] {
  color: $color-text-faint;
}

.btn-spinner {
  width: 28rpx;
  height: 28rpx;
  margin-right: 12rpx;
  border: 3rpx solid rgba(255, 255, 255, 0.45);
  border-top-color: $color-surface;
  border-radius: 50%;
  animation: btn-spin 0.9s linear infinite;
}

@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
