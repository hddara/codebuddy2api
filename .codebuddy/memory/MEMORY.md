# codebuddy2api 长期记忆

## 仓库与分支

- 仓库：`hddara/codebuddy2api`（fork 自 `orangeboyChen/codebuddy2api`，`upstream` remote 指向上游）。
- 默认分支 `main`；fork 后旧 main 线已备份为 `backup/main-legacy-20260916`。
- 项目归档与上下文存 `.brv/context-tree`（独立 git 子仓库），会话归档写 `projects/codebuddy2api/sessions/`。

## 发版约定（release.yml）

- 语义化版本（`1.2.x`），由 `.github/workflows/release.yml` 自动发布：合并回 `main` 的发版 PR 触发。
- 该 PR 必须满足三个条件才会被 `detect-release` 命中：`base=main`、标题以 `chore: prepare release v` 开头、head 分支以 `release/v` 开头。
- 一次发版产出：git tag `vX.Y.Z`、GitHub Release、ghcr 镜像 `X.Y.Z` + `X.Y.Z-{amd64,arm64}` + `latest`（多架构 manifest）。
- 本地无 `gh` CLI：建/合 PR 用 github MCP；查 Actions/Release/ghcr 用 `.mcp.json` 里的 PAT + curl。

## 生产镜像（对外地址统一走 nju 加速）

- **对外的镜像地址一律写成 `ghcr.nju.edu.cn/hddara/codebuddy2api:<版本号>`**（用户 2026-09-16 指定，同时写入全局记忆）：nju 站是只读加速、digest 与源站一致、可匿名拉取；**推送/登录仍走 `ghcr.io`**。
- 生产镜像固定用版本 tag（**不用 `latest`**，便于区分与回滚）；`deploy/docker-compose.yml` 与 `deploy/k8s/codebuddy2api.yaml` 已按此约定指向对应版本。
- `release.yml` 的 Release notes 通过 `env.IMAGE_MIRROR: ghcr.nju.edu.cn` + `image="${IMAGE/ghcr.io/$IMAGE_MIRROR}"` 输出 nju 地址（PR #4 合入 main）。
- 当前生产版本：`1.2.1`（2026-09-16 发布；Release notes 已就地改为 nju 地址）。

## 已知红灯（均非代码问题）

- `ci-main` / `ci-pr` 失败于 Codecov 上传（fork 未配 `CODECOV_TOKEN` 且 `fail_ci_if_error: true`）。`release.yml` 不涉 Codecov，发版不受影响。

## 本机开发注意

- CodeBuddy IDE 插件会注入 `NODE_OPTIONS`（node shim）与 `CODEBUDDY_SAFE_DELETE_*`、`NODE_ENV=production`，直接跑测试/构建会假失败；按净化环境口诀执行（详见每日记忆 2026-09-16）。
- 子模块/归档 md 改动后跑一次 `bunx prettier --write`，否则 push 会被 pre-push 钩子拦。
