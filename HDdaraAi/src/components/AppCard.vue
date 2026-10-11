<script setup lang="ts">
/**
 * The white surface every block of content sits on.
 *
 * Why a component: the card radius was 20rpx on four pages and 24rpx on the
 * login page, and the padding disagreed too — the same visual element advertised
 * two different products. Hierarchy here comes from the page/card value step,
 * not from shadows (design spec 2.1.1), so there is deliberately no `elevated`
 * variant to reach for.
 *
 * `title`/`subtitle` render the header block; slots cover everything else. A
 * card whose header is in the slot should not also pass `title`, or the two
 * will disagree about spacing.
 */
withDefaults(defineProps<{
  /** Removes the body padding for full-bleed content such as a list. */
  flush?: boolean
  /** Secondary line under the title. */
  subtitle?: string
  /** Renders the header block when present. */
  title?: string
}>(), {
  flush: false,
  subtitle: '',
  title: '',
})
</script>

<template>
  <view class="card">
    <view v-if="title || $slots.header || $slots.action" class="card-head">
      <view class="card-head-main">
        <slot name="header">
          <text class="card-title">{{ title }}</text>
          <text v-if="subtitle" class="card-subtitle">{{ subtitle }}</text>
        </slot>
      </view>
      <view v-if="$slots.action" class="card-head-action">
        <slot name="action" />
      </view>
    </view>
    <view class="card-body" :class="{ 'card-body-flush': flush }">
      <slot />
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.card {
  overflow: hidden;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.card-head {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  padding: $gap-section $gap-section 0;
}

.card-head-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.card-title {
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
  line-height: 1.4;
}

.card-subtitle {
  margin-top: 6rpx;
  font-size: $font-meta;
  color: $color-text-muted;
  line-height: 1.5;
}

.card-head-action {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-left: $gap-inline;
}

.card-body {
  padding: $gap-section;
}

.card-body-flush {
  padding: 0;
}
</style>
