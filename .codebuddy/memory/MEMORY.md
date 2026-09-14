# codebuddy2api 长期记忆

> 逐日流水见 `.codebuddy/memory/YYYY-MM-DD.md`；方案/施工单见 `.brv/context-tree/projects/codebuddy2api/plans/`。本文件只留跨会话仍有效的事实。

## 项目定位

自托管 AI 网关：把 CodeBuddy（腾讯 copilot.tencent.com）上游能力，以 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三套兼容协议对外暴露，附 Web 管理后台。是 [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api) 的重构版。

## 技术栈

Next.js 16 App Router（Route Handler 均 `runtime='nodejs'` + `force-dynamic`）、React 19、Ant Design 6、`@lobehub/ui`、jotai、next-intl、Tailwind 4、zod。存储抽象 `lib/server/storage/`（file / sqlite / pg，drizzle-orm + better-sqlite3 + pg）。加密：`CODEBUDDY_STORAGE_ENCRYPTION_KEY` → SHA-256 → AES-256-GCM。鉴权：`/v1/*` 用 access key；`/admin-api/*` 用管理员密码 + WebAuthn passkey 会话 cookie。工具链：Bun 1.3（CI 用，**本机无 bun**）、Vitest 4（覆盖率 include 仅 `lib/server/**/*.ts`，阈值 lines/functions/statements 90、branches 70）、Playwright 1.62（仅 chromium）。端口：本机 3000 被 grafana 占用，dev 必须显式 `--port`；e2e 固定 8001。

## 关键环境变量

`CODEBUDDY_STORAGE_BACKEND`(file/sqlite/pg) · `CODEBUDDY_STORAGE_ENCRYPTION_KEY`(DB 后端必填) · `CODEBUDDY_STORAGE_PG_URL`/`DATABASE_URL`(存在则默认 pg) · `CODEBUDDY_STORAGE_SQLITE_PATH` · `CODEBUDDY_STORAGE_FILE_DIR`(默认 `.codebuddy_data`) · `CODEBUDDY_CREDENTIALS_DIR` · `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES`(默认 true) · `CODEBUDDY_CONFIG_PATH`(旧版兼容) · `CODEBUDDY_USAGE_RETENTION_DAYS`(DB 35 / file 7) · `CODEBUDDY_QUOTA_ENFORCEMENT`(默认 reject，`warn` 只告警)

## 强制约定（AGENTS.md）

1. 英文 conventional commit；提交前 `lint` / `format:check` / `typecheck` / `test:coverage`(≥90%) / `build` 全绿，覆盖率 <90% 视为阻断失败。PR 还要 `test:ci` + `test:patch-branches`（changed branch ≥90%）。
2. 注释只写英文；只用箭头函数，禁止 `function` 声明；不留未使用变量（`tsc` 抓不到，改完跑 eslint）。
3. 改用户可见文案必须同步 `messages/` 全部 locale（en / zh-CN / ja）。
4. Next.js 16 与训练数据差异大，改代码前先读 `node_modules/next/dist/docs/`。

## 用户硬性要求（最高优先级）

### 不许改现有视觉样式（2026-09-10）

原话「之前项目的样式很美观，别乱改样式」，举例「顶栏的磨砂效果当前就被改没了」。

- 只允许**新增** class、**搬运**已有 class；`app/globals.scss` 既有规则（尤其 `.admin-header`/`.console-header` 的 `backdrop-filter` + 点阵背景）**原则上不动**。
- 只有「样式随所属 DOM 一起被删、已无引用」时才能删该类，且要单独列给用户看。
- 改完必须**在浏览器真实打开核对视觉**，不能只靠读代码或断言。dev 反复重启会让浏览器残留 HMR 断连页面、用户误报「样式丢了」，先硬刷新复现。
- 既有实现：`.admin-header` = `color-mix(...72%, transparent)` + `radial-gradient(transparent 1px, var(--bg-color) 1px)` + `background-size:4px 4px` + `backdrop-filter: saturate(50%) blur(4px)`；`.console-header` = `position:fixed; z-index:30`，靠调用方 `className` 透传，改 header 组件**必须保留 className 透传**。

### 不加解释性/分类性文字标签

对冗余 UI 文案零容忍：顶栏「总览/应用/观测/系统」分组标签被否决（「不是脱裤子放屁吗？除了占地方还有什么用？」）。判定：**看一眼内容就知道的信息，不需要再补一行文字说明**。默认不加分组标签/说明性副标题/图例。

### 其他偏好

