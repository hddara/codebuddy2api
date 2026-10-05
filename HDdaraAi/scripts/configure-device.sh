#!/usr/bin/env bash
#
# 往已安装的 App 里填好「网关地址 + 控制台 Cookie」，免去每次 `pm clear`
# 或重装后用手在手机上敲一遍。
#
#   ./configure-device.sh                 # 凭据取自 ~/.hdara-base-url 与 ~/.hdara-cookie
#   ./configure-device.sh --base-url https://xxx.ngrok-free.dev --cookie <token>
#   ./configure-device.sh --cookie-file ~/.hdara-cookie
#   ./configure-device.sh --show          # 只读：报长度并遮蔽（默认，安全）
#   ./configure-device.sh --show-full     # 只读：打印完整值（会进终端历史，慎用）
#
# 为什么用 UI 自动化而不是直接写存储：
#   release 包是 `not debuggable`，`adb shell run-as` 被系统拒绝；剪贴板在 Android 10+
#   也已禁止 adb 写入（`cmd clipboard` 无实现）。所以「像用户一样填表」是唯一不改包、
#   不降级安全性的路径。
#
# 为什么不硬编码坐标：
#   输入框位置随屏幕尺寸/字体/布局变化，写死坐标在换设备或改版后必然失效。
#   这里每次都从 `uiautomator dump` 解析真实 bounds —— 慢一点，但不会静默点错。
set -euo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PKG="cn.hddara.ai"
ACTIVITY="cn.hddara.ai/io.dcloud.PandoraEntry"

BASE_URL=""
COOKIE=""
COOKIE_FILE=""
MODE="write"

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --cookie)   COOKIE="${2:-}"; shift 2 ;;
    --cookie-file) COOKIE_FILE="${2:-}"; shift 2 ;;
    --show)     MODE="show"; shift ;;
    # 只在确需核对完整值时用：输出会被终端历史与录屏记录。
    --show-full) MODE="show-full"; shift ;;
    -h|--help)  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$COOKIE_FILE" ]; then
  if [ ! -r "$COOKIE_FILE" ]; then
    echo "读不到 cookie 文件：$COOKIE_FILE" >&2
    exit 1
  fi
  # 只取第一行并去掉首尾空白，避免文件末尾换行被当作 token 的一部分。
  COOKIE="$(head -1 "$COOKIE_FILE" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
fi

# 单独调用时也从约定位置兜底读取，这样不必每次都把长 token 粘在命令行上
# （命令行会进 shell 历史）。显式传入的参数仍然优先。
if [ "$MODE" = "write" ]; then
  if [ -z "$BASE_URL" ] && [ -r "$HOME/.hdara-base-url" ]; then
    BASE_URL="$(head -1 "$HOME/.hdara-base-url" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  fi
  if [ -z "$COOKIE" ] && [ -r "$HOME/.hdara-cookie" ]; then
    COOKIE="$(head -1 "$HOME/.hdara-cookie" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  fi
fi

if [ "$MODE" = "write" ] && { [ -z "$BASE_URL" ] || [ -z "$COOKIE" ]; }; then
  echo "写入模式需要 --base-url 与（--cookie 或 --cookie-file）。" >&2
  echo "用法见 --help。" >&2
  exit 2
fi

if [ ! -x "$ADB" ]; then
  echo "找不到 adb：$ADB" >&2
  exit 1
fi

DEVICE="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
if [ -z "$DEVICE" ]; then
  echo "没有已连接（且已授权）的设备" >&2
  exit 1
fi
echo "== 设备 $DEVICE =="

dump_ui() {
  # 取当前界面层级，成功则打印文件路径，失败打印空串。
  #
  # 返回空而不是直接退出：轮询等待界面就绪时，dump 失败（设备忙碌、正在启动）
  # 是**预期内**的一次尝试，不该中断整个脚本。
  local out=/tmp/hdara-ui.xml
  rm -f "$out"
  "$ADB" shell uiautomator dump /sdcard/hdara-ui.xml >/dev/null 2>&1 || true
  "$ADB" pull /sdcard/hdara-ui.xml "$out" >/dev/null 2>&1 || true
  if [ ! -s "$out" ]; then
    sleep 1
    "$ADB" shell uiautomator dump /sdcard/hdara-ui.xml >/dev/null 2>&1 || true
    "$ADB" pull /sdcard/hdara-ui.xml "$out" >/dev/null 2>&1 || true
  fi
  [ -s "$out" ] && echo "$out"
}

