# HDdaraAi 三平台离线打包参数清单与重建说明（iOS / Android / 鸿蒙）

> 壳工程 `HDdaraAi/dcloud-ios/`（含 DCloud iOS 离线 SDK，4.9G）被 `.gitignore` 排除，**不入版本库**。
> 本文件是它的「可重建说明书」+ 参数台账，换机/重克隆后照此恢复。
> 做法参考 `mall/docs/iOS离线打包与App参数清单.md`（同一套壳工程，同一 Apple 团队）。
>
> 最后核对：**2026-10-05 01:20**（首个可运行包，已装真机并启动成功）

---

## 0. 与 mall 项目的关键差异

| 项 | mall（梦想购） | HDdaraAi |
|---|---|---|
| uni-app appid | `__UNI__1CBF901` | **`__UNI__DC81923`** |
| Bundle ID | `cn.dreamshopping.shop` | **`cn.hddara.ai`** |
| DCloud iOS 离线 Key | `94a84819…69b7` | **`094ea8084a16d1eb18ca87a0c75131f8`** |
| 显示名 | 梦想购 | **HDdaraAi** |
| 资源投放目录 | `Pandora/apps/__UNI__1CBF901/www` | **`Pandora/apps/__UNI__DC81923/www`** |
| Apple 团队 | `ASQ257FU6F` | 同（**可以复用**） |

**appkey 与 Bundle ID 强绑定**：只要换 appid 或 Bundle ID，就必须去 DCloud 重新生成 Key，且 Info.plist 的值必须同步，否则 **App 启动即失败**。

---

## 1. 参数台账

| 项 | 值 | 落盘位置 |
|---|---|---|
| uni-app appid | `__UNI__DC81923` | `manifest.config.ts`（配置源）、`src/manifest.json`（生成物） |
| Bundle ID | `cn.hddara.ai` | `dcloud-ios/SDK/HBuilder-Hello/HBuilder-Hello.xcodeproj/project.pbxproj` → `PRODUCT_BUNDLE_IDENTIFIER` |
| 显示名 | HDdaraAi | `HBuilder-Hello-Info.plist` → `CFBundleDisplayName`，**以及** `zh-Hans.lproj`/`en.lproj` 的 `InfoPlist.strings`（本地化值优先级更高，只改主 plist 会显示成「HBuilder 你好」） |
| 版本 | `MARKETING_VERSION 0.1.0` / `CURRENT_PROJECT_VERSION 100` | `project.pbxproj`（与 `manifest.config.ts` 的 versionName/versionCode 同步升） |
| DCloud iOS 离线 Key | `094ea8084a16d1eb18ca87a0c75131f8` | `HBuilder-Hello-Info.plist` → `dcloud_appkey` |
| 离线 SDK | 5.26.0（`5.26.2026091402`） | 壳目录（不入库） |
| 资源投放目录 | `SDK/HBuilder-Hello/HBuilder-Hello/Pandora/apps/__UNI__DC81923/www` | 壳工程 |
| 签名 | 自动签名 `CODE_SIGN_STYLE=Automatic` + `-allowProvisioningUpdates -allowProvisioningDeviceRegistration` | `build-ipa.sh` |
| Apple 团队 | `ASQ257FU6F`（公司团队，`panyang jiang` 的 Apple Development 证书） | `project.pbxproj` 的 `DEVELOPMENT_TEAM` |
| 描述文件 | `iOS Team Provisioning Profile: *`（通配 `ASQ257FU6F.*`，**含设备 UDID**，有效至 2027-10-01） | `~/Library/Developer/Xcode/UserData/Provisioning Profiles/41008bf0-86c9-4186-8f0e-3d9a148cd0a9.mobileprovision` |
| 构建 Xcode | **26.6**（`/Users/hddara/Applications/Xcode.app`） | `build-ipa.sh` 的 `XCODE26_DIR` |
| 产物 | `dcloud-ios/build/ipa/HBuilder.ipa`（33 MB） | 壳目录（不入库） |

真机运行目标：**iPhone 12**（`iPhone13,2`），UDID `00008101-001E19923001401E`。

---

## 2. 打包链路

