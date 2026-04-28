# First Tree — 统一 Onboarding 设计

> 本文档定义将 `first-tree-hub` 收编进 `first-tree` 单一 CLI 之后,Hub + Tree + gardener + breeze 作为**一个产品**的整体 onboarding 形态。
>
> 与之配套但范围不同的文档:[docs/saas-onboarding-journey.md](saas-onboarding-journey.md)(branch `feat/saas-onboarding`)定义 Hub 自身的 SaaS 4-stage Web 向导;本文档**不替代**它,只回答"那 4 个 stage 之外、整个产品如何统一"。

---

## 1. 背景与现状

### 1.1 两个相邻的产品,零代码耦合

| 产品 | 仓库 | npm 包 | CLI |
|---|---|---|---|
| **first-tree** | `agent-team-foundation/first-tree` | `first-tree` | `first-tree {tree, gardener, breeze, skill}` |
| **first-tree-hub** | `agent-team-foundation/first-tree-hub` | `@agent-team-foundation/first-tree-hub` | `first-tree-hub {client, server, agent, onboard, ...}` |

两边互不引用对方代码。唯一耦合点是 Hub server 的可选环境变量 `FIRST_TREE_HUB_CONTEXT_TREE_REPO` —— Hub server clone tree 仓,client 启动 handler 时通过 [packages/client/src/runtime/bootstrap.ts:16](../packages/client/src/runtime/bootstrap.ts:16) 把 AGENT.md / 根 NODE.md 注入 agent workspace。

### 1.2 Hub 正在 SaaS 化,但 SaaS 文档**完全不提 Tree**

[docs/saas-onboarding-journey.md](saas-onboarding-journey.md) 设计了 4-stage Web 向导(Connect Computer → Agent → Workspace → Invite),目标 < 5 min 到第一个 agent online。整份文档 0 次提到 Context Tree、gardener、breeze —— 这是有意识的简化,但也意味着用户拿到 Hub 后无法自然发现 Tree 这层价值。

### 1.3 身份上的双轨

- Hub: `invitations` / `members` / `organizations` 表,Web 邀请 + Email OTP / GitHub OAuth 接受
- Tree: `members/<id>.md` + `first-tree tree invite/join` CLI

两条独立路径都能完成"邀请人"动作。这是 unified product 必须收口的第一个明显裂缝。

---

## 2. 目标

### 2.1 一句话叙事

> Install one tool. Get a team.
>
> ```
> $ npm i -g first-tree
> $ first-tree start
> ```
>
> 一条命令之后:knowledge tree、collaboration hub、自动维护 agent、外部信号路由 —— 一整支人 + agent 的协作基础设施。

### 2.2 不动摇的 invariants

1. **SaaS Stage 0-4 的 < 5 min 北极星不能破。** 任何产品扩展不能挤进 4-stage 向导内部。
2. **CLI 单一入口:`first-tree`。** Hub 作为第四个 product namespace(`first-tree hub …`),跟 `tree` / `gardener` / `breeze` 平级。
3. **Tree-less Hub 是 first-class,不降级。** Tree / gardener / breeze 是 Stage 5+ 的 progressive unlock。
4. **团队身份单一事实源。** Hub 是写入入口(velocity),Tree 是源头(git-native)。Hub 每次 invite/role-change 自动开 tree PR,merge 后 Hub 重读。
5. **Cross-product detection 优先于 prompt。** `.first-tree/source.json`、`~/.first-tree/hub/credentials.json`、`docker ps` 这些已经能 detect 的状态绝不再问用户。

---

## 3. 五个运行时概念 → 三层计算结构

### 3.1 最终态归属表

| 概念 | 归属 | 形态 |
|---|---|---|
| **团队身份** | Hub `members` 表(写)→ Tree `members/`(事实源,PR 同步) | 两边都有,单向 |
| **共享知识** | Tree(git) | 持久 |
| **协作通道** | Hub server + Hub client | stateless server + 长连 client |
| **维护型 agent** *(原"知识维护")* | gardener = Hub agent 的一个类型 | 跟其他 agent 同形态 |
| **信号型 client** *(原"外部信号")* | breeze = Hub client 的一个变种 | 跟其他 client 同形态 |

### 3.2 关键观察:后两个不是新维度

`gardener` 和 `breeze` 表面上是"两个独立产品",但展开后会发现它们各自落在 Hub 已有的三元结构里:

```
server   ←  状态、消息、调度(stateless 计算之外的一切)
  ↑
client   ←  本机 long-running daemon,持有用户身份(JWT / gh / Anthropic key)
  ↑
agent    ←  在 client 里跑的"工人",有 inbox、有 prompt、有 handler
```