# 需要界面必然可用时用它；拿不到就直接失败。
require_ui() {
  local out
  out="$(dump_ui)"
  if [ -z "$out" ]; then
    echo "uiautomator dump 失败（设备是否已连接？）" >&2
    exit 1
  fi
  echo "$out"
}

# 用 Python 解析 XML：纯 sed/grep 处理嵌套与属性转义太脆。
# 输出每行 `index centerX centerY`，供调用方按序取。
parse_edits() {
  python3 - "$1" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for i, node in enumerate(re.finditer(r'<node[^>]*class="android.widget.EditText"[^>]*>', xml)):
    m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node.group(0))
    if not m:
        continue
    x1, y1, x2, y2 = map(int, m.groups())
    print(f"{i} {(x1 + x2) // 2} {(y1 + y2) // 2}")
PY
}

parse_edit_values() {
  python3 - "$1" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for i, node in enumerate(re.finditer(r'<node[^>]*class="android.widget.EditText"[^>]*>', xml)):
    text = re.search(r'text="([^"]*)"', node.group(0))
    print(f"{i}\t{text.group(1) if text else ''}")
PY
}

# 从 dump 里取「设置」入口坐标；找不到时输出空。
#
# 关键：承载 tab 文案的 TextView 自身 bounds 是 **[0,0][0,0]**（零面积），真正可点的
# 是它的**祖先容器**。所以不能「找 text=设置 且 bounds 非零」——那样永远匹配不到，
# 曾在冷启动验证里被误判成「App 没起来」。正确做法是沿父链向上找到有面积的节点。
settings_tab_coords() {
  python3 - "$1" <<'PY'
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except ET.ParseError:
    sys.exit(0)


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
    if x2 > x1 and y2 > y1:
        return (x1 + x2) // 2, (y1 + y2) // 2
    return None


# 建立 child -> parent 映射（ElementTree 没有 parent 指针）。
parents = {child: parent for parent in root.iter() for child in parent}

for node in root.iter():
    if (node.get('text') or '').strip() != '设置':
        continue
    # 从命中节点向上找第一个有面积的祖先 —— 那才是可点的 tab 容器。
    current = node
    while current is not None:
        found = centre(current)
        if found:
            print(*found)
            sys.exit(0)
        current = parents.get(current)
PY
}

# 点「设置」tab，坐标同样来自 dump，不写死。
#
# 这里**不能固定 sleep 后点一次**：`pm clear` 之后 App 是彻底的冷启动
# （WebView 要重新初始化并加载全部前端资源），固定等待 12 秒时界面往往还没起来，
# 表现为「找不到设置入口」——曾把一次正常的自动化判成失败。
# 改成轮询直到入口出现，并在每次重试前把 App 重新拉到前台。
tap_settings_tab() {
  local attempt xml tab
  for attempt in $(seq 1 20); do
    xml="$(dump_ui)"
    tab="$(settings_tab_coords "$xml")"
    if [ -n "$tab" ]; then
      "$ADB" shell input tap $tab
      sleep 4
      return 0
    fi
    # 界面还没就绪：可能是启动中，也可能是 App 掉到后台。两种情况都再拉一次。
    "$ADB" shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true
    sleep 3
  done

  echo "找不到「设置」入口：等待约 $((20 * 3)) 秒后仍未出现。" >&2
  echo "请确认 App 已安装、能正常启动（可先手动打开看一眼）。" >&2
  exit 1
}

# 先用同一枚凭据探一次网关。放在最前面，是为了在**改动设备之前**就发现「token 已过期」——
# 否则整个流程会走完，最后卡在一句含糊的「未登录」，让人以为是 App 或存储出了问题。
if [ -n "$BASE_URL" ]; then
  probe="$(curl -s -m 20 -o /dev/null -w '%{http_code}' \
    -H "Cookie: codebuddy_admin_session=$COOKIE" \
    "$BASE_URL/admin-api/sessions?windowMinutes=1440" 2>/dev/null || echo 000)"

  case "$probe" in
    200) echo "== 凭据校验：有效 ==" ;;
    401 | 403)
      # `${probe}` 必须带花括号：紧跟中文全角标点时，shell 会把「）」当成变量名的一部分，
      # 报 `probe）: unbound variable`。这个坑在文档 §4 记过，这里又踩了一次。
      echo "✗ 网关拒绝了这枚 Cookie（HTTP ${probe}）。" >&2
      echo "  请重新登录控制台，复制新的 codebuddy_admin_session 值。" >&2
      exit 1
      ;;
    000) echo "== 凭据校验：跳过（网关不可达，稍后由 App 侧暴露）==" ;;
    *) echo "== 凭据校验：HTTP ${probe}（非 200，继续尝试）==" ;;
  esac
