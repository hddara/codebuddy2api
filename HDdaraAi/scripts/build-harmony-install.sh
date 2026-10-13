#!/usr/bin/env bash
#
# 鸿蒙命令行出包 + 装机（签名配置就位后全自动）。
#
#   ./build-harmony-install.sh              # 构建 → 装机 → 启动
#   ./build-harmony-install.sh --build-only # 只构建
#   ./build-harmony-install.sh --target 192.168.100.187:40831
#                                           # 指定无线调试目标（默认自动取第一个设备）
#
# 为什么需要这个脚本（2026-10-13 实测）：
#   `scripts/build-harmony.sh` 用 HBuilderX CLI 编出 **unsigned** hap 后就停了，
#   它认为「签名只能在 DevEco GUI 里做」。这句话对**首次**成立（profile 必须由
#   华为签发），但**每次都要重新签名**并不需要再开 GUI —— DevEco 的自动签名结果
#   会落到工程内，之后用命令行 hvigor 就能直接产出**已签名**的 hap。
#
#   本机实测的完整边界（穷举过，别再重试）：
#     · 编译器：HBuilderX CLI `launch app-harmony` → 可用。
#     · 构建器：DevEco 自带 `hvigorw assembleHap` → 可用，命令行能跑完整链路。
#     · 签名器：`hap-sign-tool.jar` 的 sign-profile/sign-app → 可用，但**没有**
#       bundle 匹配的 profile，等于无用：
#         - 复用 `~/.ohos/config/` 里那份（bundle 是 `com.mall.cloud`）不行，
#           因为 sign-profile 会用配套私钥去校验证书公钥，而那个 p12 的口令被
#           DevEco 加密保管（`material/` 下是 48 字节 AES 密文块），拿不到明文；
#         - 自签一条新根也没用，鸿蒙设备只信任华为根证书链。
#       ⇒ 所以 profile 只能由 DevEco 的「自动签名」（走华为服务器）产一次。
#
#   签好一次之后，`build-profile.json5` 的 `signingConfigs` 就被填上了，
#   本脚本即可无人值守地重复出包。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARMONY_DIR="$APP_ROOT/dist/dev/app-harmony"
BUNDLE_NAME="cn.hddara.ai"

DEVECO="/Applications/DevEco-Studio.app"
HVIGORW="$DEVECO/Contents/tools/hvigor/bin/hvigorw"
HDC="$DEVECO/Contents/sdk/default/openharmony/toolchains/hdc"
DEVECO_NODE="$DEVECO/Contents/tools/node"

DO_BUILD=1
DO_INSTALL=1
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --build-only) DO_INSTALL=0 ;;
    --target)     shift; TARGET="${1:-}" ;;
    -h|--help)    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[harmony]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[harmony:失败]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$HARMONY_DIR" ]] || fail "未找到鸿蒙工程：$HARMONY_DIR（先跑 scripts/build-harmony.sh）"
[[ -x "$HVIGORW" ]]     || fail "未找到 hvigorw：$HVIGORW"

# ---- 签名配置前置检查：没有就明确说清要做什么，别等构建完才发现 ----------
if ! grep -q '"signingConfigs"[[:space:]]*:[[:space:]]*\[[[:space:]]*{' \
      "$HARMONY_DIR/build-profile.json5" 2>/dev/null; then
  cat >&2 <<'EOS'
[harmony:失败] 工程还没有签名配置（build-profile.json5 的 signingConfigs 为空）。

鸿蒙的 profile 只能由华为签发，命令行没有入口，需要在 DevEco Studio 里做一次：

  1. DevEco Studio → Open → 选择
       HDdaraAi/dist/dev/app-harmony
  2. File → Project Structure → Signing Configs
  3. 勾选 "Automatically generate signature"（需已登录华为账号）
  4. Apply → OK

做完这一步后，signingConfigs 会被写入工程，之后本脚本可全自动重复出包。
EOS
  exit 1
fi

if [[ "$DO_BUILD" = "1" ]]; then
  log "① 构建 HAP（hvigor assembleHap）..."
  export DEVECO_SDK_HOME="$DEVECO/Contents/sdk"
  export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/microsoft-17.jdk/Contents/Home}"
  export PATH="$DEVECO_NODE/bin:$PATH"
  cd "$HARMONY_DIR"
  LOG="/tmp/hdara-hvigor-$(date +%Y%m%d-%H%M%S).log"
  "$HVIGORW" assembleHap --mode module -p product=default -p buildMode=debug \
    --no-daemon > "$LOG" 2>&1 || { tail -30 "$LOG" >&2; fail "构建失败，完整日志：$LOG"; }
  grep -q "BUILD SUCCESSFUL" "$LOG" || { tail -30 "$LOG" >&2; fail "构建未成功，见 $LOG"; }
  log "   ✓ 构建完成（日志 $LOG）"
fi

# ---- 定位已签名的 hap ----------------------------------------------------
SIGNED="$(find "$HARMONY_DIR/entry/build" -name "*-signed.hap" -type f 2>/dev/null | head -1)"
[[ -n "$SIGNED" && -f "$SIGNED" ]] || fail "未找到 *-signed.hap（签名配置可能没生效）"
log "② 已签名 hap：$(basename "$SIGNED")  ($(du -h "$SIGNED" | cut -f1))"

if [[ "$DO_INSTALL" = "0" ]]; then
  exit 0
fi

# ---- 装机 ----------------------------------------------------------------
[[ -x "$HDC" ]] || fail "未找到 hdc：$HDC"
if [[ -n "$TARGET" ]]; then
  log "③ 连接无线调试目标 $TARGET ..."
  "$HDC" tconn "$TARGET" 2>&1 | sed 's/^/   /' || true
fi

DEV="$("$HDC" list targets 2>/dev/null | grep -v '^\[Empty\]$' | head -1)"
if [[ -z "$DEV" ]]; then
  # 无线调试常见：tconn 过一次后 target 才出现，给一次重试机会。
  if [[ -n "$TARGET" ]]; then
    sleep 2
    DEV="$("$HDC" list targets 2>/dev/null | grep -v '^\[Empty\]$' | head -1)"
  fi
fi
[[ -n "$DEV" ]] || fail "没有已连接的鸿蒙设备（USB 需开调试；无线用 --target <ip:port>）"
log "   设备：$DEV"

log "④ 安装..."
"$HDC" install -r "$SIGNED" 2>&1 | sed 's/^/   /'

log "⑤ 启动..."
"$HDC" shell aa start -a EntryAbility -b "$BUNDLE_NAME" 2>&1 | sed 's/^/   /' || true

echo
log "=========== 完成 ==========="
