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
- **本地版用户画像 = 单机自用**。优化目标是"装好 → 跑起来 → 用上",心智里出现的概念越少越好。认证、org、密码完全隐藏。"evaluator vs daily user" 这条 persona 二分轴讨论后**抛弃** —— 只有一类受众。CLI 暴露**两种平等的操作形态**(前台 vs `--service`),用户按当时场景挑(SSH 远程 / Windows / 调启动失败 → 前台;想跨重启持续跑 → `--service`),不存在"哪个是默认"的说法。

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

新增一个顶层命令 `first-tree-hub start`,把今天的三步("`server start` + `admin:create` + `client connect`")合一。该命令有**两种平等支持的操作形态**,用户按当下场景挑;**不存在"哪个是默认"的说法**,onboarding 文档把它们当作并列选项呈现。

| 操作形态 | 什么时候选它 | 关掉终端之后还在跑的有什么? |
|---|---|---|
| `first-tree-hub start` | "我想在这个终端里把 Hub 跑起来。" 快速试用、调启动失败、SSH 会话、Windows(没服务支持)。 | 只剩 Postgres 容器。CLI 进程托管 server + 嵌入式 client;Ctrl+C 一起停。 |
| `first-tree-hub start --service` | "我想 Hub 跨重启一直跑,不占终端。" | Postgres + daemon(server + 嵌入式 client)。Daemon 下次登录自启。 |

两种形态共享同一份编排 —— Docker 预检、Postgres、迁移、auto-admin、嵌入 ClientRuntime、多层 URL 投递。差别只在生命周期:前台阻塞等 SIGINT;`--service` 装 launchd plist(macOS)或 systemd-user unit(Linux),然后退出。

#### 用户看到的输出 —— 前台形态

```
$ first-tree-hub start
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Server listening at http://127.0.0.1:8000
✓ Client connected as this computer

  Opening browser...
  (or open this URL: http://127.0.0.1:8000/?bootstrap=eyJhbGc...)

Press Ctrl+C to stop.
(Postgres container is kept running. To also stop it: first-tree-hub server stop)
```

#### 用户看到的输出 —— 服务形态

```
$ first-tree-hub start --service
✓ Postgres ready
✓ Database initialized
✓ Local admin ready
✓ Service installed
✓ Service running

  Opening browser...
  (or open this URL: http://127.0.0.1:8000/?bootstrap=eyJhbGc...)

(Service runs in the background and auto-starts at next login.)
(Need a fresh URL later? first-tree-hub login)

$ ▮
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

**步骤 2 —— 第一次启动(挑一种形态)**

```
first-tree-hub start              # 前台形态
# 或
first-tree-hub start --service    # 服务形态
```

后台发生(两种形态共享这几步):
1. Docker preflight(`isDockerAvailable()`);不可用立刻给指引退出。
2. `ensurePostgres` —— 拉镜像 + 起 `first-tree-hub-postgres` 容器(首次约 5–10s)。
3. `runMigrations` —— Drizzle 建约 32 张表。
4. `hasUser()` 返回 false → `createOwner()` 静默建 user + org `default` + member + 第一个 human agent。username 用 `os.userInfo().username` slugify(回退 `admin`);密码随机生成,**永不展示给用户**。
5. 起 server(`buildApp` + `app.listen` 在 `127.0.0.1:8000`)+ 同进程嵌入 `ClientRuntime`,注册为这台机器的 client。落 `client.yaml` + `credentials.json`。
6. 给该 admin 签 single-use bootstrap JWT(10min TTL)。
7. **多层 URL 投递** —— 自动开浏览器(除非 `--no-open` / SSH / 非 TTY);永远打印 URL 到 stdout;复制到剪贴板(除非 `--no-clipboard`)。

接下来两种形态分叉:
- **前台:** server + 嵌入式 client 留在 CLI 进程里,进程阻塞等 SIGINT。
- **服务:** 装平台服务单元,把 server + 嵌入式 client 交给 daemon,父进程轮询 daemon `/health` 最多 10s。失败:`service uninstall` 回滚,打印捕获到的 stderr(log 末尾约 20 行),退出 1。成功:父进程退出 0,daemon 继续跑。

步骤 2 后磁盘状态:
```
~/.first-tree/hub/
├── config/{server,client}.yaml
├── config/credentials.json    (mode 0600 —— admin JWT 对,daemon 跟带外 CLI 共用)
├── logs/<rotating NDJSON>
└── data/
```
`clients` 表有一行(这台电脑);`agents` 只有 admin 的 human 行。服务形态下,launchd plist 或 systemd-user unit 也已注册。

**步骤 3 —— 浏览器自动打开(两种形态相同)**

自动打开(或用户点终端里的 URL,或从剪贴板粘贴)载入 `http://127.0.0.1:8000/?bootstrap=<token>`。Web app:
1. 加载同一份 fastify 提供的 React Web app(`dist/web/index.html`)。
2. 检测到 `?bootstrap=<token>`。
3. POST 给 `POST /api/v1/auth/bootstrap` 拿到标准 access + refresh JWT。
4. 存进 storage;`history.replaceState` 把 query 参数清掉,避免截图 / 刷新泄漏。
5. 跳到 Workspace —— 空 state,还没 agent。

