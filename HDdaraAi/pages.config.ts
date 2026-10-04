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
      path: 'pages/sessions/index',
      style: {
        navigationBarTitleText: '会话',
      },
      type: 'home',
    },
    {
      path: 'pages/sessions/detail',
      style: {
        navigationBarTitleText: '会话详情',
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
    selectedColor: '#0a84ff',
    backgroundColor: '#ffffff',
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
