---
name: production-incident-triage
description: codebuddy2api 生产故障排查手册。当出现服务 500/无法访问、解密失败、镜像更新后异常、上游限流等问题时使用。包含这个项目特有的故障模式、取证命令链与已验证的处置路径。
---

# codebuddy2api 生产故障排查

## 适用场景

- 生产站点返回 500 / 页面打不开 / dashboard 报 "This page couldn't load"
- 更新镜像后服务异常
- 上游请求失败、疑似限流/额度耗尽
- 日志里出现 `Unsupported state or unable to authenticate data`

## 第一步：永远先取证，不要先改代码

### 1. 拉生产日志（Grafana MCP，只读）

```
datasourceUid: afzpeeod8d6v4a          # loki
{swarm_stack="codebuddy2api"}          # 唯一需要记的流选择器
```

两个 service：`codebuddy2api_app`（业务）、`codebuddy2api_codebuddy2api`（历史遗留）。

```logql
# 按错误关键字过滤
{swarm_stack="codebuddy2api"} |~ "(?i)(error|fail|exception|429|limit|unsupported)"

# 精确时间窗取证（比相对时间可靠）
startRfc3339="2026-09-29T09:56:40Z", endRfc3339="2026-09-29T09:58:10Z"
```

日志级别由 `CODEBUDDY_LOG_LEVEL` 控制（默认 INFO）。要看选号细节用 INFO，看每次成功请求用 DEBUG。

### 2. 看服务与任务状态（docker-swarm MCP）

CodeBuddy 原生 MCP 通道里这个 server 常不注册，直接对 endpoint 发 JSON-RPC：

```bash
URL=$(python3 -c "import json;print(json.load(open('.mcp.json'))['mcpServers']['docker-swarm']['url'])")
RAW=$(python3 -c "import json;print(json.load(open('.mcp.json'))['mcpServers']['docker-swarm']['headers']['Authorization'])")

curl -sS -X POST "$URL" -H "Authorization: $RAW" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks","arguments":{"service":"codebuddy2api_app","all":true}}}'
```

> ⚠️ `Authorization` 的值**可能已带 `Bearer ` 前缀**（长度会是 53 而不是 47）。先 `echo ${#RAW}` 判断，**不要盲目再拼一次 `Bearer`**，否则报 `Invalid API key`。写操作（`update_service`）必须带 `"confirm":true`。

## 故障模式 A：解密失败导致全站 500

### 症状

```
⨯ Error: Unsupported state or unable to authenticate data
  digest: '2307530794'          ← Next.js RSC 渲染未捕获错误
[CodeBuddy2API] Unable to refresh missing credential models Error: Unsupported state ...
[CodeBuddy2API][ERROR] Upstream request failed { route: "/v1/chat/completions", ... }
```

API、dashboard、后台全挂；**重启无效**（启动后 1 秒就报）。

### 根因：加密代际不兼容（**不是密钥被改**）

`documents` 表的 `encryption_mode` 列记录每条数据的加密代际：

| mode             | 密钥派生                                              | 出现在哪个版本                 |
| ---------------- | ----------------------------------------------------- | ------------------------------ |
| `plain-json`     | 无（明文 JSON）                                       | 全版本                         |
| `aes-256-gcm`    | `sha256(passphrase)` 无盐                             | 早期版本                       |
| `aes-256-gcm:v2` | `scryptSync(passphrase, salt, 32, {N:16384,r:8,p:1})` | 上游 `3b1d39b`（2026-09-23）起 |

**关键**：v2 与 legacy 的密文布局**完全相同**（`iv(12)|tag(16)|ct`），只有密钥派生不同。老版本遇到 `aes-256-gcm:v2` 会**掉进 legacy 分支**，用 sha256 去解 scrypt 密文 → GCM 认证失败 → 报误导性的 `Unsupported state`。

### 一句话判据

**在同一份数据上交替部署"上游镜像"和"fork 镜像"，会单向升级数据格式。**

已发生实例（2026-09-29）：换上游最新镜像后它把数据写成 v2，再切回 fork 1.2.2 → 全站 500。**回退代码没用，只会更读不懂**。

### 取证命令（一条定生死）

```bash
PG=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)
docker exec "$PG" psql -U codebuddy -d codebuddy -c \
  "select namespace, document_key, encryption_mode, updated_at
     from codebuddy2api.documents order by updated_at desc limit 20;"
```

看有没有 `aes-256-gcm:v2`，以及它的写入时间是否与"换镜像"的时间吻合。

### 处置