到这一步用户已经登录,**全程没看见 username / password / org**。

**步骤 4 —— 创建第一个 agent(两种形态相同)**

Workspace → Agents → `+ New Agent` → 输入名字(比如 `my-assistant`)→ 点 Create。

后台:
1. Web `listClients()` 找到 1 台在线 client(嵌入式那台 —— 前台形态归 CLI 进程,服务形态归 daemon)。
2. Web 调 `createAgent({name, type: "personal_assistant", clientId: <thisClient>})`。
3. Server 写 agents 行(pinned),R-RUN 校验通过。
4. Server 推 WS `agent:pinned` 给嵌入式 client。
5. Client `handleAgentPinned()` 写 `~/.first-tree/hub/config/agents/my-assistant/agent.yaml`,实例化 `AgentSlot`,自己开 agent WS。
6. Web 看到 `agent.clientId` 已 set,跳 Workspace 对应 agent。

总耗时 1–2 秒。**Last-step 模态不会弹**,**用户不需要碰终端**。

**步骤 5 —— 跟 agent 聊(两种形态相同)**

用户在中栏输入消息。消息 → server inbox → WS → AgentSlot handler → spawn Claude Code 子进程(cwd 是 `~/.first-tree/hub/data/workspaces/my-assistant/`)→ 流式回传。第一条消息冷启动慢,同 session 后续快。

**步骤 6 —— 停止 / 离开**

- **前台:** 在跑 `start` 的终端按 Ctrl+C,停嵌入式 `ClientRuntime`、关 fastify、退进程。**Postgres 容器留着**。终端最后一行:`(database container kept; first-tree-hub server stop to also stop it)`。直接关终端不按 Ctrl+C 也是同样效果(SIGHUP 杀掉父进程)。
- **服务:** CLI 命令在步骤 2 末尾就退了。关终端跟 daemon 没关系。浏览器 tab 也可以关 —— refresh-token cookie 持久(TTL ≈ 几周)。

**步骤 7 —— 再次启动**

- **前台:** 用户每次想用 Hub 都重跑 `first-tree-hub start`。`ensurePostgres` 复用既有容器(约 2–3s);`hasUser()` 真,跳过 admin 创建;**每次都签新 URL**。
- **服务:** 不需要做什么。Daemon 登录自启;Postgres 容器随 Docker daemon 起。用户直接打开 `http://127.0.0.1:8000` —— cookie 还有效 → Workspace。如果 cookie 过期或换浏览器:`first-tree-hub login`(或裸 `first-tree-hub`)用跟 `start` 同样的方式投递新 URL。

#### 用户敲过的命令一览

| 时间点 | 命令 |
|---|---|
| 第一次安装 | `npm install -g @agent-team-foundation/first-tree-hub` |
| 在这台机器上跑 / 装 Hub | `first-tree-hub start`(前台)**或** `first-tree-hub start --service`(服务) |
| 偶尔拿一份新登录 URL | `first-tree-hub login`(或裸 `first-tree-hub`) |
| 从这台机器移除 Hub(服务形态) | `first-tree-hub service uninstall` |

