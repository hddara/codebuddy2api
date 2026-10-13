# 交接：Peekaboo 兼容修复（fix/sse-strict-compat）

> 本文档由上一个会话写入，供在 `codebuddy2api` 项目中新开会话时直接接手。
> 状态：**修复已部署并端到端验证通过（Anthropic 协议路径）；OpenAI Chat 协议路径仍未跑通。**

---

## ⚠️ 最新结论（2026-10-13 晚，重要更正）

**部署后验证发现：OpenAI Chat 协议路径的字段清洗并没有解决 Peekaboo 的
`finish reason 'other'` 问题**——但发现了真正可行的方案：

### ✅ 可用方案：让 Peekaboo 走 **Anthropic 协议**（`/v1/messages`）

```bash
peekaboo config provider add apimesh-anth \
  --type anthropic \
  --name "APIMesh Anthropic" \
  --base-url "https://code.apimesh.cn" \
  --credential-ref '${APIMESH_API_KEY}'

peekaboo agent run "Take a screenshot and list app windows" \
  --model apimesh-anth/deepseek-v4.1-flash --max-steps 15
```

**实测结果：`success: True`，任务完整执行**（例：正确列出本机 17 个运行中的应用，
耗时 23.4s，调用 3 次工具）。

### ❌ 未解决：OpenAI Chat 协议路径

`--type openai` + `/v1/chat/completions` 仍然报
`Model returned a terminal response with finish reason 'other'`，
**即使用本地代理把响应改写成最干净的格式（5 种变体全部失败）**。

**已排除的方向**（不要再试）：

- 非标准字段污染（`extra_fields`/`refusal`/空 `tool_calls:[]`）→ 清理后仍失败
- `name:""` 空串覆盖 → 清理后仍失败
- 帧分隔符 / JSON 合法性 → 逐字节检查完全正确
- 首片缺 `arguments:""`、终止帧 `delta` 非空 → 变体测试全部失败
- 走 `/v1/responses` → Peekaboo 抓包证实它走 `/v1/chat/completions`

**推测**：Tachikoma SDK 的 OpenAI 流式解析器对 `finish_reason` 的映射有问题
（`'other'` 是它自己的兜底枚举值，说明无法把上游值映射到已知枚举），
可能是 SDK 侧 bug，与网关输出无关。

---

## 一、原始问题

Peekaboo（macOS 屏幕自动化工具，内含 Swift 的 Tachikoma AI SDK）通过
`peekaboo agent` 调用本网关时**每一轮都失败**：

```
Agent execution failed: API error: Model returned a terminal response
with finish reason 'other'; refusing to mark the task complete.
```

**关键特征：同一模型在 Cursor / Cline / Claude Code 等多个 IDE 中流式正常。**
说明问题不在模型，而在**客户端解析**或**响应格式的某个细节**。

## 二、根因（已实证，非推断）

用透明抓包代理（`/tmp/peekaboo-tap.js`，监听 `127.0.0.1:8799`）捕获了
Peekaboo 的真实请求，确认：

- Peekaboo 请求 **`POST /v1/chat/completions`**（不是 `/v1/responses`）
- `stream: true`、`tools: 25 个`、`model: deepseek-v4.1-flash`
- 走本项目的 **Chat 直连透传路径** → `normalizeStreamingResponse`
  → `normalizeStreamToolCalls`（`lib/server/proxy/codebuddy.ts`）

捕获到的上游 SSE 帧（每帧都带）：

```json
{
  "choices": [
    {
      "delta": {
        "content": "I",
        "role": "assistant",
        "reasoning_content": "",
        "function_call": null, // ← 已废弃字段，规范中不应出现
        "refusal": "", // ← 位置可疑
        "tool_calls": [], // ← 空数组刷屏
        "extra_fields": null // ← 非标准字段
      },
      "finish_reason": ""
    }
  ]
}
```

首片 tool_call：

```json
{
  "tool_calls": [
    {
      "id": "call_00_xxx",
      "type": "function",
      "function": { "name": "see", "arguments": "" },
      "index": 0
    }
  ]
}
```

后续片（`name` 变成空串，且 arguments 逐字分片）：

```json
{"tool_calls":[{"function":{"name":"","arguments":"{"},"index":0,"id":"call_00_xxx"}]}
{"tool_calls":[{"function":{"name":"","arguments":"\""},"index":0,"id":"call_00_xxx"}]}
... 拼起来是 {"x": "screenshot"}（结果正确，但 name 被空串覆盖）
```

**结论**：JSON 拼装结果本身是对的，但字段语义不合 OpenAI 规范。

| 字段                                    | 问题                                 | 严格客户端的行为           |
| --------------------------------------- | ------------------------------------ | -------------------------- |
| `name: ""`（首片之后）                  | 规范要求**省略该键**，而非置空       | 读成"把已收集的 name 清空" |
| `tool_calls: []`                        | 规范中内容帧不应含该键               | 读成"工具调用列表被重置"   |
| `function_call: {name:"",arguments:""}` | 已废弃字段，终止帧给出非 null 空对象 | 判定响应结构异常           |
| `extra_fields` / `refusal`              | 非标准字段                           | 部分客户端直接拒绝整帧     |

