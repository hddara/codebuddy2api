# codebuddy2api 长期记忆

## 项目定位

自托管 AI 网关：把 CodeBuddy（腾讯 copilot.tencent.com）上游能力，以 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三套兼容协议对外暴露，附带 Web 管理后台。是 [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api) 的重构版。

## 技术栈速查

- Next.js 16 App Router（Route Handler 均 `runtime='nodejs'` + `force-dynamic`）、React 19、Ant Design 6、`@lobehub/ui`、jotai、next-intl、Tailwind 4、zod
- 存储：自研抽象 `lib/server/storage/index.ts`，后端 file / sqlite / pg（drizzle-orm + better-sqlite3 + pg）
- 加密：`CODEBUDDY_STORAGE_ENCRYPTION_KEY` → SHA-256 → AES-256-GCM（iv12 + tag16 + ciphertext，base64）
- 鉴权：`/v1/*` 用 access key（`Authorization: Bearer` 或 `x-api-key`）；`/admin-api/*` 用管理员密码 + WebAuthn passkey 会话 cookie
- 包管理 Bun，单测 Vitest（覆盖率门槛 90%），e2e Playwright，服务端口 8001

## 关键环境变量

| 变量                                        | 作用                                              |
| ------------------------------------------- | ------------------------------------------------- |
| `CODEBUDDY_STORAGE_BACKEND`                 | `file` / `sqlite` / `pg`                          |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`          | 数据库后端必填，用于 AES-256-GCM                  |
| `CODEBUDDY_STORAGE_PG_URL` / `DATABASE_URL` | PostgreSQL 连接串（存在则后端默认 pg）            |
| `CODEBUDDY_STORAGE_SQLITE_PATH`             | SQLite 文件路径，默认 `<数据目录>/storage.sqlite` |
| `CODEBUDDY_STORAGE_FILE_DIR`                | 文件后端目录，默认 `.codebuddy_data`              |
| `CODEBUDDY_CREDENTIALS_DIR`                 | 凭据目录，默认 `.codebuddy_creds`                 |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES`     | 是否导入旧版 JSON 文件，默认 true                 |
| `CODEBUDDY_CONFIG_PATH`                     | 旧版配置路径兼容                                  |

## 项目约定（来自 AGENTS.md，必须遵守）

1. 提交信息用英文 conventional commit。
2. 提交前 `bun run lint` / `format:check` / `typecheck` / `test:coverage`（≥90%）/ `build` 必须全绿，覆盖率低于 90% 视为阻断失败。
3. 注释只写英文。
4. 只用箭头函数，禁止 `function` 声明。
5. 不留未使用变量。
6. 改用户可见文案，必须同步 `messages/` 下全部 locale（en / zh-CN / ja）。
7. PR 阶段还要跑 `bun run test:ci` 与 `bun run test:patch-branches`，changed branch coverage ≥90%。
8. Next.js 16 与训练数据差异较大，改代码前先读 `node_modules/next/dist/docs/` 对应指南。

## 用户明确要求（2026-09-10，最高优先级）

**不许改现有视觉样式。** 用户原话：「之前项目的样式很美观，别乱改样式」，并举例「顶部栏的磨砂效果当前就被改没了」。

落实方式：

- 重构只允许**新增** class、**搬运**已有 class，不得改动既有的视觉规则；`app/globals.scss` 里已存在的规则（尤其 `.admin-header` / `.console-header` 的 `backdrop-filter` + 点阵背景、以及各页面的 `#debug` / `#settings` / `#credentials` 布局）**原则上不动**。
- 只有在「某个类的样式随它所属的 DOM 一起被删除，已无引用」时才可以删该类，且要说明理由。
- 删掉旧控件（如 header 上的语言/主题 `Select`）会导致对应样式类（`.admin-header-select`）失去引用 —— 这类删除要单独列出来给用户看，不要混在大改动里。
- 任何改动完，都要**在浏览器里真实打开页面核对视觉**，不能只靠读代码或跑测试断言。
- 注意：本机 dev 服务反复重启会让用户浏览器里持有的页面处于 HMR 断连状态，用户可能因此看到「样式丢了」。遇到这类反馈，先硬刷新复现，再排查，别急着改代码。