其它全部由这几条命令内部完成,用户视野里没有任何其他 CLI。

#### 行为契约

1. **前置检查(Q4-A)**:任何副作用之前先 `isDockerAvailable()`。Docker 不可用 → 沿用 `core/server.ts:57-64` 现有的友好文案(把 `re-run` 那行改成 `first-tree-hub start`),立刻退出。
2. **Postgres**:复用 `ensurePostgres`,有容器就 reuse,没有就拉起来。
3. **Migrations**:复用 `runMigrations`。
4. **静默建 admin(Q1)**:`hasUser` 返回 false 时,无声 `createOwner` —— `os.userInfo().username` slugify(回退 `admin`),org 写死 `default`,密码随机生成。**username / password / org 全程不向用户展示,也不落 cleartext 文件**。
5. **Server + 嵌入式 client**:server 起在 `127.0.0.1:8000`,同时嵌入 `ClientRuntime` 注册为这台机器的 client。落 `client.yaml` + `credentials.json`(admin JWT 对),让后续手敲的 `first-tree-hub agent ...` CLI 能直接用。
6. **签 bootstrap token(Q5-b)**:每次 start 都为该 admin 签一份新 single-use token,10 分钟 TTL。
7. **URL 投递(Q7)**:多层 —— (a) 自动开浏览器(除非 `--no-open` / SSH 会话 / 非 TTY);(b) 永远打 stdout(现代终端 Cmd+click 友好);(c) 复制到剪贴板(除非 `--no-clipboard` / 工具不可用)。
8. **前台形态**:server + 嵌入式 client 留在 CLI 进程,阻塞等 SIGINT。SIGINT 优雅停止;**Postgres 容器留着**,提示用户 `first-tree-hub server stop`。
9. **服务形态(Q2)**:装 launchd plist(macOS)或 systemd-user unit(Linux),把编排交给 daemon,父进程轮询 daemon `/health` 最多 10s(Q8)。失败:`service uninstall` 回滚,打印 daemon stderr 末尾约 20 行,退出 1 —— **不留半装状态**。成功:父进程退出 0;daemon 托管 server + 嵌入式 client。
10. **`--port <n>`**:默认 `8000`。撞 `EADDRINUSE` 时打印 `Port N is busy. Try 'first-tree-hub start --port <N+1>'.` 然后退出。**不做** auto-fallback、不做端口探测。
11. **`--no-open` / `--no-clipboard`**:分别独立关闭浏览器自动打开 / 剪贴板复制。
12. **服务形态幂等性**:服务已装且在跑时再跑 `first-tree-hub start --service`:
    - 跳过装
    - 尽力做一次 daemon 活跃性检查
    - 通过同样的多层方式签发 + 投递新 URL
    - 退出 0
13. **跨形态冲突**:服务在跑时跑 `start`(或反过来),探测到冲突(`:8000` 被占或服务在跑)。友好报错:`Hub is already running as a service. Use 'first-tree-hub login' to log in, or 'first-tree-hub service stop' first if you want to run inline.` 退出 1。

#### 多层 URL 投递(Q7)

每层都是 best-effort,失败就 fall through 到下一层:

- **自动开浏览器** —— 用 `open`(macOS)/ `xdg-open`(Linux)/ `start`(Windows)。这些情况跳过:
  - 用了 `--no-open`
  - 检测到 SSH 会话(`SSH_CLIENT` / `SSH_TTY` env)
  - stdout 不是 TTY(CI、管道)
- **打印到 stdout** —— **永远做**。现代终端(iTerm2、Terminal.app、VS Code、Warp、Alacritty)对打印的 URL 是 Cmd+click 友好的。
- **复制到剪贴板** —— 用 `pbcopy`(macOS)、`xclip` / `wl-copy`(Linux)、`clip`(Windows)。`--no-clipboard` 或工具不可用时跳过。

#### 裸命令行为(Q6)

```
first-tree-hub
```
不带子命令时,等价于 `login`。理由:做完一次 `first-tree-hub start` 之后,用户最高频的需求是"给我一份能登录的 URL" —— 裸命令为这条优化,不是为罕见但有副作用的 `start` 重跑优化。如果前台进程也好、daemon 也好都不在跑,打印 `Hub is not running on this machine. Run 'first-tree-hub start' or 'first-tree-hub start --service' to bring it up.` 然后退出 1。

