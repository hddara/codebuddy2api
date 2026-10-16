<script setup lang="ts">
/**
 * The app's tab bar, drawn as a floating bar instead of the native control.
 *
 * Why not `pages.json`'s `tabBar`: on the App runtime that is a native view
 * composited ABOVE the webview, and the platform gives no way to restyle it —
 * `uni.setTabBarStyle` accepts a `backgroundColor` and ignores it, which is how
 * a white strip survived every dark-mode attempt. It also reserves its full
 * height in the layout, so a translucent or floating treatment is impossible:
 * the bar can only ever be an opaque band welded to the bottom edge.
 *
 * Drawing it in the webview buys the three things that were asked for —
 * a floating rounded bar, a gradient surface, and motion on selection — plus
 * the one that matters more than any of them: the bar now sits *inside* the
 * page's colour scheme, so it can never disagree with the theme again.
 *
 * The cost is that every behaviour the native bar provided is now ours. The
 * ones that need code are here: the safety inset, the active state, and the
 * navigation itself. `switchTab` is deliberately NOT used — there is no native
 * tab bar for it to address, so these are ordinary pages and `reLaunch` is what
 * actually lands the user on the other root.
 */

import { computed } from 'vue'

import { useThemeStore } from '@/store/themeStore'

interface TabBarItem {
  /** Absolute page path, as `pages.json` registers it. */
  path: string
  label: string
  /** UnoCSS icon class. */
  icon: string
}

const props = defineProps<{
  /**
   * Which entry is current. Passed in rather than derived from the route: the
   * page already knows whether it is the session list or the settings screen,
   * and asking the router from inside a component made every render depend on
   * navigation state that is not reactive on the App runtime.
   */
  active: string
}>()

/**
 * Declared here rather than taken from `pages.json`, because that file is
 * generated and its `tabBar.list` is exactly what this component replaces —
 * reading it would keep the native bar's registration alive.
 */
const TAB_BAR_ITEMS: TabBarItem[] = [
  { path: '/pages/sessions/index', label: '会话', icon: 'i-carbon:chat' },
  { path: '/pages/settings/index', label: '设置', icon: 'i-carbon:settings' },
]

const theme = useThemeStore()
const themeClass = computed(() => (theme.resolved === 'dark' ? 'theme-dark' : 'theme-light'))

/**
 * The indicator slides between entries instead of fading in place: the motion
 * is what tells the eye the tap was registered, which matters more on a bar
 * this short — with two entries the colour change alone is easy to miss.
 */
const activeIndex = computed(() => {
  const index = TAB_BAR_ITEMS.findIndex(item => item.path === props.active)

  return index === -1 ? 0 : index
})

/**
 * Navigates to a tab page.
 *
 * `switchTab`, not `reLaunch`. Both reach the page, but only `switchTab` leaves
 * the one being left alive — and that difference is what the bar was being
 * blamed for. Under `reLaunch` every tap rebuilt the target from scratch: its
 * `onShow` load re-ran, the list was empty until the reply arrived, and this
 * component was unmounted before its own slide could finish. The flicker was
 * the page being recreated, not the bar being redrawn.
 *
 * Valid only because the routes are registered in `pages.json`'s `tabBar.list`
 * — `switchTab` throws on a route that is not a tab. The platform bar that
 * registration implies is hidden in `App.vue`.
 *
 * Tapping the current entry is a no-op rather than a switch to the page already
 * on screen: the platform treats it as a navigation and resets the scroll
 * position, which reads as a glitch.
 */
function go(item: TabBarItem) {
  if (item.path === props.active)
    return

  uni.switchTab({ url: item.path })
}
</script>

<template>
  <view class="tabbar-wrap" :class="themeClass">
    <view
      class="tabbar"
      :style="{ '--tab-index': activeIndex, '--tab-count': TAB_BAR_ITEMS.length }"
    >
      <!--
        The sliding highlight lives behind the entries and is positioned by
        `--tab-index`, so the transition is one transform on one element rather
        than a class swap on two — the latter cannot animate between positions.
      -->
      <view class="tabbar-glow" />

      <view
        v-for="item in TAB_BAR_ITEMS"
        :key="item.path"
        class="tab"
        :class="{ 'tab-active': item.path === active }"
        @tap="go(item)"
      >
        <view class="tab-icon" :class="item.icon" />
        <text class="tab-label">{{ item.label }}</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@use '@/styles/tokens.scss' as *;

/**
 * The wrapper owns the safe-area inset, not the bar.
 *
 * Split this way so the bar itself can float with a margin on all four sides
 * while the inset below it stays the theme's page colour — if the bar carried
 * the padding, its rounded bottom edge would sit above a transparent gap and
 * the page would show through as a band in the wrong colour.
 */
.tabbar-wrap {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 100;
  /**
   * Side inset is its own value, wider than `$gap-page`.
   *
   * The page gutter is the margin a *content* column wants — 24rpx, enough to
   * keep text off the glass. A bar is not a column: at that margin it spanned
   * 702 of the 750rpx screen, which reads as a full-width band that happens to
   * have rounded corners rather than as a floating control. 96rpx a side is
   * what makes the two states look different.
   */
  padding: $gap-inline $gap-tabbar-inset calc(#{$gap-inline} + env(safe-area-inset-bottom, 0px));
  /* Transparent so the page's own background shows behind the floating bar;
     the page reserves room for it with `$gap-tabbar-clearance`. */
  background-color: transparent;
  pointer-events: none;
}

.tabbar {
  position: relative;
  display: flex;
  align-items: stretch;
  height: 108rpx;
  overflow: hidden;
  background-image: $gradient-tabbar;
  border: 1rpx solid $color-tabbar-border;
  border-radius: $radius-pill;
  /* Lifts the bar off the page: without it the translucent surface reads as a
     flat cut-out rather than a floating layer. */
  box-shadow: $shadow-tabbar;
  pointer-events: auto;
}

/**
 * The sliding highlight.
 *
 * Width is a fraction of the bar rather than a measured pixel value, so it
 * needs no layout read and cannot drift from the entries: both are `1/count` of
 * the same box. `translateX` is used instead of `left` because only transforms
 * are composited — an animated `left` would repaint the bar every frame.
 */
.tabbar-glow {
  position: absolute;
  top: 8rpx;
  bottom: 8rpx;
  left: 8rpx;
  width: calc((100% - 16rpx) / var(--tab-count));
  background-image: $gradient-tabbar-active;
  border-radius: $radius-pill;
  transform: translateX(calc(var(--tab-index) * 100%));
  transition: transform 280ms cubic-bezier(0.34, 1.4, 0.64, 1);
}

.tab {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
}

.tab-icon {
  font-size: 40rpx;
  color: $color-tabbar-icon;
  transition: color 220ms ease, transform 280ms cubic-bezier(0.34, 1.4, 0.64, 1);
}

.tab-label {
  font-size: $font-micro;
  color: $color-tabbar-icon;
  transition: color 220ms ease;
}

/**
 * The active entry rises slightly as it takes the highlight.
 *
 * The scale is on the icon alone, not the whole tab: scaling the label too
 * would shift the text baseline between states and make the bar look like it
 * is jittering as the user moves between the two entries.
 */
.tab-active {
  .tab-icon {
    color: $color-tabbar-icon-active;
    transform: translateY(-2rpx) scale(1.12);
  }

  .tab-label {
    color: $color-tabbar-icon-active;
    font-weight: 600;
  }
}
</style>