| 方案       | 做法                                              | 适用                 |
| ---------- | ------------------------------------------------- | -------------------- |
| **推荐**   | 合上游 v2 支持进 fork，发新版本（v1.2.3 已做）    | 长期                 |
| 回滚镜像   | 换回那个会写 v2 的镜像                            | 临时                 |
| 数据降级   | 把 v2 文档转回 legacy                             | 确定不再跑旧版时才做 |
| 删 v2 文档 | 删掉 v2 行 + 重启，从 `.codebuddy_creds` 重新导入 | 兜底，会丢数据       |

**永久约束**：schema 里一旦有 v2 文档，**只能向前滚**，再部署 v1.2.2 或更早会原样复发。

## 故障模式 B：镜像更新造成服务空档

### 症状

更新后访问失败一段时间，但服务最终恢复正常、日志无 error。

### 根因

`replicas=1` + **固定 host 端口 8001** + Swarm 默认 **`stop-first`** 滚动策略：

```
旧任务停止 07:13:06  →  新任务启动 07:14:52     空档 1 分 46 秒
```

（拉取镜像的时间也落在空档里）

单副本 + host 端口下，**`start-first` 也救不了** —— 新旧任务会抢同一个 8001。

### 判据

`docker service inspect` 看 `TaskTemplate` 的端口发布方式：有 `PublishMode: host`（或固定端口映射）就是这个模式。

### 处置

- 更新前先在节点**预热镜像**：`docker pull ghcr.nju.edu.cn/hddara/codebuddy2api:<TAG>`
- 要真正零停机，必须改架构（副本 ≥2 + overlay 网络 + 反向代理分流），属独立评审项

### ⚠️ 发布流程的硬性要求

**`update_service` 之后必须轮询到 `updateState: completed` 且任务 `state: running` 才能收尾**，并立刻实测端点。中途被打断就以为完成，会把整段停机窗口漏报给用户。

## 故障模式 C：上游限流 / 额度耗尽

### 当前能力边界（诚实评估，别答错）

| 能力               | 状态                                                            |
| ------------------ | --------------------------------------------------------------- |
| 拿到额度数据       | ✅ `account-status.ts` 调 `/v2/billing/meter/get-user-resource` |
| **额度不足的识别** | ❌ 无（候选过滤只看 token 过期 + access key 范围）              |
| **自动切换账户**   | ❌ 无（纯 round-robin，上游非 2xx 只透传不换号）                |
| 会话亲和           | ⚠️ 会把同一 `x-conversation-id` 钉在已限流凭证上（TTL 24h）     |

### 额度语义（2026-09-30 从原始报文实证，别再猜）

**不存在"每日积分限制"** —— 额度是**按「周期包」**发放，一个账户同时挂多个包：

| 包名                          | 周期                                          | 周期额度        | 字段                           |
| ----------------------------- | --------------------------------------------- | --------------- | ------------------------------ |
| CodeBuddy个人体验版（免费）   | **2026-09-01 00:00:00 → 2026-09-30 23:59:59** | **500 credits** | `CycleCapacitySize`            |
| CodeBuddy个人版国内运营裂变包 | 按开通日起 30 天                              | 1500            | 同上                           |
| Buddy AI个人高级版            | 每期 1 个月，共 12 期                         | 4000/期         | `TotalCycles` / `RemainCycles` |

判读要点：

- **免费账户 = 500 credits / 自然月**，不是每天
- `TotalDosage` 是所有包（**含已失效包**）剩余量的**加总**，直接用会误导
- `Status: 3` 表示该包已失效，必须排除
- `CycleStartTime` / `CycleEndTime` 是**每个包各自**的周期，不能取第一个当全局

## 排查纪律（本项目血泪教训）

1. **先取证再下结论**。本项目的故障曾连续 4 轮被误判为"密钥被改"，真实原因是加密代际。判据来自数据本身（`encryption_mode` 列），不来自猜测。
2. **不要在没确认的情况下收尾**。`update_service` 是异步的，必须等 `completed`。
3. **用户说"没改过某个配置"时，先信、再找别的解释**，不要反复把矛头指向同一个变量。
4. **改代码前先分清"配置问题 / 数据问题 / 代码问题"**——本次三轮都错在把数据问题当配置问题。

## 相关文档

- 完整故障记录：`.brv/context-tree/projects/codebuddy2api/plans/2026-09-29-production-500-decrypt-failure.md`
- 限流识别方案（待实施）：`.brv/context-tree/projects/codebuddy2api/plans/2026-09-29-rate-limit-detection.md`
