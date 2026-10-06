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
      // Holds the conversation overview: both the live reply and the stored
      // turns are entries from here, not content rendered in place.
      path: 'pages/sessions/live',
      style: {
        navigationBarTitleText: '实时回复',
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
  ],
  tabBar: {
    color: '#8a8f99',
    // Matches the accent used everywhere else (active chip, links, primary
    // button) so the selected tab reads as the same system, not a separate one.
    selectedColor: '#0a84ff',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    // `black` would be the default and draws a 2px line in every runtime;
    // `white` keeps the bar flat against the page and lets the shadow do the
    // separating.
    fontSize: '11px',
    iconWidth: '24px',
    spacing: '4px',
    list: [
      {
        pagePath: 'pages/sessions/index',
        text: '会话',
        // Absolute paths are required: a relative one resolves against the
        // current page on App and silently shows no icon.
        iconPath: '/static/tabbar/chat.png',
        selectedIconPath: '/static/tabbar/chat-active.png',
      },
      {
        pagePath: 'pages/settings/index',
        text: '设置',
        iconPath: '/static/tabbar/gear.png',
        selectedIconPath: '/static/tabbar/gear-active.png',
      },
    ],
  },
})