```bash
# 1) 生成 App 资源（必须先跑，否则壳里是旧资源）
cd HDdaraAi
env -u NODE_OPTIONS npx uni build -p app        # 产物：dist/build/app

# 2) 出包（脚本会 rsync 资源进壳的 Pandora 目录，再 archive + export）
cd dcloud-ios
./build-ipa.sh                                   # development（可直装真机）
#   ./build-ipa.sh ad-hoc | app-store            # 其它方式
#   TEAM=56N4V3XSFA ./build-ipa.sh               # 临时换个人免费团队
#   产物：dcloud-ios/build/ipa/HBuilder.ipa

# 3) 安装到真机（Xcode 26 的 devicectl）
export DEVELOPER_DIR=/Users/hddara/Applications/Xcode.app/Contents/Developer
export PATH="$DEVELOPER_DIR/usr/bin:$PATH"
xcrun devicectl device install app --device 00008101-001E19923001401E <解包后的 HBuilder.app>
xcrun devicectl device process launch --device 00008101-001E19923001401E cn.hddara.ai
```

---

## 3. 从零重建壳工程

| 步骤 | 操作 |
|---|---|
| 1 | 取 **iOS 离线 SDK 5.26**（DCloud 开发者中心 → 离线打包 SDK），解压后保持 `SDK/HBuilder-Hello/...` 结构 |
| 2 | 把 mall 的 `mall-app-ui/dcloud-ios/build-ipa.sh` 放回 `HDdaraAi/dcloud-ios/`，并按本文件 §1 改 `APPID="__UNI__DC81923"` |
| 3 | `project.pbxproj`：`PRODUCT_BUNDLE_IDENTIFIER=cn.hddara.ai`、`MARKETING_VERSION=0.1.0`、`CURRENT_PROJECT_VERSION=100`、`DEVELOPMENT_TEAM=ASQ257FU6F` |
| 4 | `HBuilder-Hello-Info.plist`：`dcloud_appkey=094ea8084a16d1eb18ca87a0c75131f8`、`CFBundleDisplayName=HDdaraAi`；**同时**改 `zh-Hans.lproj`/`en.lproj` 的 `InfoPlist.strings` |
| 5 | 资源目录 `Pandora/apps/__UNI__DC81923/www`（目录名必须与 appid 一致；由 `build-ipa.sh` 自动灌入）；**删掉 mall 的 `__UNI__1CBF901`** |
| 6 | 部署目标：`Podfile` 的 `post_install` 逐 target 设 `IPHONEOS_DEPLOYMENT_TARGET='15.0'`（5.26 podspec 声明 13.0，Xcode 26/27 最低 15.0）→ `pod install` |
| 7 | `HEADER_SEARCH_PATHS` 不要硬编码 `/Applications/Xcode.app/…`，改 `"$(DEVELOPER_DIR)/Toolchains/XcodeDefault.xctoolchain/usr/include"`（否则双 Xcode 头文件冲突报 `redefinition of module 'SwiftBridging'`） |
| 8 | **品牌资产**：运行 `python3 design/make-app-icon.py` 一次生成全部（见 §3.1），再改三个 storyboard 的 `text="HBuilder Hello"` 为产品名 |
| 9 | 🔴 **必须用 Xcode 26.x 出包**：iOS 27 起 Apple 强制「用最新 SDK 构建的 App」采用 UIScene，DCloud 5.26 壳仍是纯 AppDelegate ⇒ 用 Xcode 27 打的包在 iOS 27 上**启动即崩**。`build-ipa.sh` 已内置校验，产物 `DTSDKName` 必须是 `iphoneos26.*` |

### 3.1 品牌资产：图标与启动图

**一个脚本生成全部**，不要手工替换任何一张图：

```bash
cd HDdaraAi && python3 design/make-app-icon.py
```

产物与去向：

| 产物 | 目标位置 | 说明 |
|---|---|---|
| `design/app-icon-1024.png` | —— | 主图（母版），供预览与再分发 |
| `design/preview/*.png` | —— | 48/80/120/180 预览，用于检查小尺寸可读性 |
| （1024） | iOS `Assets.xcassets/AppIcon.appiconset/icon1024.png` | 新版 Xcode 单尺寸模式，**只需这一张** |
| （`dclogo@2x/@3x`） | iOS 壳根目录 | 启动图，**与 App 图标是两套资产**，容易只换一个 |
| （各 dpi） | Android `res/drawable-*/icon.png` | 常规图标（Manifest 的 `android:icon`） |
| （各 dpi） | Android `res/mipmap-*/ic_launcher.png` | `roundIcon` 兜底；**API < 26 会真的读它** |
| （各 dpi） | Android `res/drawable-*/icon_foreground.png` | 自适应前景，已限制在 66% 安全区内 |
| （各 dpi） | Android `res/drawable-*/icon_monochrome.png` | Android 13+ 主题图标；条形是**镂空**，系统着色后才有轮廓 |
| `design/palette.json` | —— | 配色与设计说明，改色时先看它 |

