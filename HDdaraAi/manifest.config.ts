import { defineManifestConfig } from '@uni-helper/vite-plugin-uni-manifest'

/**
 * App manifest source of truth (`src/manifest.json` is generated from here).
 *
 * `appid` is the DCloud application id of the `HDdaraAi` app in the developer
 * centre (dev.dcloud.net.cn). It is required for cloud packaging and for running
 * on a real iOS device, so it is no longer a placeholder.
 * `cn.hddara.ai` is the Android package / iOS bundle id.
 */
export default defineManifestConfig({
  'name': 'HDdaraAi',
  'appid': '__UNI__DC81923',
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
    // `Fingerprint` is deliberately NOT declared.
    //
    // Declaring the module does not add it — the offline shell only ships the
    // aars that are copied into `simpleDemo/libs/`, and this SDK drops no
    // fingerprint aar — but the declaration still makes `plus.fingerprint`
    // advertise itself, so the first call raises a blocking "打包时未添加
    // fingerprint 模块" dialog. That dialog cannot be dismissed from code and
    // took the whole cold start down.
    //
    // The lock screen instead treats biometrics as an opt-in enhancement and
    // never probes unless the user turns it on (see pages/login/index.vue).
    // Copying the aar in is what would make it actually work.
    modules: {},
    distribute: {
      android: {
        package: 'cn.hddara.ai',
        minSdkVersion: 23,
        targetSdkVersion: 34,
      },
      ios: {
        // iOS refuses to launch a process that requests Face ID without a usage
        // string — it terminates rather than prompting, so this is required for
        // the unlock screen to work at all on Face ID devices.
        privacyDescription: {
          NSFaceIDUsageDescription:
            '用于快速解锁 HDdaraAI，验证后才能查看你的会话数据。',
        },
      },
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
  // HarmonyOS bundleName. Deliberately identical to the Android package name and
  // the iOS bundle id, so the three platforms share one identifier.
  // The generated project is additionally overridden by `harmony-configs/`
  // (permissions can only be declared in module.json5).
  'app-harmony': {
    distribute: {
      bundleName: 'cn.hddara.ai',
    },
  },
  'mp-weixin': {
    // Replace with the mini-program appid before publishing.
    appid: '',
    setting: {
      urlCheck: false,
    },
    usingComponents: true,
  },
  // Required, not cosmetic: HBuilderX refuses to compile the HarmonyOS target
  // for a project it reads as Vue 2 ("目前 vue 2 项目尚不支持鸿蒙平台").
  'vueVersion': '3',
})
