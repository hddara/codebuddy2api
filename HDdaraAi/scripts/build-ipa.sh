#!/usr/bin/env bash
# iOS 离线打包出 IPA —— uni-app 5.26.0 离线 SDK（dcloud-ios）
#
# 用法:
#   ./build-ipa.sh                            # development 方式导出 IPA（默认）
#   ./build-ipa.sh ad-hoc                     # Ad Hoc（描述文件需含设备 UDID）
#   ./build-ipa.sh app-store                  # App Store / TestFlight
#   TEAM=56N4V3XSFA ./build-ipa.sh            # 临时改用免费个人团队签名
#
# ⚠️⚠️ Xcode 版本（2026-09-30 起强制）= Xcode 26.x ⚠️⚠️
#   背景：iOS 27 起 Apple 强制要求「用最新 SDK 构建的 App」采用 UIScene 生命周期，
#        否则启动即崩（UIKit 主动 trap：UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption）。
#        DCloud uni-app 5.26 离线 SDK 的壳仍是纯 AppDelegate 模式，未适配 ⇒ 用 Xcode 27
#        （iphoneos27.0 SDK）打出的包在 iOS 27 设备上 **开启即闪退**（App Store 审核
#        Guideline 2.1(a) 以此被拒）。
#        规避：改用 Xcode 26.x（iphoneos26.5 SDK）构建 —— 不属于 "built with the latest SDK"，
#        iOS 27 不会触发该强制检查。官方文档原文见
#        https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle
#        待 DCloud 发布适配 UIScene 的新版离线 SDK 后，方可改回 Xcode 27+。
#
#   Xcode 26 安装位置（本机）：/Users/hddara/Applications/Xcode.app
#   指定方式：环境变量 XCODE26_DIR（默认自动探测 ~/Applications/Xcode.app），
#            脚本会把它的 usr/bin 前置到 PATH 并设 DEVELOPER_DIR —— 不修改全局 xcode-select，
#            因此不影响系统里 Xcode 27 的日常使用。
#   校验：脚本在 archive 后自动检查产物 Info.plist 的 DTSDKName 必须为 iphoneos26.*，
#        若为 iphoneos27.* 直接报错退出（防止误用 Xcode 27 白打一版）。
#
# 前置条件（缺一不可）:
#   1. Xcode → Settings → Accounts 已登录 Apple 账号，且该账号可自动生成 Development 证书与描述文件
#      （若报 "Unable to log in with account ... were rejected"，说明登录态失效，需重新登录）
#   2. HBuilder-Hello-Info.plist 的 dcloud_appkey 已填 iOS 离线打包 Key
#      （DCloud 开发者中心 → 应用 → 各平台信息 → iOS；绑定 appid + Bundle ID）
set -euo pipefail

# 脚本位于 HDdaraAi/scripts/，而壳工程在 HDdaraAi/dcloud-ios/ —— 之所以不把脚本放进
# 壳工程，是因为 `dcloud-ios/` 整体被 .gitignore 排除，脚本跟着一起不入库，换机后就没了。
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # HDdaraAi/
ROOT="$APP_ROOT/dcloud-ios"
PROJ="$ROOT/SDK/HBuilder-Hello"
APP_SRC="$PROJ/HBuilder-Hello"                    # 应用资源目录（Pandora 在此）
APPID="__UNI__DC81923"
METHOD="${1:-development}"
TEAM="${TEAM:-ASQ257FU6F}"                        # 默认公司团队
RES_SRC="$APP_ROOT/dist/build/app"                # uni build -p app 的产物
WWW="$APP_SRC/Pandora/apps/$APPID/www"
BUILD="$ROOT/build"
ARCHIVE="$BUILD/HBuilder.xcarchive"
EXPORT_DIR="$BUILD/ipa"
OPT_PLIST="$BUILD/ExportOptions.plist"

# ---- 选择构建用的 Xcode（强制 26.x，见文件头说明）----
XCODE26_DIR="${XCODE26_DIR:-$HOME/Applications/Xcode.app}"
if [ ! -d "$XCODE26_DIR/Contents/Developer" ]; then
  echo "❌ 未找到 Xcode 26：$XCODE26_DIR"
  echo "   请安装 Xcode 26.x 到 ~/Applications/，或用 XCODE26_DIR=<路径> 指定。"
  echo "   （原因：iOS 27 强制 UIScene，Xcode 27 打的包在 iOS 27 上启动即崩）"
  exit 1
