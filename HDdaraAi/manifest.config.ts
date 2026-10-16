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
    /**
     * Keeps the launch webview full-screen, under the home indicator.
     *
     * The compiler sets this itself — but **only when no `tabBar` is
     * registered**. `initSafearea` in `@dcloudio/uni-cli-shared` branches on
     * exactly that: with a tab bar it writes a `safearea` block instead, and
     * the `render: 'always'` that the else-branch would have applied is never
     * emitted. The webview is then laid out above the inset, leaving a band at
     * the bottom painted by the container rather than by the page.
     *
     * We do register a tab bar — it is what makes `switchTab` legal, and
     * `switchTab` is what keeps the tab pages alive — so the branch that would
     * have done this no longer runs, and the value has to be set explicitly.
     *
     * Note the bar registered in `pages.config.ts` is hidden at runtime
     * (`utils/native-tabbar.ts`); this flag is unrelated to that. It concerns
     * the webview's own height, not the platform's bar.
     */
    launchwebview: {
      render: 'always',
    },
    /**
     * Stops the platform reserving the home-indicator strip at the bottom.
     *
     * With `offset: 'auto'` (the compiler's default whenever a `tabBar` is
     * registered — see above) the webview is laid out above the inset and the
     * band below it is painted by the container, not by the page. It measures
     * 34pt on an iPhone 12 and shows up as a seam: the container's colour is
     * `#f4f7f8` where the page uses `#f5f6f8`, so the page looks like it stops
     * one shade short of the screen edge, and on a dark theme the difference is
     * a light strip under a dark page.
     *
     * `'none'` gives the webview the full screen height instead. The bar floats
     * over the content and the pages already reserve room for it
     * (`$gap-tabbar-clearance`, which includes `env(safe-area-inset-bottom)`),
     * so nothing ends up under the home indicator once this is off.
     */
    safearea: {
      background: '#f5f6f8',
      backgroundDark: '#16181c',
      bottom: {
        offset: 'none',
      },
    },
    splashscreen: {
      alwaysShowBeforeRender: true,
      waiting: true,
      autoclose: true,
      delay: 0,
    },
    // `Fingerprint` is declared because **iOS ships the module and Android does
    // not** — and the difference is in the shell, not in this flag.
    //
    // Measured: `dcloud-ios/SDK/SDK/Libs` contains the whole Face ID stack
    // (`DTFIdentityManager`, `DTFSensorServices`, `DTFUIModule`, `DTFUtility`,
    // `libDCUniFaceID.a`, `liblibFingerprint.a`), while `dcloud-android/shell/
    // simpleDemo/libs` holds only its five base aars and no fingerprint library
    // at all.
    //
    // The flag does not add a module that is missing; it lets a *present* one
    // advertise itself. So on iOS this is what makes Face ID reachable, and on
    // Android it stays absent — which is the state the previous comment was
    // describing when it concluded the module could not be used anywhere. That
    // conclusion held for Android and was wrong for iOS, and an iPhone was
    // telling users "this build has no fingerprint module" while shipping one.
    //
    // The lock screen still treats biometrics as an opt-in enhancement and never
    // probes unless the user turns it on (see pages/login/index.vue), so a build
    // without a working module degrades to the credential form rather than
    // raising the undismissable "模块未添加" dialog.
    modules: {
      Fingerprint: {},
    },
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
            '用于快速解锁 HDdaraAi，验证后才能查看你的会话数据。',
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