宽容客户端（多数 IDE）忽略未知字段 → 正常；
严格客户端（Tachikoma / Vercel AI SDK 严格模式）→ `finish reason 'other'`。

## 三、已做的修改（分支 `fix/sse-strict-compat`，提交 `cb11cfd`）

### 改动文件

| 文件                            | 改动               |
| ------------------------------- | ------------------ |
| `lib/server/proxy/codebuddy.ts` | +149 / -7          |
| `.env.example`                  | +7（新增开关文档） |

### 核心逻辑

在 `normalizeStreamToolCalls` 的透传路径上做**规范化清洗**：

1. **`sanitizeStreamDelta()`**（新增）
   - 删除 `extra_fields`、`refusal`
   - 空 `tool_calls: []` → 删除该键
   - `function_call` 为 `null` / `undefined` / 空对象 → 删除该键
   - `reasoning_content` **保留**（`anthropic.ts` L471/L659 真实消费，用于转 Anthropic thinking）

2. **tool_call 的 name 处理**
   - 首片（`name` 非空）→ 保留 `name`，记录到 `state.namedToolCalls`
   - 后续片 → **删除 `function.name` 键**（而非置空串）
   - 空 `arguments` → 删除该键

3. **`ToolCallNormalizationState`** 新增 `namedToolCalls: Set<string>` 字段

4. **开关 `CODEBUDDY_SSE_STRICT_COMPAT`**（默认开启）
   - `0` / `false` / `off` / `no` → 完全原样透传（应急回退）
   - 贯穿 `sanitizeStreamDelta` 与 tool_call name 处理两处

### 代码位置速查

- `lib/server/proxy/codebuddy.ts`
  - `NON_STANDARD_DELTA_FIELDS` / `isStrictSseCompatEnabled()` — 开关常量
  - `sanitizeStreamDelta()` — 帧清洗
  - `stripBlankStringFields()` — 空串字段剥离
  - `normalizeStreamToolCalls()` — 主入口（首片/后续片 name 分支）
  - `normalizeStreamingResponse()` — Chat 透传路径，state 初始化处

## 四、验证状态

| 项                              | 结果                                 |
| ------------------------------- | ------------------------------------ |
| `bun run typecheck`             | ✅ 通过                              |
| `bun run lint`                  | ✅ 通过（`--max-warnings=0`）        |
| `bun run test`                  | ✅ **494 passed / 36 files**，零回归 |
| `bun run format`                | ✅ 已格式化                          |
| **端到端验证（Peekaboo 跑通）** | ❌ **未做**                          |
| **部署到服务器**                | ❌ **未做**                          |
| 分支推送                        | ✅ `origin/fix/sse-strict-compat`    |

### 影响面评估（已做）

| 字段                                                | 项目内依赖                                            | 判断              |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| `extra_fields`                                      | 零引用                                                | ✅ 可安全移除     |
| `refusal`                                           | 零引用                                                | ✅ 可安全移除     |
| `delta.function_call`                               | 仅 `app/debug/debug.tsx`（容错取值，取不到返回 null） | ✅ 安全           |
| 空 `tool_calls: []`                                 | 仅 debug 面板（容错）                                 | ✅ 安全           |
| `reasoning_content`                                 | **`anthropic.ts` 真实消费**                           | ✅ **未动，正确** |
| `type: 'function_call'`（字符串值，Responses 协议） | `responses.ts` 依赖                                   | ✅ **未碰**       |

⚠️ **尚未处理**：Responses 路径（`mapResponsesStreamToChat`）和 OpenAI 协议直连路径
的输出同样带这些字段，本次**只改了 Chat 透传路径**（即 Peekaboo 走的路径）。
建议先验证 Chat 路径，确认无副作用后再考虑是否推广。

## 五、部署方式（待执行）

### 已知事实

- 生产域名：**`code.apimesh.cn`**，前置 `openresty` 按 Host 路由
- 镜像仓库：`registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api`
- 部署方式：**Docker Swarm**
  ```bash
  docker stack deploy -c deploy/swarm-stack.yml codebuddy2api
  ```
- 三个部署文件均使用同一 tag：`20261006.T02`
  - `deploy/swarm-stack.yml`
  - `deploy/k8s/codebuddy2api.yaml`
  - `deploy/docker-compose.yml`
- **tag 命名规则**：`YYYYMMDD.T序号`（如 `20261006.T02`）
- 本机 Docker 29.8.2 + buildx 0.37.2 可用
- **本机已登录 ACR**（`registry.cn-hangzhou.aliyuncs.com`）
- 本机是 Apple Silicon，服务器是 Linux/amd64 → **构建必须加 `--platform linux/amd64`**

### 构建命令（在项目根目录、`fix/sse-strict-compat` 分支）

