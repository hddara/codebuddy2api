import { defineManifestConfig } from '@uni-helper/vite-plugin-uni-manifest'

/**
 * App manifest source of truth (`src/manifest.json` is generated from here).
 *
 * The identifiers below are placeholders on purpose: they must be replaced with
 * values owned by whoever publishes the app. `__UNI__HDDARA_AI` is a DCloud app
 * id, `cn.hddara.ai` is the Android package / iOS bundle id.
 */
export default defineManifestConfig({
  'name': 'HDdaraAi',
  'appid': '__UNI__HDDARA_AI',
  'description': '随时查看 AI 会话状态并回复',
  'versionName': '0.1.0',
  'versionCode': '100',
  'transformPx': false,
  'app-plus': {
    usingComponents: true,
    nvueStyleCompiler: 'uni-app',
    compilerVersion: 3,
    splashscreen: {
      alwaysShowBeforeRender: true,
      waiting: true,
      autoclose: true,
      delay: 0,
    },
    modules: {},
    distribute: {
      android: {
        package: 'cn.hddara.ai',
        minSdkVersion: 23,
        targetSdkVersion: 34,
      },
      ios: {},
      sdkConfigs: {},
    },
  },
  'h5': {
    router: {
      mode: 'history',
      base: '/',
    },
    title: 'HDdaraAi',
  },
  'mp-weixin': {
    // Replace with the mini-program appid before publishing.
    appid: '',
    setting: {
      urlCheck: false,
    },
    usingComponents: true,
  },
})
