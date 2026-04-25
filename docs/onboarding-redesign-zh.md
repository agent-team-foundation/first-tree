# Hub Onboarding 重设计 —— 内部讨论稿

**状态:** Draft / 工作文档,Phase 3 落地后归档或删除。

**分支:** `feat/first-tree-hub-onboarding`

**对齐:** `docs/onboarding-redesign.md`(英文版,仓库规约的官方计划稿)。本文档面向内部讨论,可以更口语,推理可以多写一点。

---

## 1. 为什么要做这件事

### 1.1 现行 quickstart-zh.md 已经跟代码对不上

针对 `origin/main` 上的 `06e40fb` 核对过,具体 drift:

- 文档说 "顶栏 Clients → 点 **Generate Connect Command**"。代码里按钮文案是 `Generate` / `Regenerate`,容器叫 "Connect a computer"(`packages/web/src/pages/clients.tsx:33-95`)。
- 文档说 New Agent 表单要选 **Type: Personal Assistant**。代码里 `type` 已硬编码为 `personal_assistant`(`packages/web/src/components/new-agent-dialog.tsx:135`),给用户看的字段叫 "Where it runs"(Claude Code / Kael)。
- 文档说要填 **Pin to client**。代码里这字段早就移除了,改成自动探测在线客户端(`new-agent-dialog.tsx:210-243`)。
- 文档说弹 "Agent Created" 对话框,里面是单条 `agent add`。代码里弹的是 "Last step — connect your computer",命令是合并的 one-liner `npm install && agent add && client connect`(`packages/web/src/components/last-step-modal.tsx:76-82`)。
- 文档描述的串行顺序("先 client connect → 然后 New Agent → 然后终端 agent add")**在线上根本不存在**:实际只有 Path A(Last-step one-liner)或 Path B(`agent:pinned` 推送,零 CLI),没有中间形态。

### 1.2 没有"本地自建"场景

现行文档假设的网址是 `https://first-tree.staging.unispark.dev`。`first-tree-hub server start` 是支持的命令,但完全没文档化。

### 1.3 多账号 / FIRST_TREE_HUB_HOME 复杂度对早期产品过度

代码里有一整套围绕"同一台机器多份凭据"的处理(account-switch gate、隔离指南、跨 org 重注册),但目前没有真实用户在用。如果不显式 defer 掉这部分,新文档会继承同一份混乱。

### 1.4 本轮文档的 scope

**先把本地版的所有决策锁死(第 4.1 节)**;托管版(第 4.2 节)留到下一次专门讨论。

## 2. 这一阶段的产品原则(讨论后落定)

- **一人 → 一 org → 一 member → 一 client**,这是默认 invariant。
- **Server 端的多租户保留**:`organizations` 表、`members` 桥、JWT 带 `organizationId`、所有查询按 org 过滤。这是托管版 ACL 的基底,不是面向用户的"加入多 org" 能力。
- **Client 端的多账号能力无限期 defer**:不规划 `profile` 子命令,UI 里看不到,`FIRST_TREE_HUB_HOME` 仅作内部测试工具。
- Login 在签 JWT 那一刻就把 `(member, org)` 钉死。`auth.ts:50-51` 的注释 `// Get first membership (this version: single org)` 已经暗示了这个产品边界,我们就不再扩它。
- 公共文档**默认单账号**。Edge case 走 troubleshooting 页面,不进 onboarding。
- **本地版用户画像 = evaluator / 单机自用**。优化目标是"装好 → 跑起来 → 用上",心智里出现的概念越少越好。认证、org、密码、服务安装,默认全部隐藏。

## 3. 现状盘点(代码级,对齐 origin/main)

### Server 端(`packages/command/src/commands/server.ts`)

- `server start`(line 21):Docker 拉 Postgres(或 `--database-url`)→ 跑 migration → Web 跑在 8000。**不会自动建 admin**。`core/server.ts:28` 的注释说"step 5: Create default admin if none exists",但实际函数从 migration 直接跳到 web dist + listen,这一步不存在。
- `server admin:create`(line 115):独立命令。建 `users` + `organizations` + `members` + 第一个 human `agents` 行 + `agent_configs` seed。生成的密码只显示一次。
- 还有 `server doctor` / `server status` / `server db:migrate` / `server stop`,功能性命令。

