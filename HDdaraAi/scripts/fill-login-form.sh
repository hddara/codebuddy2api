#!/usr/bin/env bash
#
# Fills the app's login form and presses 登录, verifying every field by reading
# it back before submitting.
#
# Why this is a script rather than a few `adb` calls: `input text` appends rather
# than replaces, and the field's existing value is only inspectable through
# `uiautomator dump`. Typing without checking produced a password one character
# too long more than once, and the resulting "nothing happens on tap" looked like
# an app bug rather than a bad input.
#
# Coordinates are resolved from every dump rather than remembered: the form moved
# by more than a hundred pixels between builds, and stale coordinates silently
# tap empty space.
#
# Usage:
#   scripts/fill-login-form.sh <base-url> <password> [username]
set -euo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PKG="cn.hddara.ai"

BASE_URL="${1:?usage: fill-login-form.sh <base-url> <password> [username]}"
PASSWORD="${2:?usage: fill-login-form.sh <base-url> <password> [username]}"
USERNAME="${3:-admin}"

DUMP=/tmp/hdara-fill-ui.xml

dump() {
  "$ADB" shell uiautomator dump /sdcard/hdara-fill.xml >/dev/null 2>&1 || true
  "$ADB" pull /sdcard/hdara-fill.xml "$DUMP" >/dev/null 2>&1 || true
  [ -s "$DUMP" ] || echo ''
}

# Prints: `<index> <centreX> <centreY> <visible length>` per EditText.
#
# The length rather than the value: the credential fields are masked, so a dump
# only ever shows dots. Length is what catches a stray leading character, which
# is the failure this script exists to avoid.
fields() {
  python3 - "$DUMP" <<'PY'
import re
import sys

try:
    xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
except OSError:
    raise SystemExit(0)

for i, node in enumerate(re.finditer(r'<node[^>]*class="android.widget.EditText"[^>]*>', xml)):
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node.group(0))
    if not bounds:
        continue
    x1, y1, x2, y2 = map(int, bounds.groups())
    text = re.search(r'text="([^"]*)"', node.group(0))
    value = text.group(1) if text else ''
    print(f'{i} {(x1 + x2) // 2} {(y1 + y2) // 2} {len(value)}')
PY
}

