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
| 8 | 启动图品牌化：`dclogo@2x/@3x.png` 换成产品图标，三个 storyboard 的 `text="HBuilder Hello"` 改成产品名 |
| 9 | 🔴 **必须用 Xcode 26.x 出包**：iOS 27 起 Apple 强制「用最新 SDK 构建的 App」采用 UIScene，DCloud 5.26 壳仍是纯 AppDelegate ⇒ 用 Xcode 27 打的包在 iOS 27 上**启动即崩**。`build-ipa.sh` 已内置校验，产物 `DTSDKName` 必须是 `iphoneos26.*` |

---

## 4. 踩过的坑（本项目特有）

1. **`$VAR` 紧跟中文标点会解析失败**：`build-ipa.sh` 里 `"…未找到 $PATCH_SCRIPT，跳过…"` 在 `set -u` 下报 `PATCH_SCRIPT，: unbound variable`。**修复：改用 `${PATCH_SCRIPT}`**。克隆脚本后必须检查同类写法（`$METHOD`/`$TEAM` 在 plist heredoc 里紧跟 `<` 是安全的，`$_SDK` 后缀「）」也需加花括号）。
2. **`tests/deploy/ios-shell-patch/patch-ios-review.py` 不在本仓库**：`build-ipa.sh` 会 warning 后跳过。只影响 App Store 审核用的权限文案裁剪，**开发直装不需要**；要上架需从 mall 拷该补丁目录。
3. **DCloud 云打包（HBuilderX `cli pack`）走不通**：HBuilderX 5.26 对 CLI 项目报「当前cli项目版本较低不支持App的运行和发行」，且把 `@dcloudio/*` 对齐到它内置的 `3.0.0-alpha-5020520260821001` 后**仍然报错**。结论：**本项目一律走离线壳工程打包，不要用云打包。**
4. **DCloud appid / 离线 Key 是两件事**：appid 在「应用列表 → 创建应用」拿；iOS 离线 Key 在「应用 → 各平台信息 → 新增(iOS App，填 BundleId) → 创建离线Key」。每个 AppID 前 6 个 Key 免费。

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

# 三、鸿蒙离线打包（**当前阻塞**，2026-10-05）

## 3.1 已完成的准备工作

| 项 | 值 | 落盘位置 |
|---|---|---|
| HarmonyOS bundleName | `cn.hddara.ai` | `manifest.config.ts` → `app-harmony.distribute.bundleName` |
| `vueVersion` | `'3'` | `manifest.config.ts`（**必须**，否则 HBuilderX 报「目前 vue 2 项目尚不支持鸿蒙平台」） |
| 工程覆盖 | `harmony-configs/`（AppScope 名称、entry 权限声明、build-profile.json5） | 项目根（`app_name` 已改 HDdaraAi；`signingConfigs` 已清空以走 unsigned） |
| 构建工具 | DevEco Studio（`/Applications/DevEco-Studio.app`）+ HBuilderX CLI | 本机已装 |

## 3.2 卡在哪

已排掉前两个错，停在第三个：

1. ✅ `目前 vue 2 项目尚不支持鸿蒙平台` → **已修**。真实原因不是 vue 版本，而是 HBuilderX 判定 CLI 项目 Vue 版本时要求项目根存在 **`vite.config.js` 或 `vite.config.ts`**；本项目用的是 `vite.config.mts` / `uno.config.mts`（mall 用的是 `.ts`）。已重命名为 `.ts`。
2. ✅ `"isInSSRComponentSetup" is not exported by vue` → 该符号 Vue 3.5 才引入，而项目 pin 的是 `~3.4.38`。
3. ❌ **当前阻塞**：把 `vue` 升到 3.5.43（并用 npm `overrides` 把 `@vue/*` 全部统一到 3.5.43）后，报错变成
   `"normalizeCssVarValue" is not exported by @vue/shared`（该符号 3.5.4+ 才有），
   再统一后又回到 `isInSSRComponentSetup` —— **像是有另一份旧的 `@vue/shared` 参与解析**，
   但实测项目 `node_modules` 下只有一份 `vue@3.5.43`。

根因指向 **uni-app `3.0.0-5020620260917001` 的依赖自相矛盾**：它的 `@dcloudio/*` 包把
`@vue/shared` 钉在 `3.4.21`，而它自己的 `uni-app.es.js` 却 import 只有 3.5 才有的
`isInSSRComponentSetup`。**mall 项目用的是同一版本、同一 Vue 3.4.38**，其
`release/harmony/*.app` 是 2026-09-21 / 10-02 的产物 —— 因此怀疑 **mall 的鸿蒙链路在 09-17
依赖升级后同样已不可复现**（当时的包是用升级前的依赖组合打出来的）。

## 3.3 为保持一致性已回退

为避免「源码依赖」与「已验证的 iOS/Android 产物」不一致，Vue 3.5 与 `overrides` 已**全部回退**到
`vue 3.4.38` / `@vue/shared 3.4.21`（即产出可用包的那套组合）。

## 3.4 下一步可选路径

| 方案 | 说明 | 代价 |
|---|---|---|
| A. 向 mall 侧求证 | 问清 mall 的鸿蒙包当时用的依赖组合/是否打了 patch（`mall-app-ui/patches/` 下已有 wot-design-uni 的 patch 先例） | 需要一次沟通 |
| B. 用 pnpm 复刻 mall | mall 用 pnpm，npm 的扁平化 hoisting 与 pnpm 的严格链接不同，很可能就是解析差异的来源。用 pnpm 重装后重试 | 中等（要改包管理器） |
| C. 等 uni-app 修上游 | 该依赖矛盾是上游问题，等 DCloud 在新版本中对齐 `@vue/shared` | 被动 |
| D. 走云端打包 | 与当前结论相反（HBuilderX 云打包对 CLI 项目版本校验走不通），不建议 | —— |

> 我的建议：**先试 B**（pnpm 复刻 mall 的链接方式，改动可控、可回退），再考虑 A。