Android 侧另有两个**不在脚本里**的手写文件：

- `res/mipmap-anydpi-v26/ic_launcher.xml` —— 自适应图标定义（引用上面两个 drawable + 背景色）
- `res/values/ic_launcher_background.xml` —— 背景色 `#0A84FF`

> ⚠️ 背景色**必须等于**脚本里的 `GRADIENT_TOP`：自适应前景的条形用的是这个蓝，
> 一旦两侧不一致，条形会溶进背景，看起来像一条纯色方块。

> ⚠️ `mipmap-anydpi-v26` 只在 API 26+ 生效，所以 `mipmap-<dpi>` 的位图**不能省**，
> 否则 Android 7 及以下取值失败会**启动崩溃**（不是回退）。

**改图后必须重新打包**，图标是编译进 APK 的资源，不会热更：

```bash
cd dcloud-android/shell && JAVA_HOME=$HOME/Library/Java/JavaVirtualMachines/ms-21.0.11/Contents/Home \
  ./gradlew :simpleDemo:assembleRelease --no-daemon
```

自检（改完图标值得跑一次，确认进包的不是旧图）：

```bash
BT=$HOME/Library/Android/sdk/build-tools/36.1.0
APK=dcloud-android/shell/simpleDemo/build/outputs/apk/release/simpleDemo-release.apk
$BT/aapt dump badging $APK | grep application-icon   # 各密度应有独立条目
```

---

## 4. 踩过的坑（本项目特有）

1. **`$VAR` 紧跟中文标点会解析失败**：`build-ipa.sh` 里 `"…未找到 $PATCH_SCRIPT，跳过…"` 在 `set -u` 下报 `PATCH_SCRIPT，: unbound variable`。**修复：改用 `${PATCH_SCRIPT}`**。克隆脚本后必须检查同类写法（`$METHOD`/`$TEAM` 在 plist heredoc 里紧跟 `<` 是安全的，`$_SDK` 后缀「）」也需加花括号）。
2. **`tests/deploy/ios-shell-patch/patch-ios-review.py` 不在本仓库**：`build-ipa.sh` 会 warning 后跳过。只影响 App Store 审核用的权限文案裁剪，**开发直装不需要**；要上架需从 mall 拷该补丁目录。
3. **DCloud 云打包（HBuilderX `cli pack`）走不通**：HBuilderX 5.26 对 CLI 项目报「当前cli项目版本较低不支持App的运行和发行」，且把 `@dcloudio/*` 对齐到它内置的 `3.0.0-alpha-5020520260821001` 后**仍然报错**。结论：**本项目一律走离线壳工程打包，不要用云打包。**
4. **DCloud appid / 离线 Key 是两件事**：appid 在「应用列表 → 创建应用」拿；iOS 离线 Key 在「应用 → 各平台信息 → 新增(iOS App，填 BundleId) → 创建离线Key」。每个 AppID 前 6 个 Key 免费。
5. **壳工程的图标一直是 mall 的「梦想购」购物车**：`android:icon`、`AppIcon`、`dclogo`（启动图）**三处都要换**，而它们分散在 iOS/Android 两套壳里，容易只改一处。曾出现「App 图标换了但启动瞬间仍闪出购物车」的情况。**处置：统一走 `design/make-app-icon.py`（§3.1），不要手工替换。**
6. **`android:roundIcon` 需要 `@mipmap/ic_launcher` 在旧 API 上也能解析**：`mipmap-anydpi-v26/ic_launcher.xml` 从 API 26 起才存在，所以必须同时提供 `mipmap-<dpi>/ic_launcher.png` 位图，否则 Android 7 及以下**启动崩溃**。

---

## 5. 验收自检