### 顶栏磨砂效果的既有实现（不要动）

```scss
.admin-header {
  --bg-color: color-mix(in srgb, var(--lobe-color-bg-layout) 72%, transparent);
  background-color: transparent !important;
  background-image: radial-gradient(
    transparent 1px,
    var(--bg-color) 1px
  ) !important;
  background-size: 4px 4px !important;
  backdrop-filter: saturate(50%) blur(4px) !important;
}
.console-header {
  position: fixed !important;
  z-index: 30;
}
```

`.console-header` 是靠调用方 `className` 传进去的（`page-shell` 传 `.console-header`，登录页传 `.login-header`），改 header 组件时**必须保留这个 className 透传**，否则会退化成不固定的普通栏。

### 不要加解释性/分类性的文字标签

用户对冗余 UI 文案同样零容忍。2026-09-10 我在顶栏给导航加了「总览 / 应用 / 观测 / 系统」四个分组标签，被直接否决：

> 「总览、应用、观测等字样不是脱裤子放屁吗？除了占地方还有什么用？」

判定标准：**看一眼内容就知道的信息，不需要再补一行文字说明**。该分组结构（`navigationGroups` 属性、`navigationGroupOrder`、`NavigationGroupKey`/`AdminNavigationGroup` 类型、`.admin-header-nav-group*` 样式、`messages` 的 `navGroups` 段）已全部撤除，导航回到扁平 7 项。

→ 给这个项目写 UI 时，**默认不加**分组标签、说明性副标题、图例之类的装饰性文案；确实需要时先问。

## 目录速查

- `app/v1/` 对外推理 API；`app/admin-api/` 后台 API；`app/codebuddy/auth/` OAuth 授权（start/poll/callback）
- `lib/server/proxy/` 协议适配（codebuddy.ts / anthropic.ts / responses.ts / auth.ts / codebuddy-auth.ts）
- `lib/server/domain/` 业务（access-keys / credentials / credential-models / config / usage / stats / debug / account-status / **auto-checkin**）
- `lib/server/storage/` 存储抽象 + `backends/` + `migrations/{sqlite,postgres}/`
- `docs/` 是 VitePress 文档站（en / ja / guide / config），**不是**会话归档目录

## 后台任务的既有模式

后台定时/异步任务统一挂在 `globalThis.__codebuddy2api*__` 上防热重载重复初始化，由 `instrumentation.ts` 的 `register()` 在 `NEXT_RUNTIME === 'nodejs'` 时触发一次：

- `lib/server/domain/credential-models.ts` → `refreshMissingCredentialModels()`（启动时补齐缺失模型）——**这是当前唯一实际存在的后台任务**
- ~~`lib/server/domain/auto-checkin.ts` → `scheduleAutoCheckin()`（每日自动签到）~~ ← 已回滚，文件不存在

存储层的 usage/debug 走追加式事件表（file 后端回落 JSON 文档），domain 层用 `getStorageBackendMeta().backend === 'file'` 分支，不要在 storage 层直接调用 `getEventBackend()`。

## 每日自动签到（2026-09-10 实现 → **当天已按用户要求全部回滚，代码中已不存在**）

> **状态：已回滚。** 2026-09-10 用户要求把代码回滚到最初版本，`lib/server/domain/auto-checkin.ts`、`tests/server/auto-checkin.test.ts` 已删除，`config.ts` / `instrumentation.ts` / `app/health/route.ts` / `app/admin-api/settings/route.ts` / `app/settings/settings.tsx` / 6 份 docs 已 `git checkout` 还原。以下内容只是当时的实现记录，**不要据此认为功能存在**；若要重做，需先与用户对齐方案。
>
> 另：用户在本次会话中明确质疑过我的结论（"你确定？？？"），教训是**没有证据的因果不要当结论讲**——下文两处（`.next` 并发、bun 安装方式）都因此被撤回/改写。

