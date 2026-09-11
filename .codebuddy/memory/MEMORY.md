# codebuddy2api 长期记忆

> 逐日流水见 `.codebuddy/memory/YYYY-MM-DD.md`；方案/施工单见 `.brv/context-tree/projects/codebuddy2api/plans/`。本文件只留跨会话仍然有效的事实。

## 项目定位

自托管 AI 网关：把 CodeBuddy（腾讯 copilot.tencent.com）上游能力，以 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三套兼容协议对外暴露，附带 Web 管理后台。是 [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api) 的重构版。

## 技术栈速查

- Next.js 16 App Router（Route Handler 均 `runtime='nodejs'` + `force-dynamic`）、React 19、Ant Design 6、`@lobehub/ui`、jotai、next-intl、Tailwind 4、zod
- 存储：自研抽象 `lib/server/storage/index.ts`，后端 file / sqlite / pg（drizzle-orm + better-sqlite3 + pg）
- 加密：`CODEBUDDY_STORAGE_ENCRYPTION_KEY` → SHA-256 → AES-256-GCM（iv12 + tag16 + ciphertext，base64）
- 鉴权：`/v1/*` 用 access key（`Authorization: Bearer` 或 `x-api-key`）；`/admin-api/*` 用管理员密码 + WebAuthn passkey 会话 cookie
- 工具链：Bun 1.3.14（CI `BUN_VERSION` + `bun install --frozen-lockfile`；**本机无 bun**）、Vitest 4.1.11（覆盖率 include 仅 `lib/server/**/*.ts`，阈值 lines/functions/statements 90、branches 70）、Playwright 1.62.1（仅 chromium）
- 端口：本机 3000 被 grafana 占用，dev 必须显式 `--port`；e2e webServer 固定 8001

## 关键环境变量

`CODEBUDDY_STORAGE_BACKEND`(file/sqlite/pg) · `CODEBUDDY_STORAGE_ENCRYPTION_KEY`(DB 后端必填) · `CODEBUDDY_STORAGE_PG_URL`/`DATABASE_URL`(存在则默认 pg) · `CODEBUDDY_STORAGE_SQLITE_PATH` · `CODEBUDDY_STORAGE_FILE_DIR`(默认 `.codebuddy_data`) · `CODEBUDDY_CREDENTIALS_DIR`(默认 `.codebuddy_creds`) · `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES`(默认 true) · `CODEBUDDY_CONFIG_PATH`(旧版兼容) · `CODEBUDDY_USAGE_RETENTION_DAYS`(默认 DB 35 / file 7) · `CODEBUDDY_QUOTA_ENFORCEMENT`(默认 reject，`warn` 只告警)

## 项目约定（AGENTS.md，必须遵守）

1. 提交信息用英文 conventional commit；提交前 `lint` / `format:check` / `typecheck` / `test:coverage`(≥90%) / `build` 必须全绿，覆盖率低于 90% 视为阻断失败。
2. 注释只写英文；只用箭头函数，禁止 `function` 声明；不留未使用变量（`tsc` 抓不到「定义了但没用」，改完要跑 eslint）。
3. 改用户可见文案必须同步 `messages/` 全部 locale（en / zh-CN / ja）。
4. PR 阶段还要跑 `test:ci` + `test:patch-branches`，changed branch coverage ≥90%。
5. Next.js 16 与训练数据差异大，改代码前先读 `node_modules/next/dist/docs/`。

## 用户明确要求（最高优先级）

### 不许改现有视觉样式（2026-09-10）

用户原话：「之前项目的样式很美观，别乱改样式」，举例「顶栏的磨砂效果当前就被改没了」。

- 只允许**新增** class、**搬运**已有 class；`app/globals.scss` 既有规则（尤其 `.admin-header` / `.console-header` 的 `backdrop-filter` + 点阵背景）**原则上不动**，`#debug` / `#settings` / `#credentials` 布局同理。
- 只有「样式随所属 DOM 一起被删、已无引用」时才能删该类，且要单独列给用户看。
- 改动完必须**在浏览器里真实打开核对视觉**，不能只靠读代码或跑断言。dev 反复重启会让浏览器残留 HMR 断连页面、用户误报「样式丢了」，先硬刷新复现。
- 既有实现：`.admin-header` = `color-mix(...72%, transparent)` + `radial-gradient(transparent 1px, var(--bg-color) 1px)` + `background-size:4px 4px` + `backdrop-filter: saturate(50%) blur(4px)`；`.console-header` = `position:fixed; z-index:30`，靠调用方 `className` 透传（page-shell 传 `.console-header`，登录页传 `.login-header`），改 header 组件**必须保留 className 透传**。

