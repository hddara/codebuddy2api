#!/usr/bin/env bash
#
# 一键出 Android 安装包（离线壳工程）。
#
#   ./build-apk.sh              # 构建 + 投放资源 + 打包
#   ./build-apk.sh --install    # 上面全部，完了直接装机并启动
#   ./build-apk.sh --no-web     # 跳过前端构建，复用 dist/build/app（只改了原生时用）
#   ./build-apk.sh --install --configure
#                               # 装机后再自动填好网关地址与控制台 Cookie
#                               # 凭据取自 $HDARA_BASE_URL / $HDARA_COOKIE，
#                               # 或 ~/.hdara-base-url / ~/.hdara-cookie
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
DO_CONFIGURE=0
for arg in "$@"; do
  case "$arg" in
    --install)   DO_INSTALL=1 ;;
    --no-web)    DO_WEB=0 ;;
    --configure) DO_CONFIGURE=1; DO_INSTALL=1 ;;   # 配置必须在装机之后
    -h|--help)   sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（可用: --install / --no-web / --configure）" >&2; exit 2 ;;
  esac
done

# ---- 工具定位 ----------------------------------------------------------
# Java 交给 gradle 自己找会很飘（本机装了 10 个 JDK，其中还有 1.8），显式钉一个 21。
#
# 这里**不能只在 JAVA_HOME 为空时才探测**：本机 JAVA_HOME 常被别的工具留成 1.8，
# 而 Android Gradle Plugin 8.7 要求 Java 11+，会以
# 「Dependency requires at least JVM runtime version 11」失败 —— 报错点离原因很远。
# 所以无论 JAVA_HOME 来自哪里，都先验版本，不合格就换。
MIN_JAVA_MAJOR=11

java_major() {
  # 输出 JDK 主版本号；无法识别时输出 0。
  #
  # 注意旧式版本串 `1.8.0_504` 的主版本是 **8** 而不是 1 —— 直接取第一个点前数字
  # 会把 JDK 8 误判成 1，于是「1 >= 11」为假、逻辑恰好还能工作，但提示信息会写成
  # 「版本过低（1）」，把人引向错误的方向。
  [ -x "$1/bin/java" ] || { echo 0; return; }
  local raw
  raw="$("$1/bin/java" -version 2>&1 | head -1 | sed -n 's/.*version "\([0-9._]*\)".*/\1/p')"
  if [ -z "$raw" ]; then echo 0; return; fi
  case "$raw" in
    1.*) echo "$raw" | cut -d. -f2 ;;
    *)   echo "$raw" | cut -d. -f1 ;;
  esac
}

drop_java_home() {
  unset JAVA_HOME
}

if [ -n "${JAVA_HOME:-}" ]; then
  if [ "$(java_major "$JAVA_HOME")" -ge "$MIN_JAVA_MAJOR" ]; then
    echo "   沿用环境中的 JAVA_HOME=$(basename "$(dirname "$(dirname "$JAVA_HOME")")")"
  else
    echo "   环境中的 JAVA_HOME 版本过低（$(java_major "$JAVA_HOME")），改用自动探测"
    drop_java_home
  fi
fi

if [ -z "${JAVA_HOME:-}" ]; then
  # 按偏好顺序找：先 21，再 17，再任意 11+。
  #
  # 两种写法必须区分开，这里踩过两次：
  #
  #  - `for pattern in ms-21.*` —— 列表**不加引号**，但开了 nullglob 时，未匹配的
  #    条目会被整条删掉，列表可能变空 ⇒ **循环一次都不执行**，探测静默失败。
  #    所以列表项一律加引号，让 pattern 以字面量进入循环。
  #  - `".../$pattern/Contents/Home"` —— 拼接后**必须是引号外的通配符**才会展开；
  #    写成 `"$dir/$pattern/..."`（全引号）则 `$pattern` 不参与 glob，永远匹配不到。
  #
  # 用数组收集而不是 `ls | sort`，以免路径含空格被拆开。
  shopt -s nullglob
  for pattern in "ms-21.*" "openjdk-21*" "temurin-21.*" "graalvm-jdk-21*" \
                 "ms-17.*" "openjdk-17*" "temurin-17.*" \
                 "ms-*" "openjdk-*" "temurin-*"; do
    candidates=("$HOME/Library/Java/JavaVirtualMachines/"$pattern"/Contents/Home")
    for candidate in "${candidates[@]}"; do
      if [ "$(java_major "$candidate")" -ge "$MIN_JAVA_MAJOR" ]; then
        JAVA_HOME="$candidate"
        break 2
      fi
    done
  done
  shopt -u nullglob
