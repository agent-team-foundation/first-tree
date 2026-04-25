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

#### 端到端旅程(我们要让它呈现的体验)

**前置条件(由用户自己满足)**
- Node.js ≥ 22.16
- 装好并启动 Docker Engine 或 Docker Desktop

**步骤 1 —— 安装(一次)**
```
npm install -g @agent-team-foundation/first-tree-hub
```
完成后:`first-tree-hub` 在 PATH 里。`~/.first-tree/hub/` **还不存在**。

**步骤 2 —— 第一次启动**
```
first-tree-hub start
```
后台发生:
1. Docker preflight(`isDockerAvailable()`);不可用立刻给指引退出。
2. `ensurePostgres` —— 拉镜像 + 起 `first-tree-hub-postgres` 容器(首次约 5–10s)。
3. `runMigrations` —— Drizzle 建约 32 张表。
4. `hasUser()` 返回 false → `createOwner()` 静默建 user + org `default` + member + 第一个 human agent。username 用 `os.userInfo().username` slugify(回退 `admin`);密码随机生成,**永不展示给用户**。
5. 给该 admin 签 single-use bootstrap JWT(10min TTL)。
6. `buildApp` + `app.listen` 在 `127.0.0.1:8000`。
7. 同进程:`new ClientRuntime(...)` 通过 loopback WS 连上,注册为这台机器的 client,落 `client.yaml` + `credentials.json`。
8. 显眼地打印 magic URL,阻塞前台等 SIGINT。

步骤 2 后磁盘状态:
```
~/.first-tree/hub/
├── config/{server,client}.yaml
├── config/credentials.json (mode 0600)
├── logs/、data/
└── (尚无 agents/<name>/)
```
`clients` 表有一行(这台电脑);`agents` 只有 admin 的 human 行。

**步骤 3 —— 点击 magic link**

用户 cmd-click 或 copy-paste 终端里的 URL。浏览器:
1. 加载同一份 fastify 提供的 React Web app(`dist/web/index.html`)。
2. 应用检测到 `?bootstrap=<token>`。
3. POST 给 `POST /api/v1/auth/bootstrap` 拿到标准 access + refresh JWT。
4. 存进 storage;`history.replaceState` 把 query 参数清掉,避免截图 / 刷新泄漏。
5. 跳到 Workspace —— 空 state,还没 agent。

到这一步用户已经登录,**全程没看见 username / password / org**。

**步骤 4 —— 创建第一个 agent**

Workspace → Agents → `+ New Agent` → 输入名字(比如 `my-assistant`)→ 点 Create。

后台:
1. Web `listClients()` 找到 1 台在线 client(嵌入式那台)。
2. Web 调 `createAgent({name, type: "personal_assistant", clientId: <thisClient>})`。
3. Server 写 agents 行(pinned),R-RUN 校验通过。
4. Server 推 WS `agent:pinned` 给嵌入式 client。
5. Client `handleAgentPinned()` 写 `~/.first-tree/hub/config/agents/my-assistant/agent.yaml`,实例化 `AgentSlot`,自己开 agent WS。
6. Web 看到 `agent.clientId` 已 set,跳 Workspace 对应 agent。

总耗时 1–2 秒。**Last-step 模态不会弹**,**用户不需要碰终端**。

**步骤 5 —— 跟 agent 聊**

用户在中栏输入消息。消息 → server inbox → WS → AgentSlot handler → spawn Claude Code 子进程(cwd 是 `~/.first-tree/hub/data/workspaces/my-assistant/`)→ 流式回传。第一条消息冷启动慢,同 session 后续快。

**步骤 6 —— 停止(Ctrl+C)**

在跑 `start` 的那个终端按 Ctrl+C:
- 嵌入式 `ClientRuntime` 停所有 slot,关 WS。
- Fastify close。
- 进程退出。
- **Postgres 容器留着**(Docker `ps` 还能看见)。
- 终端最后一行:`(database container kept; first-tree-hub server stop to also stop it)`。

磁盘状态完整保留,agent / messages 跨 session 持久。

**步骤 7 —— 再次启动(第二天 / 重启电脑后)**