fi
export DEVELOPER_DIR="$XCODE26_DIR/Contents/Developer"
# PATH 前置：PATH 里若已有 Xcode 27 的 usr/bin（常见于 shell 配置），会绕过 DEVELOPER_DIR
export PATH="$DEVELOPER_DIR/usr/bin:$PATH"
_XC_VER="$(xcodebuild -version 2>/dev/null | head -2 | tr '\n' ' ')"
echo "== [0/3] 构建工具链：$_XC_VER"
case "$_XC_VER" in
  *"Xcode 26"*) : ;;
  *) echo "❌ 当前 xcodebuild 不是 Xcode 26：$_XC_VER"
     echo "   期望 26.x（iphoneos26.* SDK）。请检查 XCODE26_DIR 与 PATH 顺序。"
     exit 1 ;;
esac

echo "== [1/3] 同步前端资源 =="
if [ -d "$RES_SRC" ]; then
  mkdir -p "$WWW"
  rsync -a --delete "$RES_SRC/" "$WWW/"
  echo "   ← ${RES_SRC}（$(find "$WWW" -type f | wc -l | tr -d ' ') 个文件）"
else
  echo "   [警告] 未找到 ${RES_SRC}，沿用工程内现有资源"
  echo "   请先在 mall-app-ui 执行: env -u NODE_OPTIONS UNI_INPUT_DIR=\$PWD/src VITE_ROOT_DIR=\$PWD npx uni build -p app --mode development"
fi

echo "== [1.2/3] 生成品牌资产（App 图标 + 启动图）=="
# 为什么放在这里：图标与启动图是**编译进 bundle** 的资源，源在壳工程内，而壳工程
# （`dcloud-ios/`）被 .gitignore 排除 —— 换机重建后它们会退回脚手架自带的那套
# （mall 的「梦想购」购物车），且**没有任何报错**，只是 App 图标看起来不对。
# 三处资产（AppIcon / dclogo / Android icon.png）分散在两套壳里，最容易只换一处，
# 所以统一由一个脚本产出，在打包时自动补齐。
#
# 失败不中断打包：图标没生成只是观感问题，而打包本身才是这一步的目的。
ICON_SCRIPT="$APP_ROOT/design/make-app-icon.py"
if [ -f "$ICON_SCRIPT" ]; then
  if command -v python3 >/dev/null 2>&1; then
    if python3 "$ICON_SCRIPT" >/dev/null 2>&1; then
      echo "   ← design/make-app-icon.py（AppIcon + dclogo 已同步）"
    else
      echo "   [警告] 图标脚本执行失败，本次沿用药工程内现有资产"
      echo "   手动排查: python3 $ICON_SCRIPT"
    fi
  else
    echo "   [警告] 未找到 python3，跳过图标生成"
  fi
else
  echo "   [警告] 未找到 ${ICON_SCRIPT}，跳过图标生成"
fi

# 仅在 APK/开发包需要的资产（自适应图标等）也由同一脚本产出，这里只做存在性提示。
if [ ! -f "$APP_SRC/Assets.xcassets/AppIcon.appiconset/icon1024.png" ]; then
  echo "   [警告] 缺少 AppIcon 源图，iOS 将使用脚手架默认图标"
fi

echo "== [1.5/3] 确保 scheme 白名单（LSApplicationQueriesSchemes）=="
# 为什么要在这里兜底：iOS 唤起第三方 App 用的 scheme 必须在本工程 Info.plist 的
# LSApplicationQueriesSchemes 里声明，未声明的 canOpenURL 恒返回 false —— 典型事故：
# 已安装支付宝却报「未检测到支付宝」（客户端检测/拉起都用 alipays://，而模板只带 alipay）。
# 又因为 dcloud-ios/ 整体在 .gitignore 里（SDK 体积大、不入库），换机器/重新下载 SDK 后
# 手改的白名单会丢，所以每次出包前在此幂等补全。
PLIST="$APP_SRC/HBuilder-Hello-Info.plist"
python3 - "$PLIST" <<'PY'
import plistlib
import sys

path = sys.argv[1]
need = ['alipays', 'alipayqr']  # 支付宝深链 scheme（拉起）/ 扫码备用
with open(path, 'rb') as f:
    data = plistlib.load(f)