- 配置项：`CODEBUDDY_AUTO_CHECKIN_ENABLED`（`'false'`/`'true'`，默认 false）、`CODEBUDDY_AUTO_CHECKIN_TIME`（`HH:mm`，默认 `09:00`，按**进程本地时区**解释）。由 `lib/server/domain/config.ts` 的 `RuntimeConfig` 统一管理，设置页自动渲染（`app/settings/settings.tsx` 的 `settingsSelectOptions` 里加下拉项即可）。
- 调度：`instrumentation.ts` 启动时 `scheduleAutoCheckin()`；`app/admin-api/settings/route.ts` 保存设置后再调一次，做到免重启生效。
- 状态持久化在 storage 的 `checkin/state`：`{ attemptCount, attemptDateKey, completedDateKey, lastRun }`。
- 语义：一天最多 3 次尝试（`MAX_ATTEMPTS_PER_DAY`）；只要有账号成功或当天无可用账号即视为完成；**全部失败（含上游整体不可用这种非抛异常的失败）不标记完成**，1 分钟后重试；错过时间点启动时 1 分钟后补跑。
- 观测：结果打日志，`/health` 返回 `auto_checkin: { enabled, next_run_at }`（`app/health/route.ts`）。

## 如何启动服务（2026-09-10 实测验证，不需要 bun）

**结论：`node` + 仓库已有的 `node_modules` 就够，不需要 bun。** `node_modules/.bin/next` 的 shebang 是 `#!/usr/bin/env node`。

| 形态                   | 命令                                                                                                                                                                                    | 实测结果                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 开发                   | `CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3010`                                                                             | ✅ `/health` 200，`Ready in 371ms`                                                                    |
| 构建                   | `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`                                                                                                                                         | ✅ `Compiled successfully`，产出 `.next/BUILD_ID` + `.next/standalone/server.js`                      |
| 生产（与 Docker 一致） | `cp -R .next/static .next/standalone/.next/static`；`cp -R public/. .next/standalone/public/`；`cd .next/standalone && NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3012 node server.js` | ✅ `/health`、`/login`、`/dashboard`、`/_next/static/chunks/*.js`（`application/javascript`）全部 200 |

注意事项：

- **端口 3000 已被 grafana 占用**（本机），所以开发必须显式 `--port`；`docs/config/local.md` 里写的 `bun run dev` + 3000 在本机起不来。
- **`next start` 不是本项目的生产入口**。`npm run start`（= `next start --hostname 0.0.0.0 --port 8001`）能起、本地也能访问，但 Next 16 会明确警告：
  `⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.`
  它在本地"看起来能跑"只是因为完整 `.next` + `node_modules` 都在；Docker runner 阶段**只拷 `.next/standalone` + `.next/static` + `public`**，所以镜像里只能跑 `server.js`。Dockerfile 的 `CMD ["bun","server.js"]` 里那个 **bun 只是因为基础镜像选了 `oven/bun:1-slim`，同一个 `server.js` 用 `node` 一样跑**（已实测）。
- `output: 'standalone'` **不会**自动把 `.next/static` 和 `public` 放进 `.next/standalone/`，这一步得自己做（Dockerfile 用 `COPY`，本地用 `cp`）。不做的话页面能返回 HTML 但静态资源 404。
- 数据目录：`.codebuddy_data` / `.codebuddy_creds` 已存在于仓库根（gitignored），`docs/config/local.md` 也要求先 `mkdir -p` 这两个。

### IDE safe-delete shim 会让 `next build` 挂住（重要）

不带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 时，`npm run build` 会**卡死在 `✓ Running next.config.ts` 之后**，长时间无输出。原因：`next build` 开头要清理 `.next`（文件数远超 shim 的 500 阈值），shim 触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 后**阻塞等待确认**。

连带后果：卡住的构建会一直占着 `<distDir>/lock`（Next 的锁是 **native flock**，见 `node_modules/next/dist/build/lockfile.js`，路径 = `.next/lock`），此时再跑 build 会报：

```
⨯ Another next build process is already running.
```

排障：`ps ax -o pid=,command= | grep "dist/bin/next"` 找到挂住的进程 kill 掉即可；**不需要手工删 `.next/lock`**（flock 随进程退出释放，残留文件无害）。

这也给之前"Playwright `--ui` 卡在 `Tests / Loading…`"提供了更合理的机制：`next build` 会清理/重写 `.next`（含 Turbopack dev 依赖的 `.next/dev`），把正在运行的 dev server 打坏，而 `reuseExistingServer: false` 又让 Playwright 一直等 webServer 就绪。**仍是强相关而非严格证明**，但机制比"共用文件"具体得多。