用户开 Docker Desktop(或确认 Docker daemon 在跑),然后:
```
first-tree-hub start
```
这次:
- `ensurePostgres` 发现容器已存在,reuse。启动很快(约 2–3s)。
- `hasUser()` 现在是 true → **跳过建 admin**。
- 仍然签**新的** bootstrap token,打印新 magic URL。
- 嵌入式 client 连上,server 把已经 pin 的 `my-assistant` 通过 `agent:pinned` 重放,slot 自动起来。
- 点新链接 → 进 Workspace,agent 在那等着,聊天历史还在。

#### 用户敲过的命令一览

| 时间点 | 命令 |
|---|---|
| 第一次安装 | `npm install -g @agent-team-foundation/first-tree-hub` |
| 每次启动(包含第一次) | `first-tree-hub start` |

**仅此**。其它全部由 `start` 内部完成,用户视野里没有任何其他 CLI。

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

### 4.2 托管版流程(部分锁定)

托管版**不引入** `first-tree-hub start` 之类的顶层一条龙命令——既有 Web + CLI 表面保留,只在三个具体地方做 trim(Qh-2 / Qh-3 / Qh-4)。剩下几个相邻问题被显式 defer(Qh-1 / Qh-5 / Qh-6 / Qh-7),见本节末尾。

#### 两个生命周期时点,两条路径(Qh-2)

托管用户文档**不挑一条**作 canonical。两条路径分别服务两个不同的生命周期时点:

- **首次接入(Path A —— Last-step 模态)**:新托管用户拿到凭据,还没接 client。他**目标驱动**——"我想用我的 assistant",不是"我要装 infra"。登录 → Agents → `+ New Agent` → 没在线 client → Last-step 模态弹出 install + connect 命令 → 在终端跑一次 → 模态检测到接入 → 跳 Workspace。Path A 是 implicit welcome flow,本次不动。
- **加机器(Path B —— "Connect a computer" strip)**:已经有 connected client 的用户想加台机(笔记本 + 台式机)。Clients 页 → "Connect a computer" → Generate → 在新机器跑 `client connect --token`。之后从 Web 创建 agent 自动 pin(零 CLI)。Path B 是 admin/infra-driven,day-1 之后才出现。

用户文档把这两条路径**按生命周期时点分开写**,不强行选 canonical——它们对应同一个用户在不同阶段的不同需求。

更彻底的 UX 升级(Web 上做一个 first-class onboarding wizard 替代"模态 interrupt" 形态)被认可,但**不在本次 redesign scope**。Path A 当前的 Last-step 模态形态保留。

#### Last-step one-liner 的形态(Qh-3,C3 已定)

Last-step 模态那条 one-liner 砍掉 `agent add` 段。新链:

```
npm install -g @agent-team-foundation/first-tree-hub && \
  first-tree-hub client connect <url> --token <jwt>
```

Server 端的 `agent:pinned` replay(`services/client.ts:147-149`) 在 client connect 成功后自动写出本地 `agent.yaml`。原本中间那一步是冗余,而且**引入了一类失败模式**:`connect` 半路被取消或失败时,磁盘上残留一份不属于真实 client 的 `agent.yaml`,污染下次重试。

实现:改 `packages/web/src/components/last-step-modal.tsx:76-82` 那个 command 字符串,约 5–10 LoC。

#### account-switch gate 简化(Qh-4,C1 已定)

`packages/command/src/commands/connect.ts:78-242` 那 60 行 gate 换成一行确认:

```
This computer already has Hub credentials. Replace? [y/N]
```

去掉:JWT 解码、member ID label、organization label、服务状态显示、`FIRST_TREE_HUB_HOME` 隔离指南。失去"同 memberId 重连静默通过"那个 niceity(得手动按 Y),这是单账号原则下可接受的 trade-off。约删 50 行。`ClientOrgMismatchError` 那条旋转 + 指南路径变得几乎不可达,可以一并清理。

#### Defer 给后续会话的题

下面这些题被认可但本次 redesign **不收尾**。每条都依赖本对话外的决策,留到后续单独议:

- **Qh-1 —— member identity source of truth。** 架构文档 `first-tree-architecture-overview.20260423.md` § 3.1 + 3.3 已定 Hh-1.B 方向(Context Tree `members/` 是 SoT)。本次讨论里又冒出一个自然延伸:**Hub Web 作为编辑 `members/` 的友好 UI**(通过 PR/commit 写到 tree 仓,sync 反向读回 Hub DB)。**实现节奏 + auth 机制**(GitHub OAuth vs username/password vs 其他)都开放。今天的 `members.createMember`(纯 DB)留作占位。注意:proposal § 3.3 把"Members 同步" 标 ✅ landed,但 Hub 一侧的 sync 代码不存在;Hub README 那句"synced to Hub automatically"也是 aspirational,**不是已实现**。这两边等接续讨论时一起对齐。
- **Qh-5 —— Org provisioning 文档放哪。** 今天所有 org 都是运营方通过 `server admin:create` 或 admin API 建,无自助。用户文档假设"你已经有凭据";如何/在哪写运营侧 provisioning 文档开放。**大概率落地形态**:单独 `docs/operator-runbook.md`,但本次不 commit。
- **Qh-6 —— `client logout` 默认是否同时卸服务。** 是按"我登出了 → 一切干净"的心智(默认卸),还是按"服务安装是另一件事"的心智(默认保留),开放。C5 下面只落核心动作,服务卸载默认 flag 等 Qh-6 决了再 wire。
- **Qh-7 —— Hosted 端到端旅程文档。** 本地版第 4.1 已经有逐步旅程,hosted 等价物**依赖 Qh-1**(auth 机制决定"用户怎么拿到第一份凭据"),先不写。

### 4.3 文档修改(D1–D4)

- **D1.** 重写 `docs/quickstart-zh.md`。本地段按 4.1 写定;托管段等 4.2 完成。
- **D2.** 同步英文 `docs/onboarding-guide.md`。删掉 `agent token bootstrap` 旧引用。结构跟 D1 对齐。
- **D3.** `CLAUDE.md` 里 `Local Testing Isolation` 段移到内部 `docs/dev/testing-isolation.md`。对外文档不再提 `FIRST_TREE_HUB_HOME`。
- **D4.** `docs/multi-tenancy-hardening-design.md:18` 把 non-goals 里那行 "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" 改成 "deferred indefinitely"。不预定 `profile` 这个名字。

### 4.4 代码修改(C1–C5)

- **C1.** 砍掉 `packages/command/src/commands/connect.ts:78-242` 的 account-switch gate,换成单一 Y/N 确认:
  - 没现有凭据 → 静默继续(不变)。
  - 有现有凭据 → `This computer already has Hub credentials. Replace? [y/N]`。默认 No。
  - Cancel → `Cancelled. Your existing setup is untouched.` 退出。**不**打印 `FIRST_TREE_HUB_HOME` 隔离指南。
  - Replace → 覆盖凭据继续。
  - **不**做 JWT 解码、member/org label、服务状态显示。
  - 约删 50 行。`ClientOrgMismatchError` 的旋转 + 指南路径变得几乎不可达,可以一并清。
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
- **C3.** Last-step 模态的 one-liner 砍掉 `agent add` 段。
  - 新链:`npm install -g @agent-team-foundation/first-tree-hub && first-tree-hub client connect <url> --token <jwt>`。
  - 理由:server 端 `agent:pinned` replay(`services/client.ts:147-149`)在 client connect 成功后自己写本地 `agent.yaml`。原中间步骤是冗余,且引入了"`connect` 半路失败时残留孤儿 agent.yaml"的失败模式。
  - 改 `packages/web/src/components/last-step-modal.tsx:76-82`,约 5–10 LoC。
- **C4.** 修 `core/service-install.ts:47` 的 `LOG_DIR` bug——改成调用时算,不在 import time 算。
- **C5.** 加 `first-tree-hub client logout`,核心动作已定:
  - `POST /api/v1/clients/<self>/disconnect`(best-effort,失败也继续)。
  - 停掉正在跑的 client 进程。
  - 删 `credentials.json`。
  - 打印:`Logged out. To use this computer again: first-tree-hub client connect <url>`。
  - **服务卸载默认 flag 等 Qh-6 定**(本次 defer)。实现可以先落核心动作 + 服务卸载 flag 默认值留空,等 Qh-6 决了再 wire。

