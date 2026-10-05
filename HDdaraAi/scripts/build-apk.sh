#!/usr/bin/env bash
#
# 一键出 Android 安装包（离线壳工程）。
#
#   ./build-apk.sh              # 构建 + 投放资源 + 打包
#   ./build-apk.sh --install    # 上面全部，完了直接装机并启动
#   ./build-apk.sh --no-web     # 跳过前端构建，复用 dist/build/app（只改了原生时用）
#
# 为什么要有这个脚本：这条链路本来有 4 步（uni build → 投放 → gradlew → adb install），
# 全靠手敲。手敲会踩两个反复出现的坑：
#   1. 投放资源时若不先删旧目录，`cp -R` 会变成 `www/app` 嵌套，App 起来是白屏；
#   2. 换机/重建壳后图标会退回脚手架那套（mall 的「梦想购」购物车），且**不报错**。
# 两步都固化在这里，不再依赖记忆。
set -euo pipefail

# 脚本位于 HDdaraAi/scripts/，而壳工程在 HDdaraAi/dcloud-android/ —— 之所以不把脚本放进
# 壳工程，是因为 `dcloud-android/` 整体被 .gitignore 排除，脚本跟着一起不入库，换机后就没了。
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # HDdaraAi/
ROOT="$APP_ROOT/dcloud-android"
APPID="__UNI__DC81923"
SHELL_DIR="$ROOT/shell"
PROJ_DIR="$SHELL_DIR/simpleDemo"
RES_SRC="$APP_ROOT/dist/build/app"                 # uni build -p app 的产物
WWW_DEST="$PROJ_DIR/src/main/assets/apps/$APPID/www"
APK="$PROJ_DIR/build/outputs/apk/release/simpleDemo-release.apk"
ICON_SCRIPT="$APP_ROOT/design/make-app-icon.py"

DO_INSTALL=0
DO_WEB=1
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --no-web)  DO_WEB=0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（可用: --install / --no-web）" >&2; exit 2 ;;
  esac
done

# ---- 工具定位 ----------------------------------------------------------
# Java 交给 gradle 自己找会很飘（本机装了 10 个 JDK），显式钉一个 21。
if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in "$HOME/Library/Java/JavaVirtualMachines"/ms-21.*/Contents/Home \
                   "$HOME/Library/Java/JavaVirtualMachines"/openjdk-21*/Contents/Home; do
    if [ -x "$candidate/bin/java" ]; then JAVA_HOME="$candidate"; break; fi
  done
fi

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "找不到可用的 JDK 21。请设置 JAVA_HOME 后重试，例如：" >&2
  echo "  export JAVA_HOME=\$HOME/Library/Java/JavaVirtualMachines/ms-21.0.11/Contents/Home" >&2
  exit 1
fi

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"

echo "== [0/4] 环境 =="
echo "   JAVA_HOME = $JAVA_HOME"
echo "   ($("$JAVA_HOME/bin/java" -version 2>&1 | head -1))"

# ---- [1/4] 前端产物 ----------------------------------------------------
echo "== [1/4] 前端资源（uni build -p app）=="
if [ "$DO_WEB" -eq 1 ]; then
  if ! command -v npx >/dev/null 2>&1; then
    echo "   未找到 npx，无法构建前端。可用 --no-web 复用现有 dist/build/app。" >&2
    exit 1
  fi
  # NODE_OPTIONS 里若有注入会干扰 uni 的构建，这里清掉（与仓库其它脚本一致）。
  ( cd "$APP_ROOT" && env -u NODE_OPTIONS npx uni build -p app )
else
  echo "   [--no-web] 跳过，复用 ${RES_SRC}"
fi

if [ ! -f "$RES_SRC/app-service.js" ]; then
  echo "   未找到前端产物 ${RES_SRC}/app-service.js，请先跑一次不带 --no-web 的构建。" >&2
  exit 1
fi

# ---- [2/4] 资源与品牌资产 ----------------------------------------------
echo "== [2/4] 投放资源 + 品牌资产 =="

# 先删再拷：目录名必须等于 appid，`cp -R` 到已存在的目录会嵌套成 www/app。
rm -rf "$WWW_DEST"
mkdir -p "$(dirname "$WWW_DEST")"
cp -R "$RES_SRC" "$WWW_DEST"
echo "   ← ${RES_SRC}（$(find "$WWW_DEST" -type f | wc -l | tr -d ' ') 个文件）"

# 图标与前端产物同源（都在壳工程里、都被 .gitignore 排除），所以每次打包重生成，
# 避免重建壳之后静默退回脚手架的购物车图标。失败不中断：打包才是主目标。
if [ -f "$ICON_SCRIPT" ] && command -v python3 >/dev/null 2>&1; then
  if python3 "$ICON_SCRIPT" >/dev/null 2>&1; then
    echo "   ← design/make-app-icon.py（各 dpi icon / 自适应前景 / 主题图标 / 启动图）"
  else
    echo "   [警告] 图标脚本失败，沿用药工程内现有资产"
    echo "   手动排查: python3 $ICON_SCRIPT"
  fi
else
  echo "   [警告] 缺少 python3 或 $ICON_SCRIPT，跳过图标生成"
fi

# ---- [3/4] 打包 --------------------------------------------------------
echo "== [3/4] gradle assembleRelease =="
( cd "$SHELL_DIR" && JAVA_HOME="$JAVA_HOME" ./gradlew :simpleDemo:assembleRelease --no-daemon )

if [ ! -f "$APK" ]; then
  echo "   打包结束但未找到 ${APK}" >&2
  exit 1
fi
echo "   ← ${APK}（$(du -h "$APK" | cut -f1)）"

# 快速确认进包的是新图而不是旧的购物车：给出版本与图标条目。
BT="${BUILD_TOOLS:-$(ls -d "$HOME/Library/Android/sdk/build-tools"/* 2>/dev/null | sort -V | tail -1)}"
if [ -n "${BT:-}" ] && [ -x "$BT/aapt" ]; then
  echo "   包名/版本: $("$BT/aapt" dump badging "$APK" 2>/dev/null | head -1 | sed 's/^package: //')"
  echo "   图标条目数: $("$BT/aapt" dump badging "$APK" 2>/dev/null | grep -c '^application-icon')"
fi

# ---- [4/4] 装机（可选）-------------------------------------------------
if [ "$DO_INSTALL" -eq 1 ]; then
  echo "== [4/4] 安装到设备 =="
  if [ ! -x "$ADB" ]; then
    echo "   未找到 adb（$ADB），跳过安装" >&2
    exit 0
  fi
  if [ -z "$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}')" ]; then
    echo "   没有已连接（且已授权）的设备，跳过安装" >&2
    exit 0
  fi
  "$ADB" install -r "$APK"
  # 重装会清空 WebView 存储，网关地址与 Cookie 需在设置页重填；这是预期行为。
  echo "   提示：adb install -r 会清空 App 存储，网关地址与控制台 Cookie 需重填。"
  "$ADB" shell am force-stop cn.hddara.ai || true
  "$ADB" shell am start -n cn.hddara.ai/io.dcloud.PandoraEntry >/dev/null 2>&1 || true
  echo "   已启动 App（验证持久化的正确做法是只 am force-stop 重启，不要重装）"
else
  echo "== [4/4] 跳过安装（加 --install 可直接装机）=="
fi

echo "完成。"
