import { defineUniPages } from '@uni-helper/vite-plugin-uni-pages'

/**
 * Page manifest source of truth.
 *
 * `src/pages.json` is generated from this file on every build — edit here, not
 * there (hand edits to `src/pages.json` are silently overwritten).
 */
export default defineUniPages({
  globalStyle: {
    /**
     * The strip a bounce reveals, resolved per theme at build time.
     *
     * These are the only colours in the app that no stylesheet and no runtime
     * call can reach, so `theme.json` is the one mechanism left. Every other
     * surface is painted by CSS variables from `themeStore`, which follow the
     * user's `light`/`dark`/`system` choice — but this strip is a native layer
     * below the document, and its value is baked in when the app is built.
     *
     * Two routes were tried and are worth not repeating:
     *
     * 1. `webview.setStyle({ bounceBackground })` — no effect on this runtime.
     * 2. `uni.setBackgroundColor` — **the API does not exist on App**. It is
     *    read as `undefined`, so the optional call short-circuits and the
     *    existing invocation had never run once. Measured on device, not
     *    inferred.
     *
     * `@name` references `theme.json`, which the platform reads when the
     * system theme changes. That makes the strip follow the *system* setting
     * rather than the in-app one, and the two can disagree: a user who picks
     * "浅色" on a dark phone gets a dark strip. That is the one place the app
     * cannot honour the in-app choice, and it is the trade for the strip not
     * being white on every dark screen.
     */
    'backgroundColor': '@bgColor',
    'backgroundColorTop': '@bgColorTop',
    'backgroundColorBottom': '@bgColorBottom',
    'navigationBarBackgroundColor': '@navBgColor',
    'navigationBarTextStyle': '@navTxtStyle',
    'navigationBarTitleText': 'HDdaraAi',
    /**
     * Turns off the rubber-band bounce on every page.
     *
     * This is what actually removes the white band, and it removes it by
     * removing the thing that revealed it. A bounce drags the whole webview off
     * its position; the strip left behind is a native layer below the document,
     * painted from `globalStyle`, which is a build-time value that can hold one
     * theme. Colouring that strip was the goal of the `theme.json` block above
     * — this makes the effort unnecessary for the pull case, because there is
     * no longer a pull.
     *
     * Nothing is lost by turning it off. The App had no pull-to-refresh to
     * begin with: `enablePullDownRefresh` is not set on any page, so the
     * gesture produced only the overscroll, never a refresh. The docs warn that
     * `bounce: 'none'` breaks `default`-style pull-to-refresh on iOS — which
     * only matters if one is configured, and none is.
     *
     * `theme.json` stays as well, because the strip can still be reached: the
     * pages are `App`-runtime Vue pages, where a bounce on an inner
     * `scroll-view` is a separate mechanism from the page-level one this turns
     * off. The two are complementary rather than redundant.
     */
    'app-plus': {
      bounce: 'none',
    },
  },
  pages: [
    {
      // The lock screen is the entry point, not the session list: the app must
      // establish who the user is before it shows anything about their traffic.
      // It is a normal page (no tabBar), so there is nothing to tap past it.
      path: 'pages/login/index',
      style: {
        navigationBarTitleText: '登录',
        navigationStyle: 'custom',
      },
      type: 'home',
    },
    {
      path: 'pages/sessions/index',
      style: {
        navigationBarTitleText: '会话',
      },
    },
    {
      path: 'pages/sessions/detail',
      style: {
        navigationBarTitleText: '会话详情',
      },
    },
    {
      // Holds the live reply and the composer.
      //
      // `softinputMode: adjustResize` is what makes the composer usable: the
      // input bar is `position: fixed; bottom: 0`, and the App runtime's default
      // (`adjustPan`) leaves the webview viewport alone while the native keyboard
      // covers the bottom of the screen — so the input the user just tapped was
      // hidden behind the keyboard. `adjustResize` shrinks the viewport instead,
      // which lifts a bottom-anchored element with it.
      path: 'pages/sessions/live',
      style: {
        'navigationBarTitleText': '实时回复',
        'app-plus': {
          softinputMode: 'adjustResize',
        },
      },
    },
    {
      path: 'pages/sessions/transcript',
      style: {
        navigationBarTitleText: '问答详情',
      },
    },
    {
      path: 'pages/settings/index',
      style: {
        navigationBarTitleText: '设置',
      },
    },
    {
      // Split out of `settings/index`, which had accumulated nine unrelated
      // settings on one screen.
      path: 'pages/settings/connection',
      style: {
        navigationBarTitleText: '连接配置',
      },
    },
    {
      // Account management: who is signed in and how they sign in.
      //
      // A sub-page of settings rather than a third tab: the tab bar is for the
      // two things the app is opened to do, and these are occasional
      // maintenance, entered deliberately.
      path: 'pages/account/index',
      style: {
        navigationBarTitleText: '账户管理',
      },
    },
    {
      path: 'pages/account/usage',
      style: {
        navigationBarTitleText: '账户数据',
      },
    },
    {
      path: 'pages/credentials/index',
      style: {
        navigationBarTitleText: '凭证管理',
      },
    },
    {
      path: 'pages/credentials/keys',
      style: {
        navigationBarTitleText: '访问密钥',
      },
    },
  ],
  /**
   * Registered, then hidden at runtime — the two are separate steps.
   *
   * `tabBar.list` is what makes a route count as a tab page, and only
   * `uni.switchTab` keeps the pages alive across a switch. That matters here
   * for a reason that shows up as a visual bug: the alternative, `reLaunch`,
   * destroys the page it leaves and rebuilds the one it enters, so every tap
   * re-ran the target's `onShow` load, left an empty list until the reply
   * arrived, and unmounted `AppTabBar` before its slide could play. The bar
   * looked like it was flickering; the pages were being recreated under it.
   *
   * The platform bar that the registration implies is hidden with
   * `uni.hideTabBar()` (see `App.vue`). It has to be *registered and hidden*,
   * not omitted — dropping the block makes `switchTab` throw, which is why the
   * earlier revision of this file went without and used `reLaunch` instead.
   * `custom: true` would be the declarative way to ask for the same thing, but
   * the page table lists it for 微信小程序 / 抖音小程序 only; on App it is
   * ignored and the native bar stays visible, on top of ours.
   *
   * The values below are never seen — they exist because the block must be
   * well-formed. `backgroundColor` is set to the page colour anyway so that the
   * instant before `hideTabBar()` lands is not a white flash on a dark theme.
   */
  tabBar: {
    color: '#8a8f98',
    selectedColor: '#3b82f6',
    backgroundColor: '#f5f6f8',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/sessions/index',
        text: '会话',
      },
      {
        pagePath: 'pages/settings/index',
        text: '设置',
      },
    ],
  },
})