# Centre of the first clickable ancestor of a node whose text matches exactly.
button() {
  python3 - "$DUMP" "$1" <<'PY'
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    raise SystemExit(0)

target = sys.argv[2]


def bounds(node):
    raw = node.get('bounds') or ''
    try:
        left, rest = raw.split(',', 1)
        top, rest = rest.split('][', 1)
        right, bottom = rest.rstrip(']').split(',', 1)
        return int(left.lstrip('[')), int(top), int(right), int(bottom)
    except ValueError:
        return 0, 0, 0, 0


def centre(node):
    x1, y1, x2, y2 = bounds(node)
    return ((x1 + x2) // 2, (y1 + y2) // 2) if x2 > x1 and y2 > y1 else None


parents = {child: parent for parent in root.iter() for child in parent}

for node in root.iter():
    if (node.get('text') or '').strip() != target:
        continue
    current = node
    while current is not None:
        found = centre(current)
        if found:
            print(*found)
            raise SystemExit(0)
        current = parents.get(current)
PY
}

# Fills a field that is expected to be empty.
#
# Used for the password field: the form starts with it blank and never prefills
# it, so appending is the correct operation and no clearing is involved. The
# delete-then-retype fallback exists only in case a previous run left something
# behind, which is reported rather than assumed.
set_empty_field() {
  local label="$1" x="$2" y="$3" want="$4" index="$5"
  local got i

  "$ADB" shell input tap "$x" "$y"
  sleep 2

  got="$(fields | awk -v i="$index" '$1 == i { print $4 }')"
  if [ "${got:-0}" != '0' ]; then
    for ((i = 0; i < got + 20; i += 1)); do
      "$ADB" shell input keyevent KEYCODE_DEL
    done
    sleep 1
  fi

  "$ADB" shell input text "$want"
  sleep 2

  got="$(fields | awk -v i="$index" '$1 == i { print $4 }')"
  if [ "$got" = "${#want}" ]; then
    echo "  ok    ${label}（${got} 字符）"
    return 0
  fi

  echo "✗ 「${label}」回读 ${got} 字符，期望 ${#want}" >&2
  return 1
}

# Replaces the contents of the field at the given centre.
#
# ⚠️ This does not work on this device and is kept only for short values whose
# exact prefix the caller controls. Measured: neither backspace (`KEYCODE_DEL`
# arrives before the input connection is attached, so the app never sees it) nor
# select-all-then-type replaces an existing value — the field keeps its original
# text and the typed characters are appended. A field that the app prefills
# therefore cannot be rewritten through `adb`, which is why the caller prefers to
# leave the prefilled origin alone.
set_field() {
  local label="$1" x="$2" y="$3" want="$4" index="$5"
  local attempt got i

  for attempt in 1 2 3; do
    "$ADB" shell input tap "$x" "$y"
    sleep 2
    "$ADB" shell input keyevent KEYCODE_MOVE_END
    sleep 1

    # Backspace is what the first attempt used, and it does not work here: the
    # field keeps its original contents because the delete keys are delivered
    # while no input connection is attached yet (the soft keyboard is still
    # animating in), so the app never sees them. Select-all then overwrite
    # replaces the text in one action and does not depend on that timing.
    "$ADB" shell input keyevent --longpress KEYCODE_DEL >/dev/null 2>&1 || true
    "$ADB" shell input keyevent KEYCODE_CTRL_LEFT KEYCODE_A >/dev/null 2>&1 || true
    sleep 1
    # Typing over a selection replaces it; if the selection did not take, the
    # length check below catches the appended value and retries.
    "$ADB" shell input text "$want"
    sleep 2

    got="$(fields | awk -v i="$index" '$1 == i { print $4 }')"

    if [ "$got" = "${#want}" ]; then
      echo "  ok    ${label}（${got} 字符）"
      return 0
    fi

    # Still wrong: the field holds more than intended. Clear it with enough
    # delete keys that a stale selection cannot survive, then type again.
    for ((i = 0; i < got + 20; i += 1)); do
      "$ADB" shell input keyevent KEYCODE_DEL
    done
    sleep 1
    "$ADB" shell input text "$want"
    sleep 2

    got="$(fields | awk -v i="$index" '$1 == i { print $4 }')"
    if [ "$got" = "${#want}" ]; then
      echo "  ok    ${label}（${got} 字符）"
      return 0
    fi

    echo "  retry ${label}：回读 ${got} 字符，期望 ${#want}" >&2
  done

  echo "✗ 无法写入「${label}」（最后回读 ${got:-?} 字符，期望 ${#want}）" >&2
  return 1
}

# Reach the credential form, whichever screen the app happens to be on. A cold
# start shows the unlock screen when a credential is already stored; a cleared
# install goes straight to the form.
ensure_credential_form() {
  local attempt label

  for attempt in $(seq 1 12); do
    dump >/dev/null
    label="$(python3 - "$DUMP" <<'PY'
import re
import sys

try:
    xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
except OSError:
    raise SystemExit(0)

texts = [t for t in re.findall(r'text="([^"]*)"', xml) if t.strip()]
if any('网关地址' in t for t in texts):
    print('FORM')
elif any('改用凭据登录' in t for t in texts):
    print('UNLOCK')
elif any('使用已保存的凭据进入' in t for t in texts):
    print('UNLOCK')
PY
)"

    case "$label" in
      FORM)
        echo "== 已在登录表单 =="
        return 0
        ;;
      UNLOCK)
        read -r x y < <(button '改用凭据登录' | tail -1)
        if [ -n "${x:-}" ]; then
          echo "== 从解锁页进入登录表单 =="
          "$ADB" shell input tap "$x" "$y"
        fi
        ;;
      *)
        # Still launching.
        ;;
    esac

    sleep 4
  done

  echo "✗ 未能到达登录表单" >&2
  return 1
}