- **gardener = Hub agent type(`type=gardener`)**
  schedule = Hub server 往 gardener agent inbox 投消息(cron / source-PR webhook 触发)。execution 在任意有 Hub client 的机器上跑,跟普通 Claude Code agent 同一条路径。gardener engine 代码在 [first-tree/src/products/gardener/engine](https://github.com/agent-team-foundation/first-tree/tree/main/src/products/gardener/engine) 不变,只是**包装**成 Hub agent handler。

- **breeze = Hub client variant(`source=breeze`)**
  跟 "Claude Code client" 是平级的客户端变种。它持有用户的 `gh` 登录(类似 Claude Code client 持有 Anthropic 登录),把 GitHub notifications 翻译成 Hub message。Codex / OpenCode 在 SaaS 文档里 "coming soon" 的位置也是这一层。

### 3.3 这种归属的收益

1. **Hub stateless 不破。** 没有新的 server-side compute 模型,没有 server 上的 Claude API 调用,没有 multi-tenant key 管理。
2. **multi-tenant ANTHROPIC_API_KEY 问题不存在。** 每个 org 的 gardener 用本 org client 上的 key,跟今天 Claude Code agent 一样。
3. **Plugin 化是顺带红利。** breeze 是 client variant → 未来 Codex / OpenCode / 任意"把外部信号翻译成 Hub message 的 daemon" 都套同一接口。gardener 是 agent variant → "review agent"、"on-call agent" 等以后都按这个模板复制。
4. **"Install one tool. Get a team." 叙事成立。** 一个 binary 装下,product 之间通过 Hub 自然协同。

唯一小代价:gardener 需要至少一台 Hub client 在线才能跑。但 drift 检测本就不是 ms 级实时,inbox 异步语义已经处理这种情况。

---

## 4. 用户旅程

### 4.1 SaaS Stage 0-4 不动

参见 [docs/saas-onboarding-journey.md](saas-onboarding-journey.md) §4。所有 `first-tree-hub …` 命令在统一 CLI 后改写为 `first-tree hub …`(见 §5 Phase 1)。

### 4.2 Stage 5 是**三个独立 unlock**,不是一个

向导关闭进入 Workspace 后,顶部和 Settings 提供三个可选解锁。任意时机 / 任意顺序 / 默认全部 dismissable。

#### Unlock A · Connect Context Tree

*位置:Workspace 顶部 banner + Settings → Knowledge Base*

```
🌳 Your agent doesn't know your team's context yet.
   Connect a Context Tree so it understands your decisions, owners, conventions.
   [ Connect repo ]  [ Generate starter ]  [ Later ]
```

- **Connect repo**:粘贴 GitHub URL → server 后台 clone → 已存在的 [bootstrap.ts:16](../packages/client/src/runtime/bootstrap.ts:16) 注入 AGENT.md / NODE.md
- **Generate starter**:Hub 用 Stage 0 已有的 GitHub OAuth scope 在用户 org 下开 `<org>-context` repo,预填 NODE.md 模板(可放后期)
- **Later**:Settings 里随时再开

#### Unlock B · Enable Gardener (Hub agent type)

*位置:Settings → Tree Maintenance(Tree 已绑后才出现)*

```
🌿 Let your team's agents keep the tree in sync.
   Gardener watches your bound source repos for drift and opens sync PRs.
   [ Enable on <client-name> ]
```

- 选一台已连接的 Hub client 跑 gardener agent
- Hub server 创建 `agents` 行 `type=gardener`,推 `agent:pinned` 给该 client
- Client 拉起 gardener handler(包装 [first-tree gardener engine](https://github.com/agent-team-foundation/first-tree/tree/main/src/products/gardener/engine))
- Schedule:Hub server 按 cron / source-PR webhook 投 inbox 消息触发

#### Unlock C · Install Breeze (Hub client variant)

*位置:Workspace → "Watch GitHub notifications"*

```
👁 Route your GitHub notifications to your Hub agents.
   Run on your machine:
   $ first-tree hub client connect --source breeze --gh-login
```

- 跟普通 `first-tree hub client connect` 同一条命令,只是 `--source breeze` 切换客户端类型
- breeze daemon 持有用户 `gh` 登录,把 PR/issue/discussion notifications 翻译为 Hub message
- 投递目标:用户在该 org 内的 personal_assistant agent(默认)或自选

### 4.3 顶层意图路由 `first-tree start`

不再让用户自己判断该跑哪个子命令。一条命令进入意图路由:

```
$ first-tree start

What are you doing?
  ▸ Joining a team       (paste invite link)
    Starting a team      (new org + tree + first agent)
    Add Context Tree     (have Hub already, want shared knowledge)
    Add Gardener         (auto-maintain an existing tree)
    Add Breeze           (route gh notifications)
    Self-host Hub        (run server on my own infra)
```

每条路径下面用具体子命令实现 —— `start` 只做意图匹配 + 调用,不重写业务。

### 4.4 Cross-product detection 是统一 CLI 才有的红利

```
$ first-tree hub server start
ℹ Detected `.first-tree/source.json` in cwd → bound tree at ../my-team-tree
  Use this as the Hub organization's Context Tree? [Y/n]

$ first-tree tree init
ℹ Detected ~/.first-tree/hub/credentials.json → connected to acme.first-tree.ai
  Register this tree with that Hub org after creation? [Y/n]

$ first-tree gardener start    # 在 Hub-bound 环境下
ℹ Detected Hub credentials → registering gardener as Hub agent type=gardener
  (no separate ANTHROPIC_API_KEY needed; uses this client's key)
```

---

## 5. 实施路径

六个阶段,risk 递增。Phase 1 是后面所有的前置;Phase 5 / 6 在前面四个稳定后再动。

### Phase 1 · 物理合并 CLI(无新功能)

- `first-tree-hub` 的 `packages/command/` 迁成 first-tree 仓的 `src/products/hub/cli.ts`,跟 `tree` / `gardener` / `breeze` 平级
- `packages/server` / `packages/client` / `packages/web` / `packages/shared` 的归属决策(三选一,见 §7.1):
  - **A** 单 monorepo 收编
  - **B** first-tree 仓引 `@first-tree-hub/*` 三个 backend 包
  - **C** 暂用 npm published tarball
- 旧的 `first-tree-hub` npm 包改成 thin shim,print "Use `first-tree hub` instead",6 个月 grace period
- 新增 `skills/hub/SKILL.md`(第五个 skill payload)
- **不动**任何 Web / 数据库 / API 行为

成本:1-2 周。风险:低。

### Phase 2 · SaaS 在新 CLI 上首发

- [docs/saas-onboarding-journey.md](saas-onboarding-journey.md) 全文 `first-tree-hub …` → `first-tree hub …`
- §7.1 里程碑 M0-M9 照旧推进
- **关键时序**:Phase 1 必须先于 SaaS 公测,否则早期用户经历一次痛苦改名

成本:跟 SaaS 文档的 ~14d 重叠,无额外。风险:低。

### Phase 3 · Cross-product detection + Tree 上升为 org-level setting

- Schema 增量(M0 配套):
  ```sql
  organizations
    + context_tree_repo_url       text nullable
    + context_tree_branch         text default 'main'
    + context_tree_synced_at      timestamptz nullable
    + context_tree_last_error     text nullable
  ```
  替代 server 级 env var `FIRST_TREE_HUB_CONTEXT_TREE_REPO`。
- Settings → Knowledge Base UI(Stage 5 unlock A)
- `first-tree hub server start` / `first-tree tree init` 在 cwd 做 detection 的 prompt
- `first-tree start` 顶层意图路由器

成本:1.5-2 周。风险:低。

### Phase 4 · 身份双轨收口

- Hub `invitation accepted` 时,server 调 GitHub API 在 tree repo 开 PR:`members/<id>.md` 加 `owners: [<id>]`,并在指定 domain 的 NODE.md frontmatter 加 owner
- Hub server 持有 GitHub App 写权限
- §4.7 SaaS Stage 4 邀请加可选 `domain` 字段:从 tree 的 `members/` 或顶层 NODE.md 列表选
- `first-tree tree invite/join` 在 Hub-bound org 里 deprecate(CLI warn);self-host 保留

成本:2 周。风险:中(GitHub App 申请、tree 写入策略)。

### Phase 5 · gardener 包成 Hub agent type

- `agents.type` 增加 `'gardener'` 枚举值
- `agents` 行的 handler 实现:在 client 侧 import `first-tree/src/products/gardener/engine` 的 sync / comment 函数,包装成消息处理器
- Hub server 增加调度:cron(每日 drift sweep)+ webhook(source PR 事件触发 verdict comment)
- Settings → Tree Maintenance UI(Stage 5 unlock B)
- gardener 独立 CLI(`first-tree gardener start/sync/comment`)保留供 self-host / 无 Hub 用户

成本:2 周。风险:**取决于候选 A 是否最终采纳(见 §7)**。

### Phase 6 · breeze 包成 Hub client variant

- `clients.source` 字段增加 `'breeze'`(当前仅 `'claude-code'`)
- `first-tree hub client connect --source breeze --gh-login` 子命令:复用现有 connect 逻辑 + 加 `gh auth status` 校验
- breeze daemon 的 dispatch 改成往 Hub Inbox 投消息(使用客户端已持有的 JWT)
- breeze 独立 CLI(`first-tree breeze install/watch/poll`)保留

成本:3-5 天。风险:低。**可独立于 Phase 4/5 任意时机插入。**

---

## 6. 与 SaaS onboarding 文档的关系

| 维度 | [saas-onboarding-journey.md](saas-onboarding-journey.md) | 本文档 |
|---|---|---|
| 范围 | Hub 自身的 4-stage Web 向导 | Hub + Tree + gardener + breeze 作为整体 |
| 时间窗口 | 用户首次访问 → 第一个 agent online(< 5 min) | 整个产品生命周期(包括 < 5 min 之外) |
| Tree | 0 次提及 | 核心组件 |
| 关系 | **被本文档包含** | 本文档的 §4.1 和 §5 Phase 2 引用它 |

两份文档**并行有效**:SaaS doc 描述用户最关键的前 5 分钟,本文档描述之后的产品全貌。任何修改 SaaS doc 的 PR 都应交叉检查本文档的 §4.2(Stage 5 unlock 不被破坏)。

---

## 7. 开放问题

### 7.1 Phase 1 的仓库形态(A / B / C)

合并 `first-tree-hub` 仓的 `packages/{server, client, web, shared}` 进 first-tree 仓时:

- **A** 单 monorepo 收编 —— 长期最干净,但需要 first-tree 仓 owner 同意接进 4 个新 package。
- **B** first-tree 仓 npm 引用 `@first-tree-hub/*` —— 减少仓库变更,但保留双仓库的发布协调成本。
- **C** 暂用 first-tree 仓引 `@agent-team-foundation/first-tree-hub` published tarball —— 最快,但 `packages/command` 已经在那个 tarball 里,会导致循环。

**当前倾向 A**,但需要确认 first-tree 仓 owner 接受。

### 7.2 gardener / breeze 的最终归属(候选 A vs B)

#### 候选 A · Plugin into Hub(本文 §3 采用)

- gardener = Hub agent type
- breeze = Hub client variant

**当前为暂时工作方向**(2026-04-28 拍板)。Phase 5/6 落地前若以下 watch item 任一触发,需重开讨论:

- client-variant 抽象在 `packages/client` 已被某个 PR 改成不兼容形态
- gardener 已被某个 Hub 部署改成 server-side 服务跑了一段时间(retrofit 成本上升)
- SaaS 定价 / quota 必须依赖 server-side gardener 计量(候选 A 的"keys 在 client" 失去计费点)
- Codex / OpenCode 接入已开始,client-variant 抽象的真实形态浮现

#### 候选 B · 保持独立,只通过 API 集成

- gardener / breeze 仍是 first-tree 顶层 product,可单跑(无 Hub 也可用)
- 跟 Hub 之间通过稳定公共 API(如 Hub Inbox webhook)联系

候选 B 牺牲集成度,保住"first-tree 三个产品独立可用"特性。Phase 5 的工程量更小但产品叙事更弱。

### 7.3 SaaS 发布 vs Phase 1 改名的时序

- 先 SaaS 后改名 → 早期用户经历一次 CLI 改名(高摩擦)
- 先改名后 SaaS → SaaS 推迟 1-2 周(机会成本)
- 并行 → 要立刻拍 §7.1 的 A/B/C

**当前倾向并行**,赌 1 周内完成 Phase 1。

### 7.4 Phase 5 在 v1 还是 v2

gardener 包成 Hub agent type 是"为什么用 Hub 而不是裸 first-tree" 的最强答案,但工程量在 SaaS ~14d 之外加 ~2 周。

**当前倾向 v2**(SaaS 第一次大版本升级时再做),v1 先把 Phase 1-4 的统一叙事跑通。

---

## 附录 · 关键代码引用

| 路径 | 用途 |
|---|---|
| [packages/command](../packages/command) | 待迁出为 first-tree 仓的 `src/products/hub/cli.ts` |
| [packages/client/src/runtime/bootstrap.ts:16](../packages/client/src/runtime/bootstrap.ts:16) | 当前 Tree 注入 agent workspace 的入口 |
| [packages/server/src/services/agent.ts](../packages/server/src/services/agent.ts) | Rule R-RUN(身份层) |
| [docs/saas-onboarding-journey.md](saas-onboarding-journey.md)(branch `feat/saas-onboarding`) | SaaS 4-stage Web 向导 |
| [first-tree/src/products/gardener/engine](https://github.com/agent-team-foundation/first-tree/tree/main/src/products/gardener/engine) | Phase 5 待包装的 gardener 业务逻辑 |
| [first-tree/src/products/breeze](https://github.com/agent-team-foundation/first-tree/tree/main/src/products/breeze) | Phase 6 待改造的 breeze daemon |