## 运行与验证体系（先看这里再动手）

### 工具链版本（CI 固定，不要凭记忆假设）

| 项         | 版本 / 事实                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 包管理器   | **Bun 1.3.14**（`.github/workflows/*.yml` 的 `BUN_VERSION`），`bun install --frozen-lockfile`                                                       |
| 框架       | Next.js 16.3.4（App Router + Turbopack dev）、React 19.2.8                                                                                          |
| 单测       | Vitest 4.1.11 + `@vitest/coverage-v8`，覆盖率 include **仅 `lib/server/**/*.ts`**（`app/**` 不计），阈值 lines/functions/statements 90、branches 70 |
| e2e        | Playwright 1.62.1，仅 chromium，`playwright.config.ts` 自带 webServer                                                                               |
| 覆盖率门禁 | Codecov patch + `bun run test:patch-branches --base <sha>`                                                                                          |

### 三个验证入口（CI 里是独立 workflow，**从不并发**）

| 入口      | 命令                                                      | 说明                                                                                                   |
| --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 静态+单测 | `bun run lint` / `format:check` / `typecheck` / `test:ci` | `ci-pr.yml`、`ci-main.yml` 的 verify job                                                               |
| e2e       | `bun run test:e2e`                                        | 独立 `e2e.yml`：先 `bunx playwright install --with-deps chromium` 再 `playwright test`（**headless**） |
| 构建      | `bun run build`                                           | `ci-pr.yml` 里是**最后一步**；`ci-main.yml` 另有 docker-build job                                      |

> `next build` 与运行中的 `next dev` 不要并发：`next build` 会清理/重写 `.next`（含 dev 依赖的 `.next/dev`）。详见上面「IDE safe-delete shim 会让 `next build` 挂住」一节——**相关性有实测，但因果仍未严格证明**，不要当结论讲。

### e2e 的运行上下文（不需要真实 CodeBuddy 账号）

`playwright.config.ts`：

- `baseURL` = `http://127.0.0.1:8001`，`webServer.command` = `bun run dev -- --hostname 127.0.0.1 --port 8001`，`reuseExistingServer: false`，就绪探针是 `/health`。
- webServer 注入 `CODEBUDDY_API_ENDPOINT=http://127.0.0.1:65535`（**故意不可达的假上游**）+ 隔离目录 `.tmp-e2e/<pid>/.codebuddy_creds|.codebuddy_data`，所以 e2e 全离线、不碰真实数据。
- 本地开发是 `bun run dev` 默认 **3000** 端口；只有 e2e 的 webServer 用 8001。

### `scripts/mock-upstream.mjs`

全仓库**零引用**的手动辅助脚本：一个手写的假 CodeBuddy 上游，默认 `127.0.0.1:3100`，实现 `/v2/chat/completions`（含 SSE 与 tool_calls）和 `/v1/responses`（Responses 事件流）。需要跑「有真实上游响应」的链路时可以：

```bash
node scripts/mock-upstream.mjs                       # 或 MOCK_UPSTREAM_PORT=3100
CODEBUDDY_API_ENDPOINT=http://127.0.0.1:3100 bun run dev
```

## 本地验证环境（重要，避免误判为代码缺陷）

CI 之外在本机跑验证时，IDE 会注入两个环境变量导致假失败：

1. `NODE_ENV=production` → React 组件测试（`tests/admin/*.test.tsx`）报 `TypeError: React.act is not a function`（react-dom 走生产构建）。**必须用 `NODE_ENV=test` 跑 vitest。**
2. JetBrains coding-copilot 的 `node-safe-delete-shim` 拦截 `fs.rmSync` → 大量测试报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。**必须加 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。**

本机 `bun` 不在 PATH，且仓库默认无 `node_modules`；用 `npx -y bun@1.4.2 install` 按 `bun.lock` 安装，之后直接用 `./node_modules/.bin/{vitest,eslint,tsc,prettier,next}`。

已验证可用的完整命令：

```bash
NODE_ENV=test CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/vitest run --coverage
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/next build
```

