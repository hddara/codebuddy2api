# codebuddy2api 长期记忆

> 账户/凭据台账（镜像仓库、PAT、ACR secrets 等）见 brv `.brv/context-tree/projects/codebuddy2api/preferences/accounts-inventory.md`，索取一次、后续免问。

## 仓库与分支

- 仓库：`hddara/codebuddy2api`（fork 自 `orangeboyChen/codebuddy2api`，`upstream` remote 指向上游）。
- 默认分支 `main`；fork 后旧 main 线已备份为 `backup/main-legacy-20260916`。
- 项目归档与上下文存 `.brv/context-tree`（独立 git 子仓库），会话归档写 `projects/codebuddy2api/sessions/`。
- **上游同步策略**：`upstream` 有新提交时用 **cherry-pick**（跳过 `chore: prepare release v*` 那个版本号提交），**不要 merge** —— merge 会把 package.json 版本拉回上游值并产生大量冲突。首次同步见每日记忆 2026-09-29。

## 发版约定（release.yml）

- 语义化版本（`1.2.x`），由 `.github/workflows/release.yml` 自动发布：合并回 `main` 的发版 PR 触发。
- 该 PR 必须满足三个条件才会被 `detect-release` 命中：`base=main`、标题以 `chore: prepare release v` 开头、head 分支以 `release/v` 开头。
- 一次发版产出：git tag `vX.Y.Z`、GitHub Release、ghcr 镜像 `X.Y.Z` + `X.Y.Z-{amd64,arm64}` + `latest`（多架构 manifest）。
- 本地无 `gh` CLI：建/合 PR 用 github MCP；查 Actions/Release/ghcr 用 `.mcp.json` 里的 PAT + curl。

## 生产镜像（对外地址统一走 nju 加速）

- **对外的镜像地址一律写成 `ghcr.nju.edu.cn/hddara/codebuddy2api:<版本号>`**（用户 2026-09-16 指定，同时写入全局记忆）：nju 站是只读加速、digest 与源站一致、可匿名拉取；**推送/登录仍走 `ghcr.io`**。
- 生产镜像固定用版本 tag（**不用 `latest`**，便于区分与回滚）；`deploy/docker-compose.yml` 与 `deploy/k8s/codebuddy2api.yaml` 已按此约定指向对应版本。
- `release.yml` 的 Release notes 通过 `env.IMAGE_MIRROR: ghcr.nju.edu.cn` + `image="${IMAGE/ghcr.io/$IMAGE_MIRROR}"` 输出 nju 地址（PR #4 合入 main）。
- 当前生产版本：`1.2.2`（2026-09-29 发布；内容 = 诊断日志增强）。
- **双推镜像（2026-09-29 起）**：`release.yml` / `docker-publish.yml` 各有独立的 `publish-acr` 作业，用 `docker buildx imagetools create` 把 ghcr 已发布的**多架构 manifest 按引用复制**到 `registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api`（不重复构建、digest 一致），并覆盖 ACR 的 `latest`。
  - 凭据来自仓库 secrets `ACR_USERNAME` / `ACR_PASSWORD`；**`secrets` 不能写在 `if` 里**，故先用一个步骤把「凭据是否存在」输出成 `steps.acr.outputs.has_credentials`，后续步骤据此 gate；无 secret 时整段跳过，且 ACR 作业不在 `release` 的 `needs` 内 → **镜像站故障不会阻塞 GitHub 发版**。
  - 对外地址仍以 `ghcr.nju.edu.cn` 为准（用户 2026-09-29 确认），ACR 只作为备用通道，在 Release 正文附一行。

## 诊断日志（1.2.2 起）

- 级别由 `CODEBUDDY_LOG_LEVEL`（设置页字段）控制，`DEBUG`/`INFO`/`WARN`/`ERROR`，未知值按 `INFO`；缓存 5s。
- 每次选号打 `Credential selected`（凭证 / user_id / 候选数 / 轮询游标 / 亲和命中）；上游失败打 `[ERROR] Upstream request failed`（含 credentialFilename、status、elapsedMs、model、stream、上游响应头、截断报文）；HTTP 200 的**流内错误**打 `[WARN] ... stream reported an error`。
- 日志实现 `lib/server/shared/log.ts` **必须直读 storage `config/runtime`**，不能 import `domain/config`（config → credentials，会与选号日志形成循环依赖）。

## 已知红灯（均非代码问题）

- `ci-main` / `ci-pr` 失败于 Codecov 上传（fork 未配 `CODECOV_TOKEN` 且 `fail_ci_if_error: true`）。`release.yml` 不涉 Codecov，发版不受影响。

## 进行中 / 待办

- **凭证限流识别与自动换号（未实施）**：方案见 brv `projects/codebuddy2api/plans/2026-09-29-rate-limit-detection.md`。现状是「候选只过滤 token 过期、上游 429 只透传、亲和把会话钉死」；4 项待拍板 + 3 项待取证（真实限流报文、限流窗口粒度、是否全体同时受限）。

## 本机开发注意

- CodeBuddy IDE 插件会注入 `NODE_OPTIONS`（node shim）与 `CODEBUDDY_SAFE_DELETE_*`、`NODE_ENV=production`，直接跑测试/构建会假失败；按净化环境口诀执行（详见每日记忆 2026-09-16）。
- 本地记忆（`.codebuddy/memory/*.md`）与 `.brv/context-tree` 子模块指针**随主仓库一起提交**（子模块无 remote，无需单独 push；先例 `88ffe09` / `78c36ef`）。
- 子模块/归档 md 改动后跑一次 `bunx prettier --write`，否则 push 会被 pre-push 钩子拦。
