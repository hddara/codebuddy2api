import { defineUniPages } from '@uni-helper/vite-plugin-uni-pages'

/**
 * Page manifest source of truth.
 *
 * `src/pages.json` is generated from this file on every build — edit here, not
 * there (hand edits to `src/pages.json` are silently overwritten).
 */
export default defineUniPages({
  globalStyle: {
    backgroundColor: '#f5f6f8',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTextStyle: 'black',
    navigationBarTitleText: 'HDdaraAi',
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
   * No `tabBar` block, on purpose.
   *
   * The native bar is composited above the webview by the platform and cannot
   * be restyled — `uni.setTabBarStyle` takes a `backgroundColor` and ignores it
   * on the App runtime, which is why a white strip survived every dark-mode
   * attempt. It also reserves its height in the layout, ruling out a floating
   * or translucent treatment.
   *
   * The bar is drawn by `components/AppTabBar.vue` instead, mounted by the two
   * root pages it used to address. Consequences that are easy to miss:
   *   - `uni.switchTab` no longer works on these routes (they are not in
   *     `tabBar.list` any more); navigation uses `reLaunch`.
   *   - the pages must reserve room for the bar themselves, via
   *     `$gap-tabbar-clearance`.
   */
})
