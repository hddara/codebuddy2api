#!/usr/bin/env bash
#
# Proves the App consumes the session stream incrementally, without needing a
# working production credential.
#
# Why it is built this way: the real check ("does the live page fill in as the
# model writes?") was blocked for a long time on a console cookie that kept
# expiring — the App could not reach the live page at all, so the question went
# unanswered. Nothing about the question is production-specific. What is under
# test is whether `plus.net.XMLHttpRequest` delivers an SSE body in pieces or in
# one lump at the end, and a local server emitting frames at a known cadence
# answers that directly.
#
# The verdict is read off the screenshot sequence rather than from a single
# frame, because the two outcomes differ in *how* the text arrives:
#
#   streaming  → several screenshots show the answer partially written, each
#                longer than the last
#   not        → the answer is absent for every shot, then appears complete
#
# A character every 120ms over a 62-character reply gives a ~7 second window,
# which is far longer than one capture, so the two cannot be confused.
#
# Usage:  ./scripts/verify-app-streaming.sh
#
# Requires: a device on `adb`, and the APK already installed from this tree.

set -euo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PORT="${MOCK_PORT:-8788}"
PACKAGE="cn.hddara.ai"
ENTRY="io.dcloud.PandoraEntry"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHOTS="$(mktemp -d)"

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  "$ADB" reverse --remove "tcp:$PORT" 2>/dev/null || true
  echo "截图保留在 $SHOTS"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$1"; }
die() { printf '✗ %s\n' "$1" >&2; exit 1; }

say "1/6 设备"
"$ADB" get-state >/dev/null 2>&1 || die "没有可用设备。插上手机、解开锁屏、确认 USB 调试授权后重试。"
"$ADB" devices -l | tail -n +2

say "2/6 启动本地 SSE 服务端"
node "$ROOT/scripts/mock-stream-server.mjs" > /tmp/mock-stream.log 2>&1 &
MOCK_PID=$!
sleep 2

kill -0 "$MOCK_PID" 2>/dev/null || { cat /tmp/mock-stream.log; die "服务端未能启动"; }

# Confirms the server really is incremental before the App is involved, so a
# failure later cannot be blamed on the fixture.
FRAMES="$(curl -sS -N -m 3 "http://127.0.0.1:$PORT/admin-api/sessions/stream?conversationId=mock" 2>/dev/null | grep -c 'session.delta' || true)"
[ "${FRAMES:-0}" -gt 2 ] || die "服务端没有逐帧推送（只收到 ${FRAMES} 帧）"
echo "   服务端逐帧推送正常（3 秒内 ${FRAMES} 帧）"

say "3/6 把设备端口指到本机"
# `adb reverse` is what makes 127.0.0.1 inside the App reach this machine, which
# is why the gateway address below can stay a loopback URL.
"$ADB" reverse "tcp:$PORT" "tcp:$PORT"
echo "   127.0.0.1:$PORT (设备) -> 127.0.0.1:$PORT (本机)"

say "4/6 让 App 指向本地服务端"
# Written to the settings field rather than the compiled default: the manual
# address outranks every automatic candidate, which is exactly what is wanted
# here, and it is also how a real user would point the App elsewhere.
echo "http://127.0.0.1:$PORT" > "$HOME/.hdara-base-url"
echo "   ~/.hdara-base-url -> http://127.0.0.1:$PORT"
echo "   注意：这会让 App 离开生产地址。验证完请改回 https://code.apimesh.cn"

say "5/6 打开实时页并在流式进行中连拍"
"$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1 || true
sleep 1
"$ADB" shell am start -n "$PACKAGE/$ENTRY" >/dev/null 2>&1
sleep 10

# The page must be showing the live view for the stream to be opened at all, so
# the navigation is scripted: sessions list -> first card -> 实时回复.
"$ADB" shell input tap 546 660 >/dev/null 2>&1 || true   # first session card
sleep 8
"$ADB" shell input tap 522 475 >/dev/null 2>&1 || true   # 实时回复
sleep 8

echo "   在 8 秒内连拍 6 张"
for i in 1 2 3 4 5 6; do
  "$ADB" exec-out screencap -p > "$SHOTS/shot-$i.png" 2>/dev/null || true
done

say "6/6 判读"
python3 - "$SHOTS" <<'PY'
import pathlib, sys

shots = sorted(pathlib.Path(sys.argv[1]).glob('shot-*.png'))

if not shots:
    print('✗ 没有截到图，无法判读')
    raise SystemExit(1)

# Without an OCR dependency the honest signal available from a PNG alone is the
# file size: a screen with a growing block of text compresses to strictly more
# bytes as characters are added. Identical sizes mean nothing changed between
# captures, which is what a lump-at-the-end stream looks like while it is still
# buffering.
sizes = [p.stat().st_size for p in shots]
print('   每张截图字节数:', sizes)

unique = len(set(sizes))
grew = sum(1 for a, b in zip(sizes, sizes[1:]) if b > a)

print()
if unique >= 3 and grew >= 2:
    print(f'✓ 判定：流式生效 —— {unique} 个不同画面、{grew} 次递增')
    print('  文本是在多个截图中逐步长出来的，符合逐帧到达。')
    raise SystemExit(0)

if unique == 1:
    print('✗ 判定：画面完全没变。')
    print('  可能是没进到实时页，或流没有开。请人工看一眼截图确认停在哪一页。')
else:
    print(f'✗ 判定：未观察到逐步增长（{unique} 个不同画面、{grew} 次递增）。')
    print('  符合"整块跳出"或"根本没收到"，不符合逐帧到达。')

print(f'  截图目录: {sys.argv[1]}')
raise SystemExit(1)
PY