#### 服务管理子命令

`start --service` 装好服务后,用这四条命令管它:

```
first-tree-hub service status            # running / installed-but-stopped / not-installed
first-tree-hub service logs [-f] [-n N]  # 看 / 跟 rotating NDJSON 日志
first-tree-hub service stop              # 停 daemon 但不卸
first-tree-hub service uninstall         # 删 plist/unit + 停 daemon(不动 Postgres)
```

`service stop` / `service uninstall` **不动** Postgres Docker 容器 —— 那条生命周期是解耦的。

#### 恢复

| 情境 | 怎么做 |
|---|---|
| Cookie 过期 / 换浏览器 / URL 丢了 | `first-tree-hub login`(或裸 `first-tree-hub`) |
| Daemon 挂了或被停了(服务形态) | `first-tree-hub start --service`(幂等) |
| 前台进程退了又想要回来 | `first-tree-hub start` |
| 服务被卸了又想要回来 | `first-tree-hub start --service` |

#### 用户视野里(故意做小)

用户**永远看不到**:username、password、org name、JWT、refresh token、`agent add`、`client connect`、launchd plist 内容、systemd unit 文件路径、Postgres 连接 URL、`credentials.json` 位置。

#### 故意不做的东西

- `admin:reset` 命令 —— 恢复就用 `start`(幂等)或 `login`,不需要单独命令。
- `admin.json` 落盘文件 —— 凭据从不离开 DB(只留 bcrypt hash)。
- `server` 命名空间下的 service 子命令(如 `server service install`)—— 只有顶层 `service` 命名空间存在,管 `start --service` 装出来的 daemon。
- `--detach` flag —— `--service` 已覆盖跨重启常驻的需求。
- Windows 服务支持 —— Windows 上当前只有前台形态(`first-tree-hub start`)可用。
- 单机多账号 —— 单账号/机器是产品 invariant。

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
- **C2.** 实现顶层 `first-tree-hub start` 命令(前台形态 + 两种形态共用的编排核心)。
  - 文件:`packages/command/src/commands/start.ts`。
  - Server 编排:重构 `core/server.ts:startServer`,把 listen 那一步交给调用者(或者拆成 `bootstrapServer()` 返回 `{app, config}` + 单独 listen)。
  - Auto-admin:复用 `core/admin.ts:hasUser` + `createOwner`。
  - 新端点:`POST /api/v1/auth/bootstrap`,接受 single-use bootstrap token,返回标准 access + refresh JWT 对(参考现有 `/auth/connect-token` 的模式)。
  - Web 改动:根路由检测 `?bootstrap=<token>`,POST 到新端点拿 JWT,清掉 URL 参数,跳 Workspace。
  - 嵌入 client:同一进程,`app.listen` resolve 后实例化 `ClientRuntime`,`getAccessToken: () => <内存 admin JWT>`。
  - SIGINT 优雅停 server + client;**Postgres 容器留着**,提示 `first-tree-hub server stop`。
  - **多层 URL 投递(Q7):** 新建共享模块 `core/url-delivery.ts` —— 自动开浏览器(`open` / `xdg-open` / `start`,在 `--no-open` / SSH 会话 / 非 TTY 时跳过)、永远打 stdout、复制到剪贴板(`pbcopy` / `xclip` / `wl-copy` / `clip`,在 `--no-clipboard` 或工具不可用时跳过)。被 C2 前台形态、C8 服务形态、C9 `login` 共用。
  - **跨形态冲突探测:** bind `:8000` 之前先探测 daemon 是不是已经占了端口,如果是,打印 redirect-to-`login` 友好报错并退出 1。
  - README "Quick Start" 段改成两种形态并列(`start` 和 `start --service`),不指定哪个是默认。
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
- **C8.** 加服务形态 —— `first-tree-hub start --service` + `service` 子命令组。跟 C2 前台形态**地位平等**,不再说成"opt-in"。
  - `first-tree-hub start --service` —— 装 launchd plist(macOS)/ systemd-user unit(Linux),把编排交给 daemon,父进程轮询 daemon `/health` 最多 10s,通过共享的 `core/url-delivery.ts` 投递 URL,然后立即退出。重启自启。
  - `first-tree-hub service install` —— `start --service` 的别名(对齐 Multica 的命名习惯)。
  - `first-tree-hub service uninstall` —— 删 plist/unit + 停服务。
  - `first-tree-hub service status` —— running / installed-but-stopped / not-installed。
  - `first-tree-hub service logs [-f] [-n N]` —— 打印或 follow `~/.first-tree/hub/logs/` 下的 NDJSON rotating log。
  - `first-tree-hub service stop` —— 停 daemon 但不卸。
  - Daemon 进程跑的是 C2 实现的同一份编排 —— Docker preflight、auto-admin(首次)、嵌入 ClientRuntime、server 在 `127.0.0.1:8000`。跟前台的差异:stdout/stderr 进 log 文件而不是终端。**daemon 自己不签也不打 bootstrap URL** —— URL 签发永远由父 CLI 进程负责(`start --service` 第一次签一份后退出;`login` 按需再签)。daemon 因为重启自起的那些次,是静默的,不会主动签 URL —— 浏览器 cookie 持久(几周)足以覆盖跨重启,真过期了用户跑 `login`。
  - **健康检查 + 回滚(Q8):** 父进程轮询 daemon `/health` 最多 10s。失败:`service uninstall` 回滚,打印 daemon stderr 末尾约 20 行,退出 1。**不留半装状态。**
  - Postgres 容器生命周期跟 service 解耦 —— `service stop / uninstall` 不动 Docker 容器。
