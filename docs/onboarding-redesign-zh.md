# Hub Onboarding 重设计 —— 内部讨论稿

**状态:** Draft / 工作文档,Phase 4 落地后归档或删除。

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

## 2. 这一阶段的产品原则(讨论后落定)

- **一人 → 一 org → 一 member → 一 client**,这是默认 invariant。
- **Server 端的多租户保留**:`organizations` 表、`members` 桥、JWT 带 `organizationId`、所有查询按 org 过滤。这是托管版 ACL 的基底,不是面向用户的"加入多 org" 能力。
- **Client 端的多账号能力无限期 defer**:不规划 `profile` 子命令,UI 里看不到,`FIRST_TREE_HUB_HOME` 仅作内部测试工具。
- Login 在签 JWT 那一刻就把 `(member, org)` 钉死。`auth.ts:50-51` 的注释 `// Get first membership (this version: single org)` 已经暗示了这个产品边界,我们就不再扩它。
- 公共文档**默认单账号**。Edge case 走 troubleshooting 页面,不进 onboarding。

### 为什么这样划

我考虑过三种可能的多账号场景,逐一过一下:

| 场景 | 是否进 P0 | 理由 |
|---|---|---|
| 同一 Hub 上同一人加多 org | 否 | 早期客户基本是小团队,不会触发。Server 数据模型已经允许,不必现在搞 UX |
| 个人 Hub + 公司 Hub 并存 | 否 | 真实但小众,跟 git remote 多 origin 一类问题。等用户提了再做 |
| dogfood 测多 user | 否 | 内部场景,`FIRST_TREE_HUB_HOME` 留给开发者就够 |

砍掉之后,有一个隐藏好处:**当前 launchd label `dev.first-tree-hub.client` 全局唯一**这个限制,反而把"多账号同时在线"挡在门外,我们不需要再写代码顶住"立刻支持多账号"的产品压力。

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

### 4.1 文档(D1–D4)

- **D1.** 重写 `docs/quickstart-zh.md`。两个场景:
  - **场景 1:本地自建** —— `server start`(需要 Docker)→ 首次创建 admin → 浏览器登录 → 进入"接入客户端 + 创建 agent"通用段。
  - **场景 2:托管 Hub** —— 打开 admin 给的 URL → 登录 → 进入通用段。
  - **通用段** —— 明确写 Path A 和 Path B 两条路径,说清楚什么时候走哪条。**不写多账号一节**。
  - Workspace 三栏简介保留。
- **D2.** 同步英文 `docs/onboarding-guide.md`。这份还在引用 PR #95 / #108 已删除的 `agent token bootstrap` 流程。要么原地重写,要么删了换成新的 `docs/onboarding.md`。
- **D3.** 把 `CLAUDE.md` 里 `Local Testing Isolation` 那段移到内部 contributor 文档(`docs/dev/testing-isolation.md`)。对外的 CLAUDE.md 不再文档化 `FIRST_TREE_HUB_HOME`。
- **D4.** `docs/multi-tenancy-hardening-design.md:18` 把 non-goals 里那行 "Multi-org switching UX (will become a `first-tree-hub profile` CLI feature later)" 改成 "deferred indefinitely"。不预定 `profile` 这个名字。

### 4.2 代码(C1–C5)

- **C1.** 砍掉 `packages/command/src/commands/connect.ts:78-242` 的 account-switch gate。换成单一 Y/N:"This computer already has Hub credentials. Replace?"——不解析 JWT,不分 memberId,不打印隔离指南。约删 50 行。
- **C2.** `server start` 在 `users` 表为空时**直接交互式建第一个 admin**。流程:
  - 用 `hasUser()`(`core/admin.ts:10`)判定。
  - prompt username,默认值取 `os.userInfo().username`。
  - 密码用 `randomBytes(12).base64url()`(跟现在 admin:create 一致)。
  - 在 "Server running at …" 之前打印一段凭据块,只显示一次。
  - `--no-interactive` 时跳过。
- **C3.** Last-step 模态的 one-liner 砍掉 `agent add` 段。理由:`client connect` 触发 `client:register` 后,server 已经知道这台 client,会通过 `agent:pinned` 把那一刻应该 pin 的 agent 推过来(`services/client.ts:147-149` 已经做这个 backfill);one-liner 里再写一遍 `agent add` 是冗余,而且会引入"connect 取消但 agent.yaml 已经写下"的孤儿 yaml 失败模式。
  - 新链路:`npm install -g @agent-team-foundation/first-tree-hub && first-tree-hub client connect <url> --token <jwt>`。
- **C4.** 修 `packages/command/src/core/service-install.ts:47` 的 `LOG_DIR` bug。当前用 `join(DEFAULT_HOME_DIR, "logs")` 在模块加载时算出常量——任何用不同 `FIRST_TREE_HUB_HOME` 的进程都会写到加载时 home 而不是当前 home。改成调用时算。
- **C5.** 加 `first-tree-hub client logout`:
  - 删 `credentials.json`。
  - 询问是否同时卸 launchd / systemd 服务(或 `--keep-service`)。
  - 调 `/api/v1/clients/<self>/disconnect` 让 server 端立刻标 offline。
  - 打印下一步提示("To use this computer again, run `client connect <url>`")。

## 5. 分阶段顺序

- **Phase 1(纯文档,零代码风险):** D1、D2。先把用户实际看的东西修对。
- **Phase 2(本地 happy path):** C2。本地版用户从此一条命令就能登录,不用单独跑 admin:create。如果 D1 已经发了,这一步会同步更新。
- **Phase 3(Onboarding 简化):** C1 + C3 一起做。两边都改 connect / Last-step 这对组合,测试范围一致,合一个 PR 干净。
- **Phase 4(扫尾):** D3、D4、C4、C5。互相独立,可以拆 PR。

## 6. 待定的开放问题(需要你拍)

- **Q1.** 文档文件名。保留 `docs/quickstart-zh.md`(改动面小,README 链接不动),还是改名 `docs/onboarding-zh.md`(语义更准)?
- **Q2.** 英文版怎么处理。原地重写 `docs/onboarding-guide.md`,还是删掉换成新的 `docs/onboarding.md`?
- **Q3.** C3 时机。Phase 3 里就把 `agent add` 从 one-liner 砍掉,还是先在 staging 验证 `agent:pinned` 能在 `client connect` 成功后稳定回放,再砍?
- **Q4.** C2 admin-create UX。纯交互 prompt,还是也接受 `--admin-username` / `--admin-password` 给 CI 用?(`--no-interactive` 已经会跳过整个 prompt)
- **Q5.** C5 logout 默认怎么处理服务。默认卸服务(贴近"我登出了"的心智),还是默认保留(贴近"服务安装是另一件事")?

## 7. 显式 out of scope(留作未来)

- `first-tree-hub profile` 多账号 UX
- 每个 profile 一个 launchd / systemd 单元
- 多 org login UI(让用户选用哪份 membership)
- 跨 Hub 联邦 / 多 Hub 凭据管理
- 自助注册 / signup
- 邮件邀请 / 链接邀请新成员(目前是 admin 建 member + 线下交付密码)