### 启动带界面的测试

```bash
# Playwright UI 模式（e2e，点击式界面）
cd /Users/hddara/HDdaraProject/HDdara/codebuddy2api
# 前置：PATH 里要有 bun（见下方"bun 未正经安装"）
NODE_ENV=development CODEBUDDY_SAFE_DELETE_ENABLED=0 \
  nohup script -q /tmp/pw-ui.log ./node_modules/.bin/playwright test --ui --ui-port=8080 > /dev/null 2>&1 &
open http://127.0.0.1:8080
```

关键点：

- `playwright.config.ts` 的 `webServer.command` 是 `bun run dev -- --hostname 127.0.0.1 --port 8001`，**依赖 PATH 里有 `bun`**。见下方"bun 未正经安装"。
- 必须显式 `--ui-port=8080`：不指定会随机取端口，拿不到稳定 URL。
- 必须 `NODE_ENV=development`：否则 IDE 注入的 `NODE_ENV=production` 会被 webServer 继承；`reuseExistingServer: false`，所以启动前要先 `pkill -f "next dev"` 释放 8001。
- UI 的 stdout 会缓冲，`/tmp/pw-ui.log` 可能长时间为空，用 `lsof -nP -iTCP:8080 -sTCP:LISTEN` 判断是否就绪。想拿到日志用 pty：`nohup script -q /tmp/pw-ui.log <同上命令> > /dev/null 2>&1 &`。
- 启动 UI 期间**建议不要**同时跑 `next build`（见上文"待确认"；2026-09-10 观察到相关性，未证明因果）。若界面卡在 `Tests / Loading…`：HTTP 层是正常的、控制台也不报错，别急着判定是 Playwright 的 bug；先看 `ps ax -o pid=,ppid=,command= | grep -E "playwright test --ui|bun run dev|next dev"`，确认 8001 上的 `next dev` 是否在被反复重启。
- Vitest 的图形界面需要额外装 `@vitest/ui`（当前未安装）：装完 `vitest --ui`。

### bun 未正经安装（本机现状，2026-09-10）

`~/.bun/bin/bun` **不存在**。当前 `bun` 能用，只是因为我在会话里 `export PATH="/Users/hddara/.npm/_npx/22f2fe8d8bc13000/node_modules/.bin:$PATH"` 把 **npx 的临时缓存目录**加进了 PATH：

- 该目录名是 `_npx/<hash>`，hash 由包版本决定（我装的是 `bun@1.4.2`，CI 用的是 **1.3.14**，版本还不一致）；npm 清缓存或换版本就失效。
- 所以这**不是**可复用的运行方式，只是临时绕行。正确做法是按官方方式装 bun（`brew install oven-sh/bun/bun` 或官方 install 脚本），并让版本对齐 CI 的 `BUN_VERSION`。
- 依赖是当初用 `npx -y bun@1.4.2 install` 装的（按 `bun.lock` 解析），`node_modules/` 已在 `.gitignore` 中。

`brv vc init` 会把 `.brv/` 追加进 `.gitignore`（因为 `.brv/context-tree/` 内含嵌套 `.git`），这是工具行为，不要当成误改。

## 坑：file 后端对文档路径是白名单制

`lib/server/storage/index.ts` 的 `getDocumentPath()` 对 file 后端**硬编码了允许的 `namespace/key`**（config/runtime、access-keys/store、debug/settings、debug/logs、usage/history、admin-auth/state、credentials/*），其余一律抛 `Unsupported storage document: <ns>/<key>`。

> 这条教训来自自动签到那次尝试（新增 `checkin/state` 时踩到，已随回滚移除该映射，但坑的性质不变）。

新增任何要落盘的自定义 namespace，**必须在 `getDocumentPath()` 里补一条路径映射**，否则：

- sqlite / pg 后端没事（通用文档表）；
- file 后端（默认后端）会**抛异常**，而且异常会被任务自身的 try/catch 吞掉只留一条 warn，表现为「功能静默失效」。

单元测试如果 mock 了 `@/lib/server/storage` 就完全测不出来——必须在 `tests/server/storage-backends.test.ts` 里补一条真实 file 后端的读写往返测试。