```bash
unzip -o dcloud-ios/build/ipa/HBuilder.ipa -d /tmp/ipa-check
APP=$(ls -d /tmp/ipa-check/Payload/*.app)
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier"     "$APP/Info.plist"   # cn.hddara.ai
/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName"    "$APP/Info.plist"   # HDdaraAi
/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName"    "$APP/zh-Hans.lproj/InfoPlist.strings"
ls "$APP/Pandora/apps/"                                                        # 含 __UNI__DC81923
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier"      # ASQ257FU6F
```

⚠️ 客户端要连网关，`VITE_API_BASE_URL` 必须是公网可达地址（当前 `https://code.apimesh.cn`）；
`localhost`/局域网地址在真机上不可用。

---

# 二、Android 离线打包（2026-10-05 已出包并装机）

## 2.1 参数台账（Android 专属）

| 项 | 值 | 落盘位置 |
|---|---|---|
| Android 包名 | `cn.hddara.ai` | `manifest.config.ts` → `app-plus.distribute.android.package`；壳 `simpleDemo/build.gradle` → `applicationId` |
| 版本 | versionCode `100` / versionName `0.1.0` | 同上（与 iOS pbxproj、manifest 三处同步） |
| 签名证书 | `~/.android/hdara.keystore`（PKCS12，alias `hdara`，RSA2048，36500 天） | 本机（勿入库） |
| 证书密码 | `~/.android/hdara-keystore-pass.txt`（`KSTOREPASS=…`，600 权限） | 本机（勿入库） |
| 证书指纹 | SHA1 `BA:63:82:8C:00:C2:B0:7C:FB:B5:3B:CF:91:F9:20:0D:8F:45:61:C1`<br>SHA256 `7F:92:FE:C7:0C:41:B2:1C:77:22:B7:9C:BB:1C:57:93:46:06:DF:D3:D6:35:A7:5F:E4:B3:2E:80:93:E6:C5:EE` | 本文件（指纹非秘密） |
| DCloud Android 离线 appkey | **`37ffccc4374ecd389c947d117182d41d`** | 壳 `simpleDemo/src/main/AndroidManifest.xml` → `dcloud_appkey` |
| SDK | minSdk 21 / compileSdk 36 / targetSdk 34 / buildTools 36.1.0 | 壳 `build.gradle` |
| 资源目录 | `simpleDemo/src/main/assets/apps/__UNI__DC81923/www` | 壳工程（目录名必须 = appid） |
| appid 声明 | `simpleDemo/src/main/assets/data/dcloud_control.xml` → `appid="__UNI__DC81923"` | 壳工程 |
| 显示名 | HDdaraAi | `res/values/strings.xml` → `app_name` |
| 产物 | `shell/simpleDemo/build/outputs/apk/release/simpleDemo-release.apk`（29 MB） | 壳目录（不入库） |

**appkey 绑定 appid + 包名 + 证书 SHA256**，三者任一变化都要在 DCloud 重新申请（前 6 个免费）。
`namespace` 仍是 `com.mall.cloud` —— 它只影响 R 类与 Java 源码包名，与市场识别的包名无关，改它需同步移动 Java 源码，收益为零（沿用 mall 的判断）。

## 2.2 出包链路

```bash
# 1) 生成 App 资源（与 iOS 同一份产物）
cd HDdaraAi && env -u NODE_OPTIONS npx uni build -p app     # → dist/build/app

# 2) 投放资源（目录名 = appid；**先删旧 www 再 cp**，否则会嵌套成 www/app）
A=dcloud-android/shell/simpleDemo/src/main/assets/apps/__UNI__DC81923
rm -rf "$A/www" && cp -R dist/build/app "$A/www"

# 3) 打包
cd dcloud-android/shell
JAVA_HOME=$HOME/Library/Java/JavaVirtualMachines/ms-21.0.11/Contents/Home \
  ./gradlew :simpleDemo:assembleRelease --no-daemon

# 4) 装机
~/Library/Android/sdk/platform-tools/adb install -r simpleDemo/build/outputs/apk/release/simpleDemo-release.apk
```

## 2.3 验收自检

```bash
BT=$HOME/Library/Android/sdk/build-tools/36.1.0
APK=dcloud-android/shell/simpleDemo/build/outputs/apk/release/simpleDemo-release.apk
$BT/aapt dump badging $APK | head -2                       # package=cn.hddara.ai 100/0.1.0
$BT/apksigner verify --print-certs $APK                    # SHA-256 = 7f92fec7…e6c5ee
$BT/aapt dump xmltree $APK AndroidManifest.xml | grep -A2 dcloud_appkey
unzip -l $APK | grep -oE "__UNI__[A-Z0-9]+" | sort -u      # 只应出现 __UNI__DC81923
```

