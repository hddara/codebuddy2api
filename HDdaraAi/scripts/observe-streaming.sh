#!/usr/bin/env bash
#
# Measures what is on the screen right now and judges whether it is streaming.
#
# Split out from `verify-app-streaming.sh` on purpose. That script had to drive
# the App into the live page as well, which needs a working console credential —
# and when the credential is dead the script cannot tell "streaming is broken"
# from "it never got to the page". The two are worth separating: navigating needs
# credentials, measuring does not.
#
# So this half stays dumb and honest. You put the App on the live page and start
# a question; this records the screen repeatedly and reports whether the text was
# still growing. Nothing here can be fooled by a missing credential, because it
# never asks for one.
#
# Usage:
#   1. On the device: open the App -> a session -> 实时回复
#   2. Ask a question (or trigger one from the IDE)
#   3. Run this script *while the answer is still arriving*
#
#   ./scripts/observe-streaming.sh
#
# Environment:
#   SHOTS=12   how many captures
#   GAP=0.35   seconds between captures

set -euo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SHOTS="${SHOTS:-12}"
GAP="${GAP:-0.35}"
DIR="$(mktemp -d)"

say() { printf '\n== %s\n' "$1"; }

say "设备"
"$ADB" get-state >/dev/null 2>&1 || { echo "✗ 没有可用设备" >&2; exit 1; }
"$ADB" devices -l | tail -n +2

say "连拍 $SHOTS 张，间隔 ${GAP}s"
for i in $(seq 1 "$SHOTS"); do
  "$ADB" exec-out screencap -p > "$DIR/shot-$(printf '%02d' "$i").png" 2>/dev/null || true
  sleep "$GAP"
done

say "读屏文本"
# Dumps the accessibility tree once per capture is too slow to interleave with
# the images, so the text sample is taken once at the end — it is here to say
# *what* was on screen, which is what makes the image sizes interpretable.
"$ADB" shell "uiautomator dump /sdcard/observe.xml" >/dev/null 2>&1 || true
"$ADB" pull /sdcard/observe.xml "$DIR/ui.xml" >/dev/null 2>&1 || true

python3 - "$DIR" <<'PY'
import pathlib, re, sys

d = pathlib.Path(sys.argv[1])
shots = sorted(d.glob('shot-*.png'))
sizes = [p.stat().st_size for p in shots]

if not shots:
    print('✗ 没有截到图')
    raise SystemExit(1)

print('  每张字节数:', sizes)

# What was on screen, so a "nothing changed" verdict can be read correctly: a
# still screen showing 等待输出 and a still screen showing a finished answer mean
# very different things.
ui = d / 'ui.xml'
if ui.exists():
    xml = ui.read_text(encoding='utf-8', errors='replace')
    texts = [t for t in re.findall(r'text="([^"]*)"', xml) if t.strip()]

    pages = [t for t in texts if t.startswith('pages/')]
    print('  页面:', pages or '(读不到)')

    marks = [
        t for t in texts
        if t in ('发送', '终止', '停止', '已终止')
        or '输出' in t
        or '等待' in t
        or t.endswith('字')
    ]
    print('  状态:', marks[:6] or '(读不到)')

unique = len(set(sizes))
grew = sum(1 for a, b in zip(sizes, sizes[1:]) if b > a)
shrank = sum(1 for a, b in zip(sizes, sizes[1:]) if b < a)

print()
print(f'  不同画面 {unique} 个，递增 {grew} 次，递减 {shrank} 次')
print()

# A PNG of a screen with growing text compresses to strictly more bytes as
# characters are added, so "several distinct sizes, mostly increasing" is the
# signature of incremental arrival. It is a proxy rather than OCR, which is why
# the verdict is stated alongside the raw numbers and the captured text above
# instead of on its own.
if unique >= 3 and grew >= 2 and grew > shrank:
    print('✓ 流式：文本在多个画面中逐步增长')
    raise SystemExit(0)

if unique == 1:
    print('? 画面完全静止 —— 无法判断。')
    print('  可能答完了、可能卡在加载态、也可能根本没开始。看上面的状态行。')
    raise SystemExit(2)

print('? 画面有变化但未见稳定增长。')
print('  可能是轮询式整块刷新（每次替换一整段），也可能是滚动或动画。')
raise SystemExit(2)
PY

echo
echo "截图保留在 $DIR"