- **C9.** 加 `first-tree-hub login` 命令 + 裸命令别名。
  - `first-tree-hub login` —— 连到正在跑的本地 server(前台进程或 daemon 都行),给 admin 签一份新的 single-use bootstrap token,通过共享 `core/url-delivery.ts` 投递 magic URL(自动开浏览器 + stdout + 剪贴板)。
  - **裸命令(Q6):** `first-tree-hub` 不带子命令时等价于 `login`。如果前台进程 / daemon 都不在 `:8000` 上响应,打印 `Hub is not running on this machine. Run 'first-tree-hub start' or 'first-tree-hub start --service' to bring it up.` 退出 1。
  - 不论 `start` 是前台形态还是服务形态都可用 —— URL 签发路径是同一条。
  - 约 20 行新代码:复用现有 `core/admin.ts`(找 admin)+ 跟 C2 同一条 token 签发路径 + 共享 `core/url-delivery.ts`。

(原 C6 client-retry-backoff 和 C7 localhost-no-service 删除——都被 C2 的嵌入式 client 模型自动消解。)

## 5. 分阶段顺序

- **Phase 1(本地版,已完整 spec):** C2(`first-tree-hub start` 前台形态 + 共用编排 + bootstrap endpoint + Web URL handler + 多层 URL 投递)+ C8(`--service` 形态 + `service` 子命令组 + 健康检查/回滚)+ C9(`login` 命令 + 裸命令别名)+ D1 的本地段 + README Quick Start 改写。独立可发,跟任何 hosted 决议解耦。两种形态一起出,文档才能把它们当作并列选项呈现。
- **Phase 2(托管版简化,已完整 spec):** C1 + C3——两边都改 connect / Last-step 这对组合,测试 scope 共享。D1 托管段按 Path A 首次 / Path B 加机器(Qh-2)写。D2 同步英文。
- **Phase 3(Hub 内扫尾):** D3、D4、C4,各自独立小 PR。
- **Phase 4(defer 题的 follow-up):** 单独会话重开 Qh-1 / Qh-5 / Qh-6 / Qh-7。C5 在这阶段先落核心动作(不 commit 默认 flag),等 Qh-6 决了再 flip。

## 6. 决策记录

### 本地场景