fi

if [ -z "${JAVA_HOME:-}" ] || [ "$(java_major "$JAVA_HOME")" -lt "$MIN_JAVA_MAJOR" ]; then
  echo "找不到 JDK ${MIN_JAVA_MAJOR}+（Android Gradle Plugin 8.7 的最低要求）。" >&2
  echo "请设置 JAVA_HOME 后重试，例如：" >&2
  echo "  export JAVA_HOME=\$HOME/Library/Java/JavaVirtualMachines/ms-21.0.11/Contents/Home" >&2
  exit 1
fi

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"

echo "== [0/5] 环境 =="
echo "   JAVA_HOME = $JAVA_HOME"
echo "   ($("$JAVA_HOME/bin/java" -version 2>&1 | head -1))"

# ---- [1/5] 前端产物 ----------------------------------------------------
echo "== [1/5] 前端资源（uni build -p app）=="
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

# ---- [2/5] 资源与品牌资产 ----------------------------------------------
echo "== [2/5] 投放资源 + 品牌资产 =="

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

# ---- [3/5] 打包 --------------------------------------------------------
echo "== [3/5] gradle assembleRelease =="
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

# ---- [4/5] 装机（可选）-------------------------------------------------
if [ "$DO_INSTALL" -eq 1 ]; then
  echo "== [4/5] 安装到设备 =="
  if [ ! -x "$ADB" ]; then
    echo "   未找到 adb（$ADB），跳过安装" >&2
    exit 0
  fi
  if [ -z "$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}')" ]; then
    echo "   没有已连接（且已授权）的设备，跳过安装" >&2
    exit 0
  fi
  "$ADB" install -r "$APK"
  # `install -r` **保留**应用数据（实测确认）；清空存储的是 `adb uninstall` 或
  # `adb shell pm clear`。这一点曾被文档写错，导致每次重装都误以为要重填配置。
  echo "   提示：install -r 保留应用数据；若要清空请显式执行 adb shell pm clear cn.hddara.ai"
  "$ADB" shell am force-stop cn.hddara.ai || true
  "$ADB" shell am start -n cn.hddara.ai/io.dcloud.PandoraEntry >/dev/null 2>&1 || true
  echo "   已启动 App"
else
  echo "== [4/5] 跳过安装（加 --install 可直接装机）=="
fi

# ---- [5/5] 自动配置（可选）---------------------------------------------
if [ "$DO_CONFIGURE" -eq 1 ]; then
  echo "== [5/5] 写入网关配置 =="
  # 凭据不写进仓库，也不进日志：优先环境变量，其次 ~/.hdara-* 文件。
  cfg_base="${HDARA_BASE_URL:-}"
  cfg_cookie="${HDARA_COOKIE:-}"
  if [ -z "$cfg_base" ] && [ -r "$HOME/.hdara-base-url" ]; then
    cfg_base="$(head -1 "$HOME/.hdara-base-url" | tr -d '\r\n')"
  fi
  if [ -z "$cfg_cookie" ] && [ -r "$HOME/.hdara-cookie" ]; then
    cfg_cookie="$(head -1 "$HOME/.hdara-cookie" | tr -d '\r\n')"
  fi

  if [ -z "$cfg_base" ] || [ -z "$cfg_cookie" ]; then
    # 打包已经成功了，配置只是附加便利 —— 这里用告警而不是失败，
    # 否则 CI/发布脚本会把「包是好的，只是没自动填表」当成构建失败。
    echo "   [警告] 缺少凭据，跳过配置。请提供其中一种：" >&2
    echo "     export HDARA_BASE_URL=... HDARA_COOKIE=..." >&2
    echo "     或写入 ~/.hdara-base-url 与 ~/.hdara-cookie" >&2
  elif [ ! -f "$APP_ROOT/scripts/configure-device.sh" ]; then
    echo "   [警告] 未找到 configure-device.sh，跳过配置" >&2
  else
    # `|| true`：脚本自身已做回读校验并会在失败时返回非零，但打包已经完成，
    # 配置不成功不该把整次构建判为失败。
    bash "$APP_ROOT/scripts/configure-device.sh" --base-url "$cfg_base" --cookie "$cfg_cookie" || \
      echo "   [警告] 自动配置未通过，请在手机上检查设置页" >&2
  fi
else
  echo "== [5/5] 跳过配置（加 --configure 可自动填入网关地址与 Cookie）=="
fi

echo "完成。"