## 2.4 坑（本项目特有）

1. **壳内 `assets/apps/` 只允许放 `__UNI__DC81923/`**：mall 留下的 `www-bak-*` 若留在同目录会被整体打进 APK（实测 +10MB）。克隆后先 `rm -rf` 掉。
2. **`build.gradle` 的密码三级回退已改为 `HDARA_STORE_PASS` > 环境变量 > `~/.android/hdara-keystore-pass.txt`**。

---

# 三、鸿蒙离线打包（**已确认阻塞在上游，2026-10-05**）

## 3.1 已完成的准备工作（都做完了）

| 项 | 值 | 落盘位置 |
|---|---|---|
| HarmonyOS bundleName | `cn.hddara.ai` | `manifest.config.ts` → `app-harmony.distribute.bundleName` |
| `vueVersion` | `'3'` | `manifest.config.ts`（**必须**，但**不是**「vue2 不支持」报错的真实原因，见 3.3） |
| 工程覆盖 | `harmony-configs/`（AppScope 名称、entry 权限声明、build-profile.json5） | 项目根（`app_name` 已改 HDdaraAi；`signingConfigs` 已清空以走 unsigned） |
| 配置文件改名 | `vite.config.mts` → **`vite.config.ts`**、`uno.config.mts` → **`uno.config.ts`** | 项目根 |
| 包管理器 | 已切 **pnpm@9.9.0** + `.npmrc`（`shamefully-hoist=true` 等，从 mall 复刻） | 项目根 |
| 构建工具 | DevEco Studio + HBuilderX CLI | 本机已装 |

## 3.2 三次报错与处置

| # | 报错 | 真实原因 | 处置 |
|---|---|---|---|
| 1 | `目前 vue 2 项目尚不支持鸿蒙平台` | **不是** Vue 版本问题。HBuilderX 判定 CLI 项目 Vue 版本时要求项目根存在 **`vite.config.js` / `vite.config.ts`**；本项目用的是 `.mts`（mall 用 `.ts`） | ✅ 已改名 `.ts` |
| 2 | `"isInSSRComponentSetup" is not exported by vue` | 该符号 Vue **3.5** 才引入，项目 pin 的是 `~3.4.38` | 试过升级，见下 |
| 3 | 升 Vue 3.5 后 → `"normalizeCssVarValue" is not exported by @vue/shared` | `@dcloudio/*` 把 `@vue/shared` 钉在 `3.4.21` | 试过 `overrides` 统一，见下 |

## 3.3 关键结论：**上游依赖自相矛盾，两边都出不了包**

三次尝试（Vue 3.5 单升 → `overrides` 统一 `@vue/*` → 切 **pnpm@9.9.0** 复刻 mall 的
`shamefully-hoist=true` 链接方式）**都复现同一个错**，且最后做了逐字节对照：

| 对照项 | mall | HDdaraAi |
|---|---|---|
| `@dcloudio/uni-app` 版本 | `3.0.0-5020620260917001` | 同 |
| `uni-app.es.js` sha256 | `e074a2c1…12d0` | **完全相同** |
| 该文件是否 import `isInSSRComponentSetup` | **是** | 是 |
| 根 `vue` 版本 | `3.4.38` | 同 |
| `vue.runtime.esm-bundler.js` 是否含该符号 | **否** | 否 |
| `.pnpm` 内 `@vue/shared` 份数 | 3.4.21 + 3.4.38 | 3.4.21 + 3.4.38 + 3.5.43 |

**即：`@dcloudio/uni-app` 的代码需要只有 Vue 3.5 才提供的 `isInSSRComponentSetup`，
而 `@dcloudio/*` 自己又把 `@vue/shared` 钉在 3.4.21 —— 上游包自身矛盾。
mall 用完全相同的依赖组合，因此同样无法在当前依赖下出鸿蒙包。**

时间线也吻合：mall 的鸿蒙链路是 **2026-09-19 跑通**的（`1fc83d89` / `0b92fe98`），
而 `@dcloudio/*` 升到当前版本是**同一天**的 `8c956a89`；现有产物是 09-21 / 10-02 的
`.app` —— 也就是**依赖升级与出包在同一窗口内发生，之后未再验证过鸿蒙链路**。