| ID | 问题 | 决定 | 理由 |
|---|---|---|---|
| Q1 | auto-admin + bootstrap UX | username/password/org 全程不向用户展示,不落 cleartext。每次 `start` 签新 URL。Cookie 过期 / URL 丢失走 `first-tree-hub login` 恢复。 | "完全不暴露密码"是承重原则;cookie 持久化 + 按需 `login` 让这条原则跨重启、跨浏览器都能成立 |
| Q2 | server 是否做成 service | **两种平等支持的形态,无默认。** `first-tree-hub start` 跑前台(server + 嵌入式 client 在 CLI 进程里);`first-tree-hub start --service` 装 launchd plist / systemd-user unit 把同一份编排交给 daemon。onboarding 文档把它们呈现为并列选项,按用户场景挑,不是"默认 + opt-in"。 | 纯前台逼着 daily user 用 tmux/nohup;默认装服务又会让用户在没意识到的情况下被默默写了 launchd plist。两种形态都是一等公民,因为它们对应不同真实场景:SSH / Windows / 调启动失败 → 前台,想跨重启常驻 → service |
| Q3 | client connect 走交互还是 token | moot —— 本地流程没有独立 `client connect` 步骤 | 被 C2 的嵌入式 client 模型解掉 |
| Q4 | Docker 前置 UX | Q4-A:`start` 第一行就检查,失败立刻给现有的友好文案 | 文案已够好,只需要把时机提前 |
| Q5 | 一条命令 `first-tree-hub start` | 是。Q5-a 名字 `start`。Q5-b 每次签新 URL。Q5-c PG 容器 Ctrl+C / `service stop` / `service uninstall` 都不停。Q5-d 文档里替代 `server start`。 | 四个子决议逐一通过 |
| Q6 | 裸 `first-tree-hub` 行为 | 等价于 `login`。前台进程 / daemon 都不在跑时,打印 `Hub is not running... Run 'first-tree-hub start' or 'first-tree-hub start --service'` 退出 1。 | 一次性的 `start` 之后,主导高频需求是"给我一份能登录的 URL";裸命令为这条优化。gh-style 先例(裸命令 = 主操作)。**裸 ≠ `start`** 是有意为之:从 typo 起出一个服务太突兀 |
| Q7 | URL 投递 | 多层、都是 best-effort:(a) 自动开浏览器(`open` / `xdg-open` / `start`,在 `--no-open` / SSH 会话 / 非 TTY 时跳过);(b) **永远**打 stdout(现代终端 Cmd+click 友好);(c) 复制到剪贴板(`pbcopy` / `xclip` / `wl-copy` / `clip`,在 `--no-clipboard` 或工具不可用时跳过)。共享模块 `core/url-delivery.ts` 给 `start`(两种形态)和 `login` 共用。 | 单层在某种环境必然失败:SSH 自动开不了浏览器;容器里没剪贴板;服务模式 stdout 看不到。多层至少有一条能命中 |
| Q8 | 服务形态健康检查 + 回滚 | 父进程把编排交给 daemon 后轮询 `/health` 最多 10s。超时 / 不健康:调 `service uninstall` 回滚,打印 daemon stderr 末尾约 20 行,退出 1。**不留半装状态。** | 服务模式失败(Docker 权限、端口冲突、plist 坏)必须在父进程 stdout 里冒出来;否则用户面对一个半装服务和"什么都没发生"的终端,无从下手 |

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
- `server` 命名空间下的 service 子命令(如 `first-tree-hub server service install`)—— 只有顶层 `service` 命名空间存在,管 `start --service` 装出来的 daemon。
- `admin:reset` / `show-credentials` 命令 —— 恢复就用 `start`(幂等)或 `login`;凭据从不离开 DB。
- Org provisioning UI(目前是运营方走 `server admin:create` / admin API)。
- Windows 服务支持 —— Windows 上当前只有前台形态(`first-tree-hub start`)可用。

### 有意做,但当前 scope 不阻塞(future discussion items)
- **改默认端口**。倾向把默认从 `8000`(开发机上经常被 Django / FastAPI 等占用)改成一个不常见端口(例如 `8473`)。本轮 onboarding 重设计先不做,把焦点留给主流程;当前 scope 保留 `8000` + 加 EADDRINUSE 友好文案 + `--port` flag(见 C2)。等本地版用量数据显示端口冲突真的是高频痛点时再做。