### Web(`packages/web/src/`)

- `pages/clients.tsx`:Clients 列表页,顶部 `ConnectStrip`,`Generate` 按钮调 `POST /connect-tokens`,inline 输出 `first-tree-hub client connect <url> --token <jwt>`。10 分钟有效,single-use。
- `components/new-agent-dialog.tsx`:New Agent 流。`type` 硬编码 `personal_assistant`。提交后探测 `listClients()`:
  - 0 在线 → fall through 到 Last-step 模态。
  - 1 在线 → 自动 `createAgent({clientId})`。
  - ≥2 在线 → "Choose a computer" 选择步骤。
- `components/last-step-modal.tsx`:只有 0 在线时才会出现。生成合并 one-liner `npm install && agent add && client connect --token`。轮询 `agent.clientId`,绑定后跳 Workspace。

### Client 端(`packages/command/src/`)

- `commands/connect.ts`:`client connect <url>`。支持 `--token`(连接 token)或交互式 username/password。**有一段 60 行的 account-switch gate**——解析新 JWT,比对 `memberId`,弹 Replace/Cancel,Cancel 时打印 `FIRST_TREE_HUB_HOME` 隔离指南。默认装 launchd / systemd-user 服务,除非加 `--no-service`。
- `commands/agent.ts`:`agent add [name] --agent-id <uuid>`,写 `~/.first-tree/hub/config/agents/<name>/agent.yaml`。
- `core/client-runtime.ts:233-261`:监听 `agent:pinned` server 推送,自动写跟 `agent add` 完全一样的 yaml,然后起 slot。注释明写 "mirror what `first-tree-hub agent add` does"。

### 实际只有两条路径

- **Path A(全新机器,0 client 在线):** Web 建 agent → Last-step 模态 → 复制 one-liner → 终端跑 `npm install + agent add + client connect --token` → 模态轮询完成 → 跳 Workspace。
- **Path B(机器已连):** Web 建 agent → server pin → server WS push `agent:pinned` → client 自动注册 → Web 跳 Workspace。**零 CLI**。

quickstart-zh.md 描述的中间路径(分别 connect 然后 add)在线上根本走不通。

## 4. 要做的修改

### 4.1 本地版流程(已锁定)

新增一个顶层命令,把今天的三步("`server start` + `admin:create` + `client connect`") 合一:

```
$ first-tree-hub start
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Server listening at http://127.0.0.1:8000
✓ Client connected as this computer

  Open this URL to log in:
    http://127.0.0.1:8000/?bootstrap=eyJhbGc...

Press Ctrl+C to stop.
(Postgres container is kept running. To also stop it: first-tree-hub server stop)
```

#### 行为契约

1. **前置检查(Q4-A)**:第一行就跑 `isDockerAvailable()`。Docker 不可用 → 沿用 `core/server.ts:57-64` 现有的友好文案(把 `re-run` 那行改成 `first-tree-hub start`),立刻退出。
2. **Postgres**:复用 `ensurePostgres`,有容器就 reuse,没有就拉起来。
3. **Migrations**:复用 `runMigrations`。
4. **静默建 admin(Q1)**:`hasUser` 返回 false 时,无声建 admin —— `os.userInfo().username` slugify(空 / `root` 时回退 `admin`),org 写死 `default`,密码用 `randomBytes(12).base64url()`。**username / password / org 全程不向用户展示,也不落 cleartext 文件**。
5. **签 bootstrap token(Q5-b)**:每次 start 都为该 admin 签发一个新 token(single-use,10 分钟 TTL),把 magic URL 显眼地打到 stdout。
6. **起 Server**:复用 `buildApp` + `app.listen`,绑 `127.0.0.1:8000`。
7. **嵌入 Client(Q5)**:同一个 Node 进程里,server listen 后 `new ClientRuntime("http://127.0.0.1:8000", clientId, { getAccessToken: () => <内存里那份 admin JWT> })` 起 client。`client.yaml` 和 `credentials.json` 也写一份,让后续手敲的 `first-tree-hub agent ...` CLI 能直接用。
8. **不装 client 服务(Q5)**:嵌入式 client 跟主进程共生死,不写 launchd/systemd 单元。
9. **SIGINT(Q5-c)**:优雅关 ClientRuntime → close fastify → 退出。**Postgres 容器留着**。退出输出告诉用户怎么也停 Postgres。