fi

echo "== 启动 App 并等待界面就绪 =="
"$ADB" shell am force-stop "$PKG" >/dev/null 2>&1 || true
"$ADB" shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true
tap_settings_tab

XML="$(require_ui)"

if [ "$MODE" = "show" ]; then
  echo "== 当前设置页内容 =="
  # 默认只报长度并把值遮蔽：Cookie 是可直接冒充管理会话的凭据，它出现在终端里
  # （或被人从终端历史/录屏里截走）就等于泄露。要看明文需显式加 --show-full。
  parse_edit_values "$XML" | while IFS=$'\t' read -r idx value; do
    if [ "$MODE" = "show-full" ]; then
      printf "  EDIT%s (%d 字符) %s\n" "$idx" "${#value}" "$value"
    elif [ "${#value}" -gt 0 ]; then
      printf "  EDIT%s (%d 字符) %s…\n" "$idx" "${#value}" "${value:0:4}"
    else
      printf "  EDIT%s (空)\n" "$idx"
    fi
  done
  exit 0
fi

mapfile -t EDITS < <(parse_edits "$XML")
if [ "${#EDITS[@]}" -lt 2 ]; then
  echo "设置页输入框数量异常（找到 ${#EDITS[@]} 个）" >&2
  exit 1
fi

# 输入框顺序：0=网关地址，1=控制台 Cookie（第三个小程序 API Key，按需忽略）。
read -r _ ADDR_X ADDR_Y <<<"${EDITS[0]}"
read -r _ COOKIE_X COOKIE_Y <<<"${EDITS[1]}"

# 清空再填：输入框里可能已有编译期默认地址，直接 `input text` 会**追加**，
# 拼出 `https://...devhttps://...dev` 这种非法值，App 报“Unable to resolve host”。
clear_field() {
  "$ADB" shell input tap "$1" "$2"
  sleep 2
  "$ADB" shell input keyevent KEYCODE_MOVE_END
  sleep 1
  # 退格次数取足够大（120）：`input keyevent` 无法一次删多字符。
  local i
  for ((i = 0; i < 120; i += 1)); do
    "$ADB" shell input keyevent KEYCODE_DEL
  done
  sleep 1
}

echo "== 填入网关地址 =="
clear_field "$ADDR_X" "$ADDR_Y"
"$ADB" shell input text "$BASE_URL"
sleep 2

echo "== 填入控制台 Cookie =="
clear_field "$COOKIE_X" "$COOKIE_Y"
"$ADB" shell input text "$COOKIE"
sleep 2

# 保存按钮同理由 dump 定位（文案为「保存」）。
XML="$(require_ui)"
SAVE="$(python3 - "$XML" <<'PY'
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except ET.ParseError:
    sys.exit(0)


def centre(node):
    raw = node.get('bounds') or ''
    try:
        left, rest = raw.split(',', 1)
        top, rest = rest.split('][', 1)
        right, bottom = rest.rstrip(']').split(',', 1)
        x1, y1, x2, y2 = int(left.lstrip('[')), int(top), int(right), int(bottom)
    except ValueError:
        return None

    # 注意括号：写成 `return a, b if cond else None` 会解析成
    # `(a, (b if cond else None))` —— tuple 恒为真，零面积节点也会被当成命中。
    if x2 > x1 and y2 > y1:
        return (x1 + x2) // 2, (y1 + y2) // 2
    return None


parents = {child: parent for parent in root.iter() for child in parent}

# 同 tab：按钮上的文字节点可能没有面积，需要沿父链上溯到可点容器。
for node in root.iter():
    if (node.get('text') or '').strip() != '保存':
        continue
    current = node
    while current is not None:
        found = centre(current)
        if found:
            print(*found)
            sys.exit(0)
        current = parents.get(current)
PY
)"
if [ -z "$SAVE" ]; then
  echo "找不到「保存」按钮" >&2
  exit 1
fi
"$ADB" shell input tap $SAVE
sleep 2

echo "== 回读校验 =="
# 校验的是**落盘结果**，不是输入框里的字。
#
# 只回读输入框会给出假阳性：`input text` 之后输入框本来就有值，即使「保存」没点到
# （按钮没找到、页面还没渲染完、点击落在别处）也照样“长度正确”。实测遇到过——
# 脚本报成功，而 App 仍显示「尚未登录」。所以这里读设置页自己渲染的状态文案。
COOKIE_LEN="${#COOKIE}"
ADDR_LEN="${#BASE_URL}"