### 不要加解释性/分类性的文字标签

用户对冗余 UI 文案零容忍。2026-09-10 顶栏加「总览 / 应用 / 观测 / 系统」分组标签被否决：「不是脱裤子放屁吗？除了占地方还有什么用？」判定标准：**看一眼内容就知道的信息，不需要再补一行文字说明**。写 UI 时默认**不加**分组标签/说明性副标题/图例。

### 其他偏好

- 反感「把调研过程当交付物」：要结果就直接给地址/命令，次要问题一句话记录或另议，别摊成表格长篇汇报。
- 功能完成标准：必须先实际验证（编译/构建/运行/接口/UI），确认无明显错误才能说「已完成」。
- 报错类问题按「先定性错误类型 → 再列排查步骤」回答。

## 目录速查

`app/v1/` 对外推理 API · `app/admin-api/` 后台 API · `app/codebuddy/auth/` OAuth(start/poll/callback) · `lib/server/proxy/` 协议适配(codebuddy/anthropic/responses/auth) · `lib/server/domain/` 业务(access-keys/credentials/credential-models/config/usage/stats/debug/account-status/users/applications/quotas) · `lib/server/admin/` 管理端鉴权(session.ts / rbac.ts / password.ts) · `lib/server/storage/` 存储抽象 + `backends/` + `migrations/{sqlite,postgres}/` · `tests/` 单测 · `e2e/` Playwright · `docs/` VitePress 文档站（en/ja/guide/config），**不是**会话归档目录

## 后台任务的既有模式

定时/异步任务挂在 `globalThis.__codebuddy2api*__` 上防热重载重复初始化，由 `instrumentation.ts` 的 `register()` 在 `NEXT_RUNTIME==='nodejs'` 时触发一次。当前唯一任务：`lib/server/domain/credential-models.ts` → `refreshMissingCredentialModels()`。`domain/auto-checkin.ts` 已按用户要求回滚、文件不存在，重做需先对齐方案。

存储层 usage/debug 走追加式事件表（file 后端回落 JSON 文档），domain 层用 `getStorageBackendMeta().backend === 'file'` 分支，不要在 storage 层直接调用 `getEventBackend()`。

## 启动 / 构建 / 验证（实测命令，用 node + 仓库 node_modules 即可，不需要 bun）

- 开发：`CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3010` → `/health` 200
- 构建：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` → 产出 `.next/BUILD_ID` + `.next/standalone/server.js`
- 生产（与 Docker 一致）：`cp -R .next/static .next/standalone/.next/static` + `cp -R public/. .next/standalone/public/`，再 `cd .next/standalone && NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3012 node server.js` → 全 200
- 单测：`NODE_ENV=test CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/vitest run`

关键坑：

- **`next start` 不是生产入口**（`output: standalone`），Docker runner 只拷 `.next/standalone` + `.next/static` + `public`，且 standalone **不会**自动拷 static/public（Dockerfile 用 COPY，本地用 cp）。
- 不带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 时 `next build` 卡死在开头清理 `.next`（IDE node-safe-delete shim 的 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`）；卡住的进程占着 `.next/lock`（native flock），再跑报 `Another next build process is already running.`，用 `ps ax -o pid=,command= | grep "dist/bin/next"` 找 PID kill 即可，无需手工删 lock。**`next build` 不要与运行中的 `next dev` 并发**。
- 本机 IDE 注入 `NODE_ENV=production`，跑组件测试（`tests/admin/*.test.tsx`）会报 `React.act is not a function`，**必须 `NODE_ENV=test`**。
- 本机**没有 bun**（`which bun` 为空、`~/.bun/bin/bun` 不存在），但 `.husky/pre-commit` 是 `bun run lint-staged`、`playwright.config.ts` 的 webServer 是 `bun run dev`：跑脚本用 npm/node 等价命令；提交时 hook 会因找不到 bun 失败，需在 PATH 前放一个把 `bun run X` 转 `npx X` 的 shim，或先手工 `npx lint-staged`。
- 覆盖率步骤报 `coverage/.tmp/coverage-*.json` ENOENT 是**两个 vitest 进程重叠**写临时目录导致，不是测试失败，串行跑即可。
- 跑测试期间不要改源码（vitest 边跑边加载模块，结果不可信）。
- `brv vc init` 会把 `.brv/` 追加进 `.gitignore` 是工具行为；本仓库 `.brv/context-tree` 实际以 gitlink（submodule, mode 160000）被主仓跟踪，提交前要先在内层仓库 commit 再更新主仓指针。