```bash
cd /Users/hddara/HDdaraProject/HDdara/codebuddy2api
git checkout fix/sse-strict-compat

docker buildx build \
  --platform linux/amd64 \
  -t registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api:20261013.T01 \
  --push .
```

### 服务器部署命令

```bash
# 1. 拉镜像
docker pull registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api:20261013.T01

# 2. 改 tag（三个文件，至少改 swarm-stack.yml）
cd <服务器上的仓库路径>
vim deploy/swarm-stack.yml      # image: ...:20261013.T01

# 3. 导出全部环境变量
#    ⚠️ docker stack deploy 不支持 env_file，必须在 shell 里 export
export CODEBUDDY_STORAGE_BACKEND=pg
export DATABASE_URL='postgres://...'
export CODEBUDDY_STORAGE_ENCRYPTION_KEY='...'
export CODEBUDDY_PASSWORD='...'
export CODEBUDDY_GATEWAY_AUTH=password

# 4. 重新部署
docker stack deploy -c deploy/swarm-stack.yml codebuddy2api

# 5. 观察
docker service ls | grep codebuddy
docker service ps codebuddy2api_app
docker service logs -f codebuddy2api_app
```

**回退**：把 tag 改回 `20261006.T02` 重新 `docker stack deploy` 即可。
**应急开关**：`CODEBUDDY_SSE_STRICT_COMPAT=0` 可让新镜像保持旧行为。

## 六、端到端验证方法

### 方法 A：curl 直测端点（最快）

```bash
# 期望：无输出（字段已被清洗）
curl -s -X POST https://code.apimesh.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的 key>" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,
       "messages":[{"role":"user","content":"call see with x=1"}],
       "tools":[{"type":"function","function":{"name":"see","description":"see",
         "parameters":{"type":"object","properties":{"x":{"type":"string"}}}}}],
       "max_tokens":60}' \
  | grep -o '"extra_fields"\|"refusal"\|"tool_calls":\[\]'
```

- **修复生效** → 无输出
- **未生效** → 三个字段都会命中

再核对 name 与 arguments：

```bash
# 期望：name 只在首片出现，后续片无 "name":"" 刷屏
curl -s -X POST https://code.apimesh.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的 key>" \
  -d '{...同上的请求...}' \
  | grep -o '"name":"[^"]*"' | sort | uniq -c
```

### 方法 B：Peekaboo 实跑（最终验收）

```bash
peekaboo agent run "take a screenshot" \
  --model apimesh/deepseek-v4.1-flash --max-steps 3 --json
```

- **成功** → 返回 `success: true`，任务完成
- **仍失败** → 报 `finish reason 'other'`，说明还有未清理的字段

## 七、本机已有的调试资产（可复用）

| 资产              | 位置                      | 用途                                              |
| ----------------- | ------------------------- | ------------------------------------------------- |
| 抓包代理          | `/tmp/peekaboo-tap.js`    | 透明转发 + 记录 peekaboo 的真实请求/响应          |
| 抓包日志          | `/tmp/peekaboo-tap.log`   | JSONL 格式，含 REQ/RESP 两类记录                  |
| Peekaboo provider | `~/.peekaboo/config.json` | 已注册 `apimesh` / `apimesh-tap` / `apimesh-resp` |
| Peekaboo 凭据     | `~/.peekaboo/credentials` | `APIMESH_API_KEY`（走 stdin 存入，未进 argv）     |

抓包代理用法：

```bash
node /tmp/peekaboo-tap.js &      # 监听 127.0.0.1:8799
# 让 peekaboo 走它：
peekaboo agent run "task" --model apimesh-tap/deepseek-v4.1-flash
```

## 八、已排除的错误假设（避免重复走弯路）

排查过程中被实证推翻的假设，**不要再试**：

| #   | 曾经怀疑                                 | 实测结论                                 |
| --- | ---------------------------------------- | ---------------------------------------- |
| 1   | baseUrl 配错（少了 `/chat/completions`） | ❌ `/v1` 是对的；写全会变成双拼导致 404  |
| 2   | 网关不支持流式                           | ❌ 支持，SSE 正常                        |
| 3   | 项目转译逻辑损坏了 JSON                  | ❌ 拼装结果正确（`{"x": "screenshot"}`） |
| 4   | 缺 `event:` 行                           | ❌ Chat 规范本就不需要；Responses 路径有 |
| 5   | Peekaboo 走 Responses API                | ❌ 抓包证实走 `/v1/chat/completions`     |
| 6   | 模型不支持 tool_calls                    | ❌ 支持，非流式返回完全正确              |

## 九、下一步（接手即可执行）

1. **构建并推送镜像**（命令见第五节）
2. **部署到服务器**（命令见第五节）
3. **curl 验证端点输出**（方法 A）
4. **Peekaboo 实跑验收**（方法 B）
5. **验证通过后合并**：
   ```bash
   git checkout main
   git merge fix/sse-strict-compat
   git push origin main      # 触发 release.yml 自动构建
   ```
6. **可选**：把同样的清洗应用到 Responses 路径与 OpenAI 直连路径
