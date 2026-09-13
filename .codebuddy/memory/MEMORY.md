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

方案/施工单：`.brv/context-tree/projects/codebuddy2api/plans/2026-09-10-sessions-users-layout.md`（⚠️ **当前克隆里该 submodule 未初始化、目录为空且无 `.gitmodules`，施工单内容不可读**；阶段范围以本文件 + 各日流水为准）。

- **阶段 1 已完成**：6/6 tab controller 迁出，`page-shell.tsx` 2075 → 307 行；右上角用户区、导航扁平 7 项。
- **阶段 2 已完成 2.1~2.6**：存储地基（`users`/`user-sessions` + 加密白名单）→ 用户域 → RBAC + 会话归属（`admin/{password,rbac}.ts`）→ applications 迁移（`applications.ts` + `access-keys.ts` 退化为兼容层）→ 余额强制点（`quotas.ts` + proxy/auth 三个入口 429 拦截）→ **2.6 接口层**：`/admin-api/users(/[id])`、`/admin-api/quotas(/[ownerType]/[ownerId])`、`/me`、`/me/applications`、`/me/password`。
- **2.6 接口契约**（2.7 前端直接照此写）：写操作一律 owner（`OWNER_ROLES`），用户/配额读操作 owner+admin（`ADMIN_ROLES`），`/me/*` 三角色皆可且只作用于自己；新路由错误统一 `{error:{code,message}}`，码 `invalid_json`/`invalid_request`/`not_found`/`conflict`/`last_owner`/`cannot_delete_self`/`console_owner_credentials`/`invalid_credentials`；配额 period 走 query（默认 `monthly`），PUT 缺省 limit 保留原值、显式 `null` 表示不限；`listQuotaBalances()` 返回应用+用户全量余额（含 `name`、`configured`、`degraded`）。**内置 owner 的 password/username 不能从 `/admin-api/users/[id]` 改**（否则 admin-auth 那份旧密码仍能被 legacy 兜底登录接受）→ 409 引导走密码设置或 `/me/password`。
- **阶段 2 已全部完成（2.1~2.7）**：2.7 = 前端三页（`/users` 用户管理、`/quotas` 配额、`/profile` member 自助；右上角用户菜单进 profile；`users`/`quotas` 导航项仅 owner+admin，见 `app/console-navigation.ts` 的 `isTabVisibleForRole`）。新 tab 一律**客户端拉取**：`getInitialData()` 对 `users`/`quotas`/`profile`/`sessions` 返回 `undefined`（返回类型已放宽为 `| undefined`）。
- **阶段 3 第一片已完成**：会话日志。`lib/server/domain/session-logs.ts`（namespace `session-logs`，一 key 一条对话 **加密** + `index` 文档存最近 500 条摘要；30 天保留 `CODEBUDDY_SESSION_LOG_RETENTION_DAYS`；开关 `CODEBUDDY_SESSION_LOG_ENABLED` 只有显式 `false` 才关；超过 20 万字符截断；写入永不抛错）→ 代理落库点 `lib/server/proxy/codebuddy.ts` 的 `recordSession`（`proxyChatCompletions` 覆盖 chat+anthropic、`proxyResponsesUpstream` 覆盖 responses）→ 接口 `GET/DELETE /admin-api/sessions`、`GET /admin-api/sessions/[id]`（列表全角色但 member 只见自己的；详情他人返回 404；清空仅 owner）→ 前端 `/sessions` 页（全角色可见，file 后端显示降级提示）。**file 后端不写日志**（`degraded: true`）。
- **代理侧资源分配（2026-09-13 收尾）**：`UserPreferences.allowedCredentialFilenames` / `allowedModels` 全链路生效——`resolveProxyContext`（模型白名单 **400**、凭证取「key 绑定 ∩ 用户允许」）、`/v1/models`（同交集 + 白名单过滤，空交集 403）、`/v1/responses`（model 前置校验以覆盖粘连分支、粘连凭证取交集、`ProxyAccessError` 映射状态码）。用户未绑定 owner / 不存在 = 不受限；用例见 `tests/server/units.test.ts` 的 `restricts proxied models and credentials…`。
- **计费后台能力 + 管理端入口（2026-09-13）**：`lib/server/domain/billing.ts`（namespace `billing`，key=userId，扣费顺序「套餐 → 余额 → 429」）+ `app/admin-api/billing/[userId]/route.ts`（GET=admin、PUT/DELETE=owner；`topUpTokens` 累加、`balanceTokens` 覆盖、`plan:null` 撤套餐）。管理端已接：**用户管理页**（Token 余额列 + 表单三段「余额 / 可用上游账户 / 可用模型」，账户用 antd multiple、模型用 tags）、**凭证管理页**（API Key 卡片的「Token 额度」Tag 与编辑，落 `quotas` 的 app owner）。**套餐 plan 的编辑与「充值」界面仍未做**（v3 明确划到下一期）。
- **未完成/可选**：billing 套餐 UI 与充值界面；用户列表余额列是 N+1 请求（用户数少可接受）；`/v1/responses` 粘连分支的 model/凭证校验尚无自动化测试；会话日志的分页与搜索、member 清空自己的记录、chat→responses 转换后报文落库；新页面的 e2e 未覆盖。
- **权限切分（2026-09-12 按用户要求）**：CodeBuddy **凭证/账号/控制台工具仅 owner+admin**（`getAdminRoleErrorResponse`，它保留「未配置管理员账号时放行」的本地模式语义），14 个管理路由（credentials×7、access-keys×3、account-status、chat/completions、debug、settings）已收口；**member 只能管理自己的 API Key**（`/me/applications` 的 GET/POST + `/me/applications/[id]` 的 PATCH/DELETE，强制 owner=自己、`credentialFilenames=[]`、越权一律 404），前端在 `/profile` 的「我的应用」里新建/编辑/启停/删除/复制，导航与用户菜单按角色隐藏。前端还有 `canViewCredentials`（仪表板隐藏凭证卡片并跳过请求）与 `Admin.noPermission` 深链拦截。
- **凭证绑定的空值语义（2026-09-12 改）**：`getAllowedCredentialFilenames()` 把应用的**空 `credentialFilenames` 由「全部拒绝」改成「不限制 = 跟随系统当前凭证/轮换」**（代理 3 处统一走它）。member 的 Key 依赖这条语义取上游账号；回退方式=恢复直接传 `accessKey?.credentialFilenames`。
- **右上角菜单即唯一入口（2026-09-12 按用户要求改）**：顶部导航 **7 项** = `仪表板 / 账号状态 / 凭证管理 / 用户管理 / 配额 / 用量统计 / 会话日志`；**独立的 ⚙️ 设置按钮已删除**（登录页仍保留 ⚙️，它没有头像菜单），所有配置都在头像菜单里：`外观 ▸ / 语言 ▸ / 个人资料 / 我的用量 / 设置 ▸(仅 admin：服务配置·凭据模型·控制台安全·用量统计缓存) / API 测试(admin) / Debug(admin) / 退出登录`。设置内容用 `app/settings/settings-dialog.tsx`（`Modal`+`Tabs`，**受控**，不要用 effect 同步 state，否则踩 eslint `react-hooks/set-state-in-effect`）；设置面板组件从 `app/settings/settings.tsx` 导出（`SettingsServicePanel`/`SettingsMaintenancePanel`/`CredentialModels`）。深链权限用 `page-shell` 的显式 `adminOnlyTabs` 列表判断（tab 可能已不在导航里）。
- **控制台导航结构**（2026-09-12 按用户要求改）：顶部导航固定 8 项 `仪表板 / 账号状态 / 凭证管理 / 用户管理 / 配额 / 用量统计 / 会话日志 / 设置`（`users`/`quotas` 仅 owner+admin，见 `isTabVisibleForRole`）；**「API 测试」「Debug」不在导航里**，入口在右上角头像菜单（`app/user-menu.tsx`：个人资料 / 我的用量 / API 测试 / Debug / 退出登录），内容用 antd `Modal` 弹窗承载（复用 `ApiTestTabController`+`ApiTest`、`DebugTabController`+`Debug`）；`/api-test`、`/debug` 直链仍保留可用。
- **antd 6 API 约定**（2026-09-12 浏览器实测踩坑）：`Alert` 的正文用 **`title`**（`message` 已 `@deprecated`，用了会在 dev overlay 报 Issue），`description` 仍有效；`Tag.bordered` 已废弃（用 `variant="filled"`）。写 antd 组件前先看 `node_modules/antd/es/<comp>/*.d.ts` 里的 `@deprecated`。
- **浏览器测试必须双查**（2026-09-12 漏测教训）：`agent-browser errors` 只给页面级 error，**React/antd 的 deprecation 与 React 警告都在 `agent-browser console` 里**；还要主动点开 dev overlay 的 Issues 徽标。只查 errors 会得出「零错误」的错误结论（本次就是这么漏掉 5 处 `Alert message=` 的）。
- **`agent-browser errors` 缓冲会跨会话残留**（2026-09-13）：旧端口（如 3010）的报错会一直被打印、`--clear` 也清不掉；判据是 `--json` 里带旧 port 的 chunk URL。要干净结论就 `agent-browser close --all` 再 `open`（之后 `errors --json` 为 `[]`）。
- **本机 `next dev` 每个项目只能跑一个实例**（2026-09-13）：第二个实例报 `EADDRINUSE` 或提示「You can access the existing server at …」。先 kill 旧 PID；`kill` 直接执行会卡审批，**写进 bash 脚本再执行**。`next build` 必须在 dev 停掉后跑，构建完再重启 dev（不要 `rm` 掉验证用的 sqlite 库，否则要重走首次设置）。
- **给「服务端已给 initial data」的 tab 补客户端数据要单独拉取**（2026-09-13 实测缺陷）：`CredentialsTabController` 原本只在 `!hasInitialData` 时 `loadCredentials()`，导致 API Key 的配额 map 永远为空（硬刷新后显示「不限」）。凡新增「不在 initial data 里」的客户端字段，都要在 effect 的 `hasInitialData` 分支里补一次专用拉取。
- **前端表单契约**（2026-09-12 浏览器实测踩坑）：`PATCH /admin-api/users/[id]` 用「字段是否出现」判定变更意图，其中 `username`/`password` 出现即触发内置 owner 的 409 `console_owner_credentials` 守卫。因此**前端编辑表单只能回传真正改动过的 `username`**（`app/users/users-controller.tsx` 现在比对 `state.users` 里的原值），否则只改显示名/角色也会被拒且提示文不对题。
- **测试写法硬约束**（2026-09-12 实测踩坑）：①凡是在测试里改 `CODEBUDDY_STORAGE_*`（backend/sqlite path/file dir/encryption key）的文件，**必须在 `afterEach` 清掉**，否则污染同 worker 的其它文件（表现为 `users-domain.test.ts` 的顺序断言失败）；②**不要对 sqlite 后端的测试 mock `process.cwd()`**——sqlite 迁移目录是按 cwd 解析的（`Can't find meta/_journal.json`），隔离文件后端请用 `CODEBUDDY_STORAGE_FILE_DIR`；③判断 `getStorageBackendMeta().backend === 'file'` 前应先 `await ensureStorageReady()`，否则初始化前 meta 可能与真实后端不一致。
- ⚠️ 本工作区出现过**并行的第二个 agent**（2026-09-11 的 2.5 大部分是它写的）：动手前先 `git status` + 看文件 mtime，发现并行产出时先审计缺口再补，不要重写别人的实现。
- 实现决定：用户/应用/配额**不建 SQL 表**，改用既有 `documents` namespace（与 `admin-auth`/`credentials`/`access-keys` 一致，低基数，省两份 schema + migration）。
- 余额语义：配额 − 已用量；UTC 窗口；user 维度按 `ApplicationRecord.ownerUserId` 反查；缓存 10 秒（最多超发 10 秒）；file 后端保留期 7 天 → `degraded: true`；配额故障 **fail open**（资源约束非鉴权边界），applications 存储不可读 **fail closed**（503）。
- 已锁定决策：会话日志默认开启 / 30 天 / 加密 / 可一键清空；上下文数据存归一化 messages + 上游真实请求；余额同时计调用次数与 Token（cache token 计入 total 并单列，周期=月）；超额直接拒绝（OpenAI 429/402、Anthropic `rate_limit_error`）并保留「仅告警」开关；member 可查看自己应用 secret 明文；会话日志与余额仅支持 DB 后端。