verify_saved() {
  python3 - "$1" "$ADDR_LEN" "$COOKIE_LEN" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
addr_len, cookie_len = sys.argv[2], sys.argv[3]
texts = [t for t in re.findall(r'text="([^"]*)"', xml)]

configured = any('已配置' in t for t in texts)
# 「存储：cookie(43) / https://…」是落盘后的回显，长度必须与所填一致。
stored = next((t for t in texts if t.strip().startswith('存储：')), '')

problems = []
if not configured:
    problems.append('设置页未显示「已配置」')
if not stored:
    problems.append('未找到落盘回显')
else:
    m = re.search(r'cookie\((\d+)\)', stored)
    if not m:
        problems.append(f'落盘回显缺少 cookie 长度：{stored}')
    elif m.group(1) != cookie_len:
        problems.append(f'落盘 cookie 长度 {m.group(1)}，期望 {cookie_len}')

print('PROBLEMS=' + '|'.join(problems))
print('STORED=' + stored)
PY
}

ok=1
for attempt in 1 2 3 4 5; do
  XML="$(require_ui)"
  RESULT="$(verify_saved "$XML")"
  PROBLEMS="$(sed -n 's/^PROBLEMS=//p' <<<"$RESULT")"
  STORED="$(sed -n 's/^STORED=//p' <<<"$RESULT")"

  if [ -z "$PROBLEMS" ]; then
    ok=1
    break
  fi

  # 落盘是**异步**的：App 的 setStorageSync 在原生桥就绪前会静默丢弃，代码里
  # 是带重试的，而设置页的「存储：…」回显本身也有约 1.8 秒延迟。早先只等 2 秒，
  # 曾出现「脚本报成功、随后冷启动又提示未登录」——保存其实还没落地。
  # 这里给足时间，并在每轮补点一次保存。
  ok=0
  if [ "$attempt" -lt 5 ]; then
    sleep 2
    "$ADB" shell input tap $SAVE >/dev/null 2>&1 || true
    sleep 2
  fi
done

if [ "$ok" = "1" ]; then
  echo "  ✓ 已落盘：$STORED"
else
  echo "  ✗ 保存未生效：$PROBLEMS" >&2
  echo "    请在手机上打开「设置」页确认（也可能是屏幕尺寸导致按钮位置解析偏差）" >&2
  exit 1
fi

# 终极校验：冷启动后会话页必须真的能取到数据。
#
# 这一步不能省。前面读的都是设置页自身的回显，而它只能证明「设置页认为已保存」；
# 曾经出现过回显正常、冷启动后却回到「尚未登录」的情况（异步落盘未完成）。
# 判定配置是否成功，看的是**数据能不能拿到**，不是界面文案。
echo "== 冷启动校验 =="
"$ADB" shell am force-stop "$PKG" >/dev/null 2>&1 || true
sleep 2
"$ADB" shell am start -n "$ACTIVITY" >/dev/null 2>&1 || true

verified=0
for attempt in $(seq 1 8); do
  sleep 5
  XML="$(dump_ui)"
  [ -n "$XML" ] || continue

  STATE="$(python3 - "$XML" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
texts = [t for t in re.findall(r'text="([^"]*)"', xml)]
if any('尚未登录' in t or 'Admin session' in t for t in texts):
    print('NOT_LOGGED_IN')
elif any(re.match(r'\d+ 个会话', t) or '没有会话' in t or '该时间范围' in t for t in texts):
    print('OK')
else:
    print('WAIT')
PY
)"

  case "$STATE" in
    OK) verified=1; break ;;
    NOT_LOGGED_IN)
      # "Not signed in" here does NOT mean the write failed: it means the app
      # reached the gateway and the gateway refused the credential. The two
      # causes need different actions, so they are reported differently —
      # conflating them sent me chasing a storage bug that did not exist.
      echo "  ✗ 冷启动后仍未登录。存储写入是成功的（上一行已确认），" >&2
      echo "    因此更可能是**凭据本身已失效**，请重新登录控制台取新的 Cookie。" >&2
      echo "    自检：curl -o /dev/null -w '%{http_code}' -H \\"Cookie: codebuddy_admin_session=<token>\\" \\"$BASE_URL/admin-api/sessions\\"" >&2
      exit 1
      ;;
  esac
done

if [ "$verified" = "0" ]; then
  echo "  [警告] 未能确认会话页已连通（界面可能仍在加载），请在手机上确认" >&2
else
  echo "  ✓ 冷启动后会话页正常取到数据"
fi

echo "完成。"