ensure_credential_form
dump >/dev/null
read -r _ ADDR_X ADDR_Y _ < <(fields | sed -n '1p')
read -r _ USER_X USER_Y _ < <(fields | sed -n '2p')
read -r _ PASS_X PASS_Y _ < <(fields | sed -n '3p')

# The origin and username are prefilled by the app and cannot be rewritten
# through `adb` (see `set_field`), so they are only checked. Pass the literal
# `-` to accept whatever the form already holds.
CURRENT_ADDR_LEN="$(fields | awk '$1 == 0 { print $4 }')"
CURRENT_USER_LEN="$(fields | awk '$1 == 1 { print $4 }')"

if [ "$BASE_URL" = '-' ]; then
  echo "  --    网关地址：沿用表单预填值（${CURRENT_ADDR_LEN} 字符）"
elif [ "$CURRENT_ADDR_LEN" = "${#BASE_URL}" ]; then
  echo "  ok    网关地址（${CURRENT_ADDR_LEN} 字符，与期望一致）"
else
  echo "  [警告] 网关地址为 ${CURRENT_ADDR_LEN} 字符，期望 ${#BASE_URL}；" >&2
  echo "         adb 无法改写已预填的字段，请手动确认该地址" >&2
fi

if [ "$CURRENT_USER_LEN" = "${#USERNAME}" ]; then
  echo "  ok    账号（${CURRENT_USER_LEN} 字符）"
else
  echo "  [警告] 账号为 ${CURRENT_USER_LEN} 字符，期望 ${#USERNAME}" >&2
fi

# The password is the one field the app leaves blank, so it is the one this
# script can set reliably.
set_empty_field '密码' "$PASS_X" "$PASS_Y" "$PASSWORD" 2

# Read every field once more before submitting: a wrong value here is
# indistinguishable from an app fault at the next step.
echo "== 提交前回读 =="
fields | while read -r idx _ _ len; do
  case "$idx" in
    0) echo "  网关地址: ${len} 字符（期望 ${#BASE_URL}）" ;;
    1) echo "  账号    : ${len} 字符（期望 ${#USERNAME}）" ;;
    2) echo "  密码    : ${len} 字符（期望 ${#PASSWORD}）" ;;
  esac
done

dump >/dev/null
read -r BTN_X BTN_Y < <(button '登录' | tail -1)
if [ -z "${BTN_X:-}" ]; then
  echo "找不到「登录」按钮" >&2
  exit 1
fi

echo "== 提交（点 ${BTN_X},${BTN_Y}）=="
"$ADB" shell input tap "$BTN_X" "$BTN_Y"

# The result arrives as a toast, which is a `PopupWindow` that lives for about
# two seconds. Dumping after the fact finds nothing and looks like "the button
# did nothing", which is what an earlier round concluded — the tap had worked all
# along. So poll during the window and report whatever text appears that was not
# on the form beforehand.
echo "== 提交结果 =="
known='pages/login/index HDdaraAI 查看 AI 会话状态 登录 使用控制台账号登录 网关地址 账号 密码 显示 改用 Cookie 登录 凭据仅保存在本机 控制台登录密码'

for attempt in 1 2 3 4 5 6 7 8; do
  sleep 1
  dump >/dev/null
  message="$(python3 - "$DUMP" "$known" <<'PY'
import re
import sys

try:
    xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
except OSError:
    raise SystemExit(0)

known = sys.argv[2].split()
for text in (t.strip() for t in re.findall(r'text="([^"]*)"', xml)):
    if not text or text in known:
        continue
    # Skip the field values and the masked password.
    if text.startswith('http') or text == 'admin' or set(text) <= {'•'}:
        continue
    print(text)
PY
)"

  if [ -n "$message" ]; then
    echo "  → $message"
    exit 0
  fi
done

echo "  （没有出现新的提示文字；可能已成功进入，或提示已消失）"
