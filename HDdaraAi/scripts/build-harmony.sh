#!/usr/bin/env bash
#
# 一键编译鸿蒙（HarmonyOS）工程并产出 unsigned HAP。
#
#   ./build-harmony.sh              # 编译 → 产出 unsigned hap
#   ./build-harmony.sh --install    # 上面全部，签好名后装机并启动
#   ./build-harmony.sh --skip-compile
#                                   # 跳过源码编译，直接复用已有 dist/dev/app-harmony
#
# 为什么要有这个脚本：这条链路原先只有一段文档里的命令行，靠手抄。手抄会踩三个坑：
#   1. 报 `isInSSRComponentSetup is not exported by vue.runtime.esm-bundler.js` 时，
#      很容易以为要升 Vue 或打 patch —— 都不是。真实原因只是**少装了两个鸿蒙平台包**，
#      见下面「为什么这个报错会误导人」。脚本把前置检查做进来，直接告诉你是缺包。
#   2. `--project` 要的是 **HBuilderX 里的项目名**，不是目录名。写成绝对路径会找不到项目。
#   3. unsigned hap 的位置随 hvigor 版本变过（旧版在 build/release/），写死路径会拿不到包。
#
# 为什么这个报错会误导人（2026-10-11 实测，推翻了 10-05 的结论）：
#   缺 `@dcloudio/uni-app-harmony` 与 `@dcloudio/uni-mp-harmony` 时，uni-app 无法走鸿蒙
#   专属编译链路，回退到通用 ESM 路径，于是撞上 `vue.runtime.esm-bundler.js` 的**严格导出
#   检查** —— 而 `@dcloudio/uni-app` 的 dist 引用了 Vue 的内部符号（`isInSSRComponentSetup`
#   / `injectHook`），这些符号本来就不在公开导出里。所以报错是**表象**，不是根因：
#     · 补上两个平台包 → 编译直接通过，不需要改 Vue 版本、不需要 patch 任何源码；
#     · mall 项目一直能出鸿蒙包，用的就是这套依赖。
#   版本号必须与 package.json 里其它 `@dcloudio/*` 完全一致，否则 peer 依赖会错配。
#
# 签名（这是鸿蒙唯一的真阻塞，脚本特意不做）：
#   鸿蒙的 profile **只能由华为签发**，不像 Android 可以完全自签。通道只有两个：
#     · DevEco Studio 的「自动签名」（File → Project Structure → Signing Configs）
#     · 华为 AGC 网站
#   两者都在 GUI 里，**没有命令行入口**（`hvigor` 只有构建任务、DevEco 二进制只是 IDE
#   启动器，均已实测穷举）。所以本脚本只负责到 unsigned hap，签名由人完成一次后，
#   再用 `--install` 走装机。
#
#   调试签名**不需要**先去 AGC 建应用（那是上架专用流程）。本机设备的 UDID 已在华为
#   调试白名单里（与 mall 那份 profile 的 device-ids 逐字节一致）。
#
#   `~/.ohos/config/` 下那份现成的自动签名材料**不能直接用** —— 它的 bundle-name 是
#   `com.mall.cloud`，而本工程是 `cn.hddara.ai`。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

HX_CLI="/Applications/HBuilderX.app/Contents/MacOS/cli"
DEVECO="/Applications/DevEco-Studio.app"
HDC="$DEVECO/Contents/sdk/default/openharmony/toolchains/hdc"

PROJECT_NAME="HDdaraAi"      # HBuilderX 的项目名（见 ~/Library/.../HBuilder X/projects/），不是目录名
HARMONY_DIR="$APP_ROOT/dist/dev/app-harmony"
BUNDLE_NAME="cn.hddara.ai"

DO_INSTALL=0
DO_COMPILE=1
for arg in "$@"; do
  case "$arg" in
    --install)      DO_INSTALL=1 ;;
    --skip-compile) DO_COMPILE=0 ;;
    -h|--help)      sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: ${arg}（可用: --install / --skip-compile）" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[harmony]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[harmony:注意]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[harmony:失败]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -x "$HX_CLI" ]] || fail "未找到 HBuilderX CLI：$HX_CLI"
[[ -d "$DEVECO" ]] || fail "未找到 DevEco Studio：$DEVECO"