#### 用户视野里看到的全部

- 一条命令:`first-tree-hub start`
- 每次跑出来的 bootstrap URL
- "Press Ctrl+C to stop" 一行
- 仅此而已

用户**永远看不到**:username、password、org name、JWT、refresh token、`agent add`、`client connect`、服务安装/卸载、Postgres URL 等等。

#### 恢复(URL 丢了 / cookie 过期)

Ctrl+C → `start` 再跑一遍。每次都会打印新 URL,自动恢复登录入口。

#### 故意不做的东西

- `admin:reset` 命令 —— 重启就够,不需要单独命令。
- `login` / `bootstrap-url` 命令 —— evaluator 几个月触发一次的概率,不值得加 CLI 长面。
- `admin.json` 落盘文件 —— 凭据从不离开 DB(只留 bcrypt hash)。
- Server-as-service —— 早期不做。daily user 真有需要再加。
- Server `--detach` flag —— 同上。

### 4.2 托管版流程

**状态:** 留到下一次专门讨论。当前实现(Web `Generate` token、New Agent 自动 pin、Last-step 模态 one-liner、`client connect --token`)在那之前不动。

需要后续敲定:

- account-switch gate 是不是要简化(C1)。
- Last-step 模态那条 one-liner 要不要砍掉 `agent add`(C3)。
- Org provisioning 在文档里怎么处理(单独 operator runbook?用户文档里 out-of-scope?)。
- Web "Connect a computer" 入口要不要保留,还是只留 Last-step 模态。

### 4.3 文档修改(D1–D4)

- **D1.** 重写 `docs/quickstart-zh.md`。本地段按 4.1 写定;托管段等 4.2 完成。
- **D2.** 同步英文 `docs/onboarding-guide.md`。删掉 `agent token bootstrap` 旧引用。结构跟 D1 对齐。
- **D3.** `CLAUDE.md` 里 `Local Testing Isolation` 段移到内部 `docs/dev/testing-isolation.md`。对外文档不再提 `FIRST_TREE_HUB_HOME`。
- **D4.** `docs/multi-tenancy-hardening-design.md:18` 把 non-goals 里那行 "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" 改成 "deferred indefinitely"。不预定 `profile` 这个名字。

### 4.4 代码修改(C1–C5)

- **C1.** 砍掉 `commands/connect.ts:78-242` 的 account-switch gate,换成单一 Y/N "Replace existing credentials?" prompt。约删 50 行。*等 C2 落地后 `client connect` 变成纯 hosted 路径再做。*
- **C2.** 实现顶层 `first-tree-hub start` 命令。
  - 文件:`packages/command/src/commands/start.ts`。
  - Server 编排:重构 `core/server.ts:startServer`,把 listen 那一步交给调用者(或者拆成 `bootstrapServer()` 返回 `{app, config}` + 单独 listen)。
  - Auto-admin:复用 `core/admin.ts:hasUser` + `createOwner`。
  - 新端点:`POST /api/v1/auth/bootstrap`,接受 single-use bootstrap token,返回标准 access + refresh JWT 对(参考现有 `/auth/connect-token` 的模式)。
  - Web 改动:根路由检测 `?bootstrap=<token>`,POST 到新端点拿 JWT,清掉 URL 参数,跳 Workspace。
  - 嵌入 client:同一进程,`app.listen` resolve 后实例化 `ClientRuntime`,`getAccessToken: () => <内存 admin JWT>`。
  - SIGINT 处理同时停掉两边。
  - README "Quick Start" 段改成 `npm install ... && first-tree-hub start`。
  - **端口处理:** 默认 `8000`(暂不变),`--port <n>` flag 支持。撞 `EADDRINUSE` 时 catch 后打印 "Port N is busy. Try `first-tree-hub start --port <N+1>`.",不再让 Node 原栈飞出来。**不做** auto-fallback、不做"另一个 Hub 在跑"特判——参见第 7 节关于改默认端口的未来讨论项。