### e2e 上下文

`playwright.config.ts`：baseURL `http://127.0.0.1:8001`，webServer = `bun run dev -- --hostname 127.0.0.1 --port 8001`（依赖 PATH 里有 bun），`reuseExistingServer: false`，就绪探针 `/health`；注入 `CODEBUDDY_API_ENDPOINT=http://127.0.0.1:65535`（故意不可达的假上游）+ 隔离目录 `.tmp-e2e/<pid>/`，全离线、不碰真实数据。

UI 模式：`NODE_ENV=development CODEBUDDY_SAFE_DELETE_ENABLED=0 nohup script -q /tmp/pw-ui.log ./node_modules/.bin/playwright test --ui --ui-port=8080 &`，然后 `open http://127.0.0.1:8080`。

`scripts/mock-upstream.mjs` 是零引用的手动辅助脚本（假上游，默认 `127.0.0.1:3100`，实现 `/v2/chat/completions` 与 `/v1/responses`）。

## 坑：storage 的 namespace 是「双白名单」制

- `getDocumentPath(namespace, key)` 对 file 后端**硬编码允许的组合**，未注册直接抛 `Unsupported storage document`（异常可能被任务自身 try/catch 吞成一条 warn，表现为「功能静默失效」）。
- 目录型 namespace（一 key 一个 `<key>.json`，可枚举）另有 `getNamespaceDirectory()` 表，已注册 `applications` / `quotas` / `users` / `user-sessions`；只有这里能 `listStorageJson`。
- `DatabaseStorageBackend.putJson` 有加密白名单（`applications` / `credentials` / `responses` / `users` / `user-sessions` / `access-keys:store`），新敏感 namespace 必须加进去。
- 鉴权这类必须 fail closed 的地方要用 `listStorageJsonResult()`（返回 `{documents,error}`），不要用静默跳过不可读文档的 `listStorageJson`，否则「读不出来 = 无密钥 = 免鉴权」。
- 目录型 namespace 的文档必须过形态校验（`parseApplicationRecord` / `isUserRecord`），否则被判「非法记录」并上报错误。
- 新增 namespace 必须在 `tests/server/*storage*.test.ts` 补真实 file 后端读写往返测试——mock 掉 `@/lib/server/storage` 测不出白名单类缺陷。

## 当前进度：改造方案「会话日志 / 用户体系 / 布局优化」

方案/施工单：`.brv/context-tree/projects/codebuddy2api/plans/2026-09-10-sessions-users-layout.md`。

- **阶段 1 已完成**：6/6 tab controller 迁出，`page-shell.tsx` 2075 → 307 行；右上角用户区、导航扁平 7 项。
- **阶段 2 已完成 2.1~2.5**：存储地基（`users`/`user-sessions` + 加密白名单）→ 用户域 → RBAC + 会话归属（`admin/{password,rbac}.ts`）→ applications 迁移（`applications.ts` + `access-keys.ts` 退化为兼容层）→ 余额强制点（`quotas.ts` + proxy/auth 三个入口 429 拦截）。
- **未完成**：2.6 `/me/*` 与 `/admin-api/users/*`、`/admin-api/quotas` 接口 → 2.7 前端页面 → 阶段 3 会话日志（仅 DB 后端，file 后端降级并 UI 提示）。
- ⚠️ 本工作区出现过**并行的第二个 agent**（2026-09-11 的 2.5 大部分是它写的）：动手前先 `git status` + 看文件 mtime，发现并行产出时先审计缺口再补，不要重写别人的实现。
- 实现决定：用户/应用/配额**不建 SQL 表**，改用既有 `documents` namespace（与 `admin-auth`/`credentials`/`access-keys` 一致，低基数，省两份 schema + migration）。
- 余额语义：配额 − 已用量；UTC 窗口；user 维度按 `ApplicationRecord.ownerUserId` 反查；缓存 10 秒（最多超发 10 秒）；file 后端保留期 7 天 → `degraded: true`；配额故障 **fail open**（资源约束非鉴权边界），applications 存储不可读 **fail closed**（503）。
- 已锁定决策：会话日志默认开启 / 30 天 / 加密 / 可一键清空；上下文数据存归一化 messages + 上游真实请求；余额同时计调用次数与 Token（cache token 计入 total 并单列，周期=月）；超额直接拒绝（OpenAI 429/402、Anthropic `rate_limit_error`）并保留「仅告警」开关；member 可查看自己应用 secret 明文；会话日志与余额仅支持 DB 后端。