(原 C6 client-retry-backoff 和 C7 localhost-no-service 删除——都被 C2 的嵌入式 client 模型自动消解。)

## 5. 分阶段顺序

- **Phase 1(本地版,已完整 spec):** C2(`first-tree-hub start` + bootstrap endpoint + Web URL handler)+ D1 的本地段 + README Quick Start 改写。独立可发,跟任何 hosted 决议解耦。
- **Phase 2(托管版简化,已完整 spec):** C1 + C3——两边都改 connect / Last-step 这对组合,测试 scope 共享。D1 托管段按 Path A 首次 / Path B 加机器(Qh-2)写。D2 同步英文。
- **Phase 3(Hub 内扫尾):** D3、D4、C4,各自独立小 PR。
- **Phase 4(defer 题的 follow-up):** 单独会话重开 Qh-1 / Qh-5 / Qh-6 / Qh-7。C5 在这阶段先落核心动作(不 commit 默认 flag),等 Qh-6 决了再 flip。

## 6. 决策记录

### 本地场景

| ID | 问题 | 决定 | 理由 |
|---|---|---|---|
| Q1 | auto-admin + bootstrap UX | username/password/org 全程不向用户展示,不落盘。每次 `start` 签新 URL。不加恢复命令(Ctrl+C 重启即可)。 | CLI 表面最小;evaluator 触发恢复频率以"几个月一次"为单位 |
| Q2 | server 是否做成 service | 否(Q2-A),前台进程 | 本地用户是 evaluator,server-service 复杂度不值 |
| Q3 | client connect 走交互还是 token | moot —— 本地流程没有独立 `client connect` 步骤 | 被 C2 的嵌入式 client 模型解掉 |
| Q4 | Docker 前置 UX | Q4-A:`start` 第一行就检查,失败立刻给现有的友好文案 | 文案已够好,只需要把时机提前 |
| Q5 | 一条命令 `first-tree-hub start` | 是。Q5-a 名字 `start`。Q5-b 每次签新 URL。Q5-c PG 容器 Ctrl+C 不停。Q5-d 文档里替代 `server start`。 | 四个子决议逐一通过 |

### 托管场景

| ID | 问题 | 决定 | 理由 |
|---|---|---|---|
| Qh-1 | member identity source of truth | **Defer。** 架构方向是 Hh-1.B(Context Tree `members/` 是 SoT,Hub Web 作为编辑它的友好 UI,通过 PR/commit 写,sync 反向读)。**实现节奏 + auth 机制**(OAuth vs password)开放。今天的 `members.createMember`(纯 DB)留作占位。 | 架构级、跨产品决策,需另开会话 |
| Qh-2 | Path A vs Path B canonical | **两条都要。** 按生命周期时点拆:Path A(Last-step 模态)是首次接入;Path B(Connect a computer strip)是加机器。文档按时点写,不强行选 canonical。Welcome flow UX 升级 defer。 | A 和 B 是用户在不同阶段的两种心智,不是互相替代 |
| Qh-3 | 砍 `agent add`(C3) | **是**。两命令链(install + connect)。 | 消灭孤儿 yaml 失败模式;`agent:pinned` replay 已覆盖被砍那一步 |
| Qh-4 | 简化 account-switch gate(C1) | **是**。一行 Y/N replace prompt。无 JWT 解码、无隔离指南。 | 单账号原则已锁;原 60 行 gate 服务的多账号场景已 defer |
| Qh-5 | Org provisioning 文档放哪 | **Defer。** 大概率落地形态:单独 `docs/operator-runbook.md`。当前用户文档假设"已有凭据"。 | 不阻塞别的 Qh,需要 follow-up |
| Qh-6 | `client logout` 默认是否卸服务 | **Defer。** C5 落核心动作(disconnect + 停进程 + 清凭据);服务卸载默认 flag 等后续决。 | flag 默认不阻塞命令本体 |
| Qh-7 | 托管端到端旅程文档 | **Defer。** 阻塞在 Qh-1(auth 机制决定"用户怎么拿到第一份凭据")。 | 旅程写作需要稳定的凭据流程 |

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