# ---- 前置检查：两个平台包是否都在 --------------------------------------
# 这两个包缺失就是那个误导性报错的成因，所以在这里挡掉，而不是等编译到一半才报。
# 用 python 读 package.json 而不是 grep：把版本号一并取出来，方便对照提示该装哪个版本。
log "① 检查鸿蒙平台包..."
missing="$(python3 - "$APP_ROOT/package.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding='utf-8'))
deps = {**(p.get('dependencies') or {}), **(p.get('devDependencies') or {})}
need = ['@dcloudio/uni-app-harmony', '@dcloudio/uni-mp-harmony']
ref = next((v for k, v in deps.items() if k.startswith('@dcloudio/uni-app@')), None)
for name in need:
    if name not in deps:
        print(f'{name}\t{ref or "3.0.0-<与其它 @dcloudio/* 同版本>"}')
PY
)"
if [[ -n "$missing" ]]; then
  warn "缺少鸿蒙平台包（这正是 isInSSRComponentSetup 报错的真实原因）："
  while IFS=$'\t' read -r name ver; do
    [[ -n "$name" ]] && printf '         pnpm add -D %s@%s\n' "$name" "$ver"
  done <<< "$missing"
  fail "请装好上面的包再重跑（版本必须与其它 @dcloudio/* 一致）"
fi
log "   ✓ 平台包齐备"

# ---- 编译 ---------------------------------------------------------------
if [[ "$DO_COMPILE" = "1" ]]; then
  log "② 编译鸿蒙工程（release）..."
  # HBuilderX 自己会往 dist/dev/app-harmony 装鸿蒙工程依赖，所以不需要先跑 uni build。
  LOG="/tmp/hdara-harmony-$(date +%Y%m%d-%H%M%S).log"
  "$HX_CLI" launch app-harmony --project "$PROJECT_NAME" \
    --buildType release --compile true > "$LOG" 2>&1 || true   # 非零退出不足以断定失败，看日志
  log "   日志：$LOG"

  if grep -q "is not exported by" "$LOG"; then
    fail "仍报错 isInSSRComponentSetup / injectHook —— 说明平台包没生效，见 $LOG"
  fi
  grep -q "运行包制作成功" "$LOG" || fail "编译未产出运行包，见日志：$LOG"
  log "   ✓ 编译完成"
else
  log "② 已跳过编译（--skip-compile）"
fi

# ---- 定位产物 -----------------------------------------------------------
# 路径随 hvigor 版本变过（旧版在 entry/build/release/），所以用 find 而不是写死。
HAP="$(find "$HARMONY_DIR" -name "*-unsigned.hap" -type f 2>/dev/null | head -1)"
[[ -n "$HAP" && -f "$HAP" ]] || fail "未找到 unsigned hap（先跑一次完整编译）"

# bundleName 是签名能不能装的前提，顺手核对一次：工程与三端统一标识必须一致。
APP_JSON="$HARMONY_DIR/AppScope/app.json5"
if [[ -f "$APP_JSON" ]]; then
  actual="$(sed -n 's/.*"bundleName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_JSON" | head -1)"
  [[ "$actual" == "$BUNDLE_NAME" ]] \
    || fail "bundleName 不符：工程是 $actual，期望 $BUNDLE_NAME"
fi

log "③ unsigned hap："
ls -lh "$HAP" | awk '{printf "         %s  (%s)\n", $9, $5}'

# ---- 装机（可选）--------------------------------------------------------
if [[ "$DO_INSTALL" = "0" ]]; then
  echo
  log "编译完成。下一步需要签名，而签名只能在 GUI 里做一次："
  log "  DevEco Studio 打开 $HARMONY_DIR"
  log "  → File → Project Structure → Signing Configs"
  log "  → 勾选 Automatically generate signature → Apply"
  log "签好后重跑：$0 --skip-compile --install"
  exit 0
fi

log "④ 检查设备..."
[[ -x "$HDC" ]] || fail "未找到 hdc：$HDC"
targets="$("$HDC" list targets 2>/dev/null | grep -v '^\[Empty\]$' | head -1)"
[[ -n "$targets" ]] || fail "没有已连接的鸿蒙设备（需在手机上开启 USB 调试）"

signed="$(find "$HARMONY_DIR" -name "*-signed.hap" -type f 2>/dev/null | head -1)"
[[ -n "$signed" && -f "$signed" ]] || fail "未找到已签名的 hap。请先在 DevEco 里完成自动签名，\
或参照 docs/App离线打包说明.md 用 hap-sign-tool 签名"

log "   设备：$targets"
log "⑤ 安装 $signed ..."
"$HDC" install -r "$signed" 2>&1 | sed 's/^/   /'

log "⑥ 启动..."
"$HDC" shell aa start -a EntryAbility -b "$BUNDLE_NAME" 2>&1 | sed 's/^/   /' || \
  warn "启动命令未成功，可在手机上手动点开"

echo
log "=========== 完成 ==========="
