<script setup lang="ts">
/**
 * The app's toggle, drawn rather than using the platform's `<switch>`.
 *
 * Why a component: the lock screen and the settings page both offer the same
 * biometric opt-in, and they had drawn the switch twice — 92rpx/26rpx/40rpx on
 * one, 88rpx/999rpx/36rpx on the other. Two sizes for one control is the "did
 * anyone finish this" tell the design spec calls out (2.4.3), and the fix is
 * one definition rather than two that agree today.
 *
 * The native control was not used because it sizes and colours itself
 * differently per platform, and this needs to match the app's accent on both.
 *
 * Presentational only: the whole row is the caller's button. Making this
 * tappable as well would nest a control inside a control, and on the App
 * runtime a tap landing on the inner node does not reliably reach the outer
 * handler.
 */
withDefaults(defineProps<{
  /** Whether the switch reads as on. */
  on?: boolean
}>(), {
  on: false,
})
</script>

<template>
  <view class="switch" :class="{ 'switch-on': on }">
    <view class="switch-knob" />
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.switch {
  flex: none;
  width: 92rpx;
  height: 52rpx;
  padding: 4rpx;
  box-sizing: border-box;
  border-radius: $radius-pill;
  background-color: $color-border;
  transition: background-color 0.18s ease;

  /* Clicks belong to the row that owns this switch.
   *
   * The switch is decorative; the whole row is the caller's button. On the App
   * runtime a tap that lands on a child node does not reliably reach the parent
   * handler, so pressing the switch — the obvious target, and the part a user
   * aims at — did nothing at all, while pressing the label beside it worked.
   * That is the worst shape a control can have: it looks live and is not.
   *
   * Not `display: none` or a nested button: the knob is still drawn, it simply
   * never becomes the event target. */
  pointer-events: none;
}

.switch-on {
  background-color: $color-primary;
}

.switch-knob {
  width: 44rpx;
  height: 44rpx;
  border-radius: $radius-pill;
  background-color: $color-surface;
  transition: transform 0.18s ease;
}

.switch-on .switch-knob {
  transform: translateX(40rpx);
}
</style>