- 反感「把调研过程当交付物」：要结果就给地址/命令，次要问题一句话记录或另议，别摊成长表格汇报。
- 功能完成标准：必须先实际验证（编译/构建/运行/接口/UI）才能说「已完成」。
- 报错类问题按「先定性错误类型 → 再列排查步骤」回答。

## 目录速查

`app/v1/` 对外推理 API · `app/admin-api/` 后台 API · `app/codebuddy/auth/` OAuth · `lib/server/proxy/` 协议适配 · `lib/server/domain/` 业务(access-keys/credentials/credential-models/config/usage/stats/debug/account-status/users/applications/quotas) · `lib/server/admin/` 管理端鉴权 · `lib/server/storage/` 存储抽象 + `backends/` + `migrations/{sqlite,postgres}/` · `tests/` 单测 · `e2e/` Playwright · `docs/` VitePress 文档站（en/ja/guide/config），**不是**会话归档目录

## 后台任务模式

定时/异步任务挂 `globalThis.__codebuddy2api*__` 防热重载重复初始化，由 `instrumentation.ts` 的 `register()`（`NEXT_RUNTIME==='nodejs'`）触发一次。当前唯一任务 `domain/credential-models.ts` → `refreshMissingCredentialModels()`。`domain/auto-checkin.ts` 已回滚不存在。存储层 usage/debug 走追加式事件表（file 后端回落 JSON 文档），domain 层用 `getStorageBackendMeta().backend === 'file'` 分支，不要在 storage 层直接调 `getEventBackend()`。

## 启动 / 构建 / 验证（实测，用 node + 仓库 node_modules，不需要 bun）