## 3.4 保持一致性

为了不让「源码依赖」与「已验证的 iOS / Android 产物」分叉，Vue 3.5 与 `overrides` 已**回退**，
iOS 与 Android 包已用最终源码**重出并重装验证**。**pnpm 切换保留**（与 mall 一致，构建正常）。

## 3.5 可选出路

| 方案 | 说明 | 评价 |
|---|---|---|
| A. 把 `@dcloudio/uni-app` 钉回 09-19 之前的版本 | 需先确认哪个版本不引用 3.5-only API | **最可能可行**；但会影响已答通的 iOS/Android 包，需重出复验 |
| B. 打 patch 去掉对 `isInSSRComponentSetup` 的依赖 | mall 已有 `patches/` 先例（wot-design-uni）；但这是运行时 API，改动风险高于纯编译期 patch | 有风险，需实测三个平台 |
| C. 查 `@vue/shared` 为何未带该符号 | 3.4.21 与 3.4.38 都不带 ⇒ 上游把 API 与 peer 版本配错了 | 仅供说明，不构成解法 |
| D. 等 uni-app 修复上游矛盾 | 被动等待 | 兜底 |

> 建议：先查 **A**（找 09-19 之前可用的 `@dcloudio/*` 版本），不行再评估 B。
> 若不接受动依赖组合，鸿蒙这条线需等 DCloud 修上游 —— iOS / Android 两个平台不受影响。

---

# 四、真机联调踩到的 4 个真实缺陷（2026-10-05，已修）

App 装上真机后「设置里保存了凭据，一开却提示未登录 / 请求打到线上网关」，逐个排掉后
定位到 **4 个代码级缺陷**，都不是打包问题：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 凭据保存后冷启动就丢 | App 端 storage 底层是 `plus.storage`，Pinia 插件在 5+ runtime 就绪**之前**执行；此时 `uni.setStorageSync` **不抛错、也不写入**（静默丢弃） | `persist.ts` 改为**写入后读回校验，失败则重试**（最多 12 次 × 500ms）；并把快照**序列化成 JSON 字符串**再存（直接存对象在部分 runtime 会读回空值） |
| 2 | 恢复后 `isLoggedIn` 仍是 false | `persist.ts` 直接给 `store.$state` 整体赋值，Pinia 不会可靠通知订阅者；且派生字段 `isLoggedIn` 没有被重算 | 改用 `store.$patch()`；新增 `syncLoginState()` 并在 `App.vue` 的 `onLaunch` 调用 |
| 3 | **设置页填的网关地址完全没生效**，请求一直打到编译期的线上地址 | `base-url.ts` 的选路只用「远端配置 + 编译期候选」，**从未读取设置页填的 `baseUrl`** | 新增 `readManualBaseUrl()`，**手填地址优先级最高**（本机/LAN/`adb reverse` 地址本来就不会出现在远端配置里） |
| 4 | 保存好的凭据会**自己消失** | `handlers.ts` 里**任意一个** 401/403 都会无条件 `setAdminCookie('')`；而冷启动时多个请求并发，首个未就绪的 401 就把凭据清掉了 | 改为**连续 2 次**鉴权失败才清（成功即清零计数） |

## 服务端配套改动

`lib/server/admin/session.ts`：控制台会话令牌现在同时接受两种传递形式 ——

- `Cookie: codebuddy_admin_session=<token>`（浏览器原生形态）
- `Authorization: Bearer <token>`（原生客户端兜底）

原因：部分 App / 小程序 runtime **拒绝设置 `Cookie` 头**。注意 bearer 里必须是**裸 token**，
不能带 `codebuddy_admin_session=` 前缀，否则会把名字一起哈希进去而校验失败。
这只是放宽传输方式，**令牌本身没变**，鉴权强度不变。

## 可观测性

- 设置页新增**存储探针**（显示 `存储：cookie(67) / <地址>`），因为正式版 App 沙盒无法用
  `adb` 查看，这是判断「到底写没写进去」的唯一手段。
- 保存时做读回校验，失败会显示「保存未生效」而不是假报「已保存」。

## 联调小抄（Android）