- **C3.** Last-step 模态的 one-liner 砍掉 `agent add` 段。`services/client.ts:147-149` 的 server-side `agent:pinned` replay 已经覆盖。*仅 hosted,等 4.2 完成。*
- **C4.** 修 `core/service-install.ts:47` 的 `LOG_DIR` bug——改成调用时算,不在 import time 算。
- **C5.** 加 `first-tree-hub client logout`:
  - 删 `credentials.json`。
  - 可选 flag 同时卸服务。
  - 调 `/api/v1/clients/<self>/disconnect` 让 server 立刻标 offline。
  - *主要给 hosted 用,4.2 后再看是否真的需要。*

(原 C6 client-retry-backoff 和 C7 localhost-no-service 删除——都被 C2 的嵌入式 client 模型自动消解。)

## 5. 分阶段顺序(本地优先)

- **Phase 1(本地版完成):** C2(`first-tree-hub start` + bootstrap endpoint + Web URL handler)+ D1 的本地段 + README Quick Start 改写。
- **Phase 2(托管版对齐):** 单独开一次讨论,定 4.2;落地 C1 / C3 / D1 托管段 / D2。
- **Phase 3(扫尾):** D3、D4、C4、C5,各自独立 PR。

## 6. 决策记录

| ID | 问题 | 决定 | 理由 |
|---|---|---|---|
| Q1 | auto-admin + bootstrap UX | username/password/org 全程不向用户展示,不落盘。每次 `start` 签新 URL。不加恢复命令(Ctrl+C 重启即可)。 | CLI 表面最小;evaluator 触发恢复频率以"几个月一次"为单位 |
| Q2 | server 是否做成 service | 否(Q2-A),前台进程 | 本地用户是 evaluator,server-service 复杂度不值 |
| Q3 | client connect 走交互还是 token | moot —— 本地流程没有独立 `client connect` 步骤 | 被 C2 的嵌入式 client 模型解掉 |
| Q4 | Docker 前置 UX | Q4-A:`start` 第一行就检查,失败立刻给现有的友好文案 | 文案已够好,只需要把时机提前 |
| Q5 | 一条命令 `first-tree-hub start` | 是。Q5-a 名字 `start`。Q5-b 每次签新 URL。Q5-c PG 容器 Ctrl+C 不停。Q5-d 文档里替代 `server start`。 | 四个子决议逐一通过 |

## 7. 显式 out of scope / 未来讨论项

### 当前没有意图做(hard out of scope)
- `first-tree-hub profile` 多账号 UX
- 每个 profile 一个 launchd / systemd 单元
- 多 org login UI(让用户选用哪份 membership)
- 跨 Hub 联邦 / 多 Hub 凭据管理
- 自助注册 / signup
- 邮件邀请 / 链接邀请新成员
- Server-as-service 安装(`first-tree-hub server service install` 等)
- `admin:reset` / `login` / `show-credentials` 命令(等真实需求出现再加)
- Org provisioning UI(目前是运营方走 `server admin:create` / admin API)

### 有意做,但当前 scope 不阻塞(future discussion items)
- **改默认端口**。倾向把默认从 `8000`(开发机上经常被 Django / FastAPI 等占用)改成一个不常见端口(例如 `8473`)。本轮 onboarding 重设计先不做,把焦点留给主流程;当前 scope 保留 `8000` + 加 EADDRINUSE 友好文案 + `--port` flag(见 C2)。等本地版用量数据显示端口冲突真的是高频痛点时再做。