- dev：`CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3010` → `/health` 200
- build：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` → `.next/BUILD_ID` + `.next/standalone/server.js`
- 生产（同 Docker）：`cp -R .next/static .next/standalone/.next/static` + `cp -R public/. .next/standalone/public/`，`cd .next/standalone && NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3012 node server.js`
- 单测：`NODE_ENV=test CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/vitest run`

关键坑：

- **`next start` 不是生产入口**（`output: standalone`），standalone 不会自动拷 static/public。
- 不带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 时 `next build` 卡在清理 `.next`；卡住进程占 `.next/lock`，用 `ps ax -o pid=,command= | grep "dist/bin/next"` 找 PID kill。**`next build` 不要与运行中的 `next dev` 并发**。
- 本机 IDE 注入 `NODE_ENV=production`，跑 `tests/admin/*.test.tsx` 会报 `React.act is not a function`，**必须 `NODE_ENV=test`**。
- 本机**没有 bun**但 `.husky/pre-commit` 是 `bun run lint-staged`、playwright webServer 是 `bun run dev`：用 npm/node 等价命令；提交时 hook 会失败，需 PATH 前放 `bun run X` → `npx X` 的 shim，或先手工 `npx lint-staged`。
- 覆盖率报 `coverage/.tmp/coverage-*.json` ENOENT 是两个 vitest 进程重叠写临时目录，不是测试失败，串行跑即可。跑测试期间不要改源码。
- `brv vc init` 会把 `.brv/` 写进 `.gitignore`（工具行为）；本仓库 `.brv/context-tree` 以 gitlink（submodule, mode 160000）被主仓跟踪，提交前先在内层仓库 commit 再更新主仓指针。

### e2e 上下文

`playwright.config.ts`：baseURL `http://127.0.0.1:8001`，webServer = `bun run dev -- --hostname 127.0.0.1 --port 8001`（依赖 PATH 有 bun），`reuseExistingServer: false`，探针 `/health`；注入 `CODEBUDDY_API_ENDPOINT=http://127.0.0.1:65535`（故意不可达的假上游）+ 隔离目录 `.tmp-e2e/<pid>/`，全离线。

UI 模式：`NODE_ENV=development CODEBUDDY_SAFE_DELETE_ENABLED=0 nohup script -q /tmp/pw-ui.log ./node_modules/.bin/playwright test --ui --ui-port=8080 &`，然后 `open http://127.0.0.1:8080`。

`scripts/mock-upstream.mjs` 是零引用的手动辅助脚本（假上游，默认 `127.0.0.1:3100`，实现 `/v2/chat/completions` 与 `/v1/responses`）。

## 坑：storage 的 namespace 是「双白名单」制

- `getDocumentPath(namespace, key)` 对 file 后端硬编码允许的组合，未注册直接抛 `Unsupported storage document`（可能被任务自身 try/catch 吞成 warn，表现为「功能静默失效」）。
- 目录型 namespace（一 key 一个 `<key>.json`，可枚举）另有 `getNamespaceDirectory()` 表，已注册 `applications`/`quotas`/`users`/`user-sessions`；只有这里能 `listStorageJson`。
- `DatabaseStorageBackend.putJson` 有加密白名单（`applications`/`credentials`/`responses`/`users`/`user-sessions`/`access-keys:store`），新敏感 namespace 必须加进去。
- 必须 fail closed 的地方用 `listStorageJsonResult()`（返回 `{documents,error}`），不要用静默跳过不可读文档的 `listStorageJson`，否则「读不出来 = 无密钥 = 免鉴权」。
- 目录型 namespace 文档必须过形态校验（`parseApplicationRecord`/`isUserRecord`），否则被判非法记录并上报错误。
- 新增 namespace 必须在 `tests/server/*storage*.test.ts` 补真实 file 后端读写往返测试（mock 掉 storage 测不出白名单类缺陷）。

## 当前进度：改造方案「会话日志 / 用户体系 / 布局优化」

方案/施工单：`.brv/context-tree/projects/codebuddy2api/plans/2026-09-10-sessions-users-layout.md`。

- **阶段 1 已完成**：6/6 tab controller 迁出，`page-shell.tsx` 2075 → 307 行；右上角用户区、导航扁平 7 项。
- **阶段 2 已完成 2.1~2.5**：存储地基（`users`/`user-sessions` + 加密白名单）→ 用户域 → RBAC + 会话归属（`admin/{password,rbac}.ts`）→ applications 迁移（`applications.ts` + `access-keys.ts` 退化为兼容层）→ 余额强制点（`quotas.ts` + proxy/auth 三入口 429）。
- **未完成**：2.6 `/me/*`、`/admin-api/users/*`、`/admin-api/quotas` 接口 → 2.7 前端页面 → 阶段 3 会话日志（仅 DB 后端，file 后端降级 + UI 提示）。
- ⚠️ 本工作区出现过**并行第二个 agent**（2026-09-11 的 2.5 大部分是它写的）：动手前先 `git status` + 看文件 mtime，发现并行产出先审计缺口再补，不要重写别人的实现。
- 实现决定：用户/应用/配额**不建 SQL 表**，复用既有 `documents` namespace（同 `admin-auth`/`credentials`）。
- 余额语义：配额 − 已用量；UTC 窗口；user 维度按 `ApplicationRecord.ownerUserId` 反查；缓存 10 秒；file 后端保留期 7 天 → `degraded: true`；配额故障 **fail open**（资源约束非鉴权边界），applications 存储不可读 **fail closed**（503）。
- 已锁定决策：会话日志默认开启 / 30 天 / 加密 / 可一键清空；存归一化 messages + 上游真实请求；余额同时计调用次数与 Token（cache token 计入 total 并单列，周期=月）；超额直接拒绝（OpenAI 429/402、Anthropic `rate_limit_error`）并保留「仅告警」开关；member 可查看自己应用 secret 明文；会话日志与余额仅支持 DB 后端。

## Git 远端、hook 与工具链（2026-09-14 修复后）

- `origin` = `git@github.com:hddara/codebuddy2api.git`（SSH，非 HTTPS）。`~/.gitconfig` 有 `url.https://githubfast.com.insteadof=https://github.com`，只对 HTTPS URL 生效，**不影响 SSH 远端**。
- **bun 已装**：`npm i -g bun` → `/usr/local/bin/bun`（1.4.2）。必须装在这个位置 —— husky hook 打印的 PATH 里**没有** `~/.bun/bin`，装那里 hook 依然找不到。pre-commit = `bun run lint-staged`，pre-push = `bun run lint|format:check|typecheck`。
- **系统里有第二个老 git**：`/usr/local/bin/git -> ../git/bin/git`（Git for Mac **2.15.0**，`sizeof-long: 8` 是其特征）。shell 里首选 Xcode 的 2.50.1，但 lint-staged 经 execa 起子进程时 `/usr/local/bin` 会被提前 → 命中 2.15.0 → `lint-staged requires at least Git version 2.32.0`。已 `ln -sfn /opt/homebrew/bin/git /usr/local/bin/git`（→2.49.0），还原命令 `ln -sfn ../git/bin/git /usr/local/bin/git`。GUI 启动的 IDE 走 `/etc/paths`（首行 `/usr/local/bin`），同样会首选它。
- 「拉不了也推不了」的常见组合：`.git/MERGE_HEAD` 残留（冲突已解决但没 `git commit`）→ `git pull` 被硬拒；hook 缺 bun/git 版本不够 → push 被 hook 拒；merge 未落地 → 绕过 hook 也因 non-fast-forward 被远端拒。排查顺序：`git pull --dry-run`、`git push --dry-run`、`git push --dry-run --no-verify`、`ls .git/ | grep -E 'MERGE|rebase|lock'`。