```bash
adb reverse tcp:8001 tcp:8001          # 手机 127.0.0.1:8001 → 本机 8001
adb shell pm clear cn.hddara.ai        # 想从零验证时用（会清掉存储）
adb shell input tap 545 428            # 设置页「网关地址」框（1088x2400 布局下的实测坐标）
adb shell input tap 545 907            # 「控制台 Cookie」框
```

⚠️ **不要连续 `adb shell input text` 往同一个框里灌值** —— 它不会先清空，会**追加**，
很容易把地址拼成 `http://127.0.0.1:8001http:http://...` 这种坏串（本次就踩了）。
先点框 → `keyevent 123`（到行尾）→ 多次 `keyevent 67`（退格）清空 → 再输入。

⚠️ **华为等 ROM 会保活**：`am force-stop` 后进程仍在（非 root 杀不掉），
所以「冷启动」验证要认准 `am force-stop` 后 `ps` 里进程真的消失。

---

# 五、DCloud 后台状态（2026-10-05 核对）

应用：**`HDdaraAi`** / appid **`__UNI__DC81923`**（账号 `928***@qq.com`）

> 注：创建时输入框未生效，DCloud 用了默认名「家务小帮手」。已改为 `HDdaraAi`。
> **若后续重新创建应用，务必在创建后立刻回列表确认名称**（创建页的输入框对自动化输入不敏感）。

各平台信息（路径：应用 → 各平台信息）：

| 序号 | 平台 | 版本 | 包名 | 创建时间 | 离线 Key |
|---|---|---|---|---|---|
| 1 | Android App | 正式版 | `cn.hddara.ai` | 2026/10/05 01:41 | `37ffccc4374ecd389c947d117182d41d` |
| 2 | iOS App | 正式版 | `cn.hddara.ai` | 2026/10/05 01:14 | `094ea8084a16d1eb18ca87a0c75131f8` |

**免费额度**：每个 AppID 前 **6 个**不同离线打包 Key 免费；修改包名或 SHA1 会占用新名额，
且删除 Key/包名/应用后**已用名额不释放**。当前只用了 2 个。

## 三个 Key 各归何处（不要弄混）

| Key | 绑定 | 写在哪里 |
|---|---|---|
| iOS Key `094ea8084a…31f8` | appid + Bundle ID `cn.hddara.ai` | 壳工程 `HBuilder-Hello-Info.plist` → `dcloud_appkey` |
| Android Key `37ffccc4374ecd…d41d` | appid + 包名 `cn.hddara.ai` + 证书 SHA1 | 壳工程 `AndroidManifest.xml` → `dcloud_appkey` |
| HarmonyOS | —— | 鸿蒙走 AGC 签名，与上面两个无关 |

---

# 六、真机联调：ngrok 隧道（IP 直连不通时用这个）

当手机与网关不在同一网段、无法直连服务器 IP 时，用 ngrok 把本地/自建网关暴露成公网 HTTPS。

```bash
# 1) 起隧道（本机 8001 = 网关）
ngrok http 8001 --log=stdout > /tmp/ngrok.log 2>&1 &

# 2) 取公网地址
curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "
import json,sys
for t in json.load(sys.stdin)['tunnels']: print(t['public_url'])
"

# 3) 在 App 设置页把「网关地址」填成该 https 地址（如
#    https://frying-bootie-flattery.ngrok-free.dev），**不要**再用 127.0.0.1
```

要点：

- **必须用 `https://` 那个地址**。ngrok 同时给 http/https，App 端走 https 才稳。
- ngrok 免费版的浏览器插页**不影响 App**：插页只对带 `Accept: text/html` 的浏览器请求返回，
  App 的 `uni.request` 不会被拦。若无故被拦，可在请求头加 `ngrok-skip-browser-warning: 1`。
- **`adb reverse tcp:8001 tcp:8001` 与 ngrok 二选一**：前者仅 USB 调试时有效，且重装 APK 会失效；
  后者对真机走公网、更接近真实使用。验证时先 `adb reverse --remove-all` 把反向隧道清掉，
  否则你分不清请求到底走了哪条路。
- 免费隧道**重启后域名会变**，每次改完地址记得回设置页重新保存。
- 请求是否真的经过隧道，看 `/tmp/ngrok.log` 里的 `join connections` 行；
  本机出口 IP 会显示为手机的公网 IP（如 `r=120.229.69.50`），这是判断「确实来自手机」的铁证。