schemes = data.setdefault('LSApplicationQueriesSchemes', [])
added = [s for s in need if s not in schemes]
if added:
    schemes.extend(added)
    with open(path, 'wb') as f:
        plistlib.dump(data, f)  # 默认 XML 格式，保持可读/可 diff
    print("   ← 已补白名单: %s" % added)
else:
    print("   ← 白名单已含: %s" % need)
PY

echo "== [1.6/3] 上架审核补丁（Info.plist 权限用途描述裁剪 + 中文化）=="
# 壳工程（dcloud-ios/）不入库 ⇒ 模板里的权限描述会在换机/重下 SDK 后回退：
#   ① NSLocationWhenInUseUsageDescription 曾为空串（真实文案在畸形键 "... - 2" 里）⇒ 权限弹窗无文案
#   ② 模板照搬了 ATT/蓝牙/后台定位等壳未启用模块的用途声明 ⇒ 招审核追问
# 补丁脚本与说明在仓库内：tests/deploy/ios-shell-patch/（幂等，可反复跑）
PATCH_SCRIPT="$APP_ROOT/../tests/deploy/ios-shell-patch/patch-ios-review.py"
if [ -f "$PATCH_SCRIPT" ]; then
  python3 "$PATCH_SCRIPT" --plist "$PLIST"
else
  echo "   [警告] 未找到 ${PATCH_SCRIPT}，跳过（App Store 出包前必须补跑，见 tests/deploy/ios-shell-patch/README.md）"
fi

echo "== [2/3] archive（team=${TEAM}）=="
echo "   -- 签名前置检查 --"
echo -n "   已登录团队: "; defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null | grep -E "teamID" | tr -d ' ;' | tr '\n' ' '; echo
echo -n "   钥匙串身份: "; security find-identity -v -p codesigning 2>/dev/null | grep -c "Apple" | tr -d ' '; echo " 个"
cd "$PROJ"
xcodebuild -workspace HBuilder-Hello.xcworkspace -scheme HBuilder -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$BUILD/dd" \
  -archivePath "$ARCHIVE" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" archive

echo "== [3/3] 导出 IPA（method=${METHOD}）=="
mkdir -p "$BUILD"
cat > "$OPT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>$METHOD</string>
	<key>teamID</key>
	<string>$TEAM</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>compileBitcode</key>
	<false/>
	<key>stripSwiftSymbols</key>
	<true/>
	<key>uploadSymbols</key>
	<false/>
	<key>destination</key>
	<string>export</string>
</dict>
</plist>
PLIST

mkdir -p "$EXPORT_DIR"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$OPT_PLIST" -allowProvisioningUpdates

# ---- [3.5/3] 产物校验：DTSDKName 必须为 iphoneos26.*（iOS 27 UIScene 兼容红线）----
echo "== [3.5/3] 校验产物 SDK 版本 =="
IPA="$EXPORT_DIR/HBuilder.ipa"
_TMP_PLIST="$(mktemp -t ipa-plist)"
if unzip -p "$IPA" "Payload/HBuilder.app/Info.plist" > "$_TMP_PLIST" 2>/dev/null; then
  _SDK="$(/usr/libexec/PlistBuddy -c 'Print :DTSDKName' "$_TMP_PLIST" 2>/dev/null || echo '?')"
  _VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$_TMP_PLIST" 2>/dev/null)/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$_TMP_PLIST" 2>/dev/null)"
  echo "   DTSDKName     = $_SDK"
  echo "   版本          = $_VER"
  case "$_SDK" in
    iphoneos26.*|iphoneos25.*|iphoneos24.*) echo "   ✅ SDK 合规（非最新 SDK，iOS 27 不会强制 UIScene）" ;;
    iphoneos27.*|iphoneos28.*)
      echo "   ❌ 致命：产物用最新 SDK 构建 ⇒ 在 iOS 27 设备上会「启动即闪退」"
      echo "      这正是 App Store Guideline 2.1(a) 被拒的原因，禁止提交。"
      rm -f "$_TMP_PLIST"; exit 1 ;;
    *) echo "   ⚠️  未知 SDK 标识（${_SDK}），请人工确认" ;;
  esac
else
  echo "   ⚠️  无法读取产物 Info.plist，跳过校验"
fi
rm -f "$_TMP_PLIST"

echo "== 完成 =="
ls -la "$EXPORT_DIR"
