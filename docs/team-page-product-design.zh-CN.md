# Team Page 产品设计

## 状态

实现于 [agent-team-foundation/first-tree-hub#205](https://github.com/agent-team-foundation/first-tree-hub/pull/205)。

相关 issue:

- agent-team-foundation/first-tree-all#100

## 摘要

First Tree Hub 的 `/team` 从原本的 master-detail(Members / Agents / Settings 三个子 tab)统一为**单页两表**:**Humans**(org members)+ **Agents**(filter type=human 之后的真 bot)。

Page-level subtitle 用 "1 human and 2 agents working together" 在产品入口直接体现 AI-native team 叙事 —— "team = 人 + agent 共同体" 这一观念。

`Team settings` 仍作为 admin-only sub-route 保留,但主入口默认进 `/team` 单页,无需先选 tab。

## 问题

原结构的 master-detail 子 tab 有几个问题:

- **认知割裂**:Humans 和 Agents 被结构性分开,跟产品立意"人和 agent 平等协作"相悖
- **多余的导航开销**:小团队(<20)场景下,在两个 tab 间切换看人 / 看 bot 是无谓的点击
- **AI-native team 叙事被结构稀释**:用户进 `/team` 第一眼看到的是"先选一个 tab",而不是"我的团队是什么样的"

我们之前还遇到一个具体的实现细节漏出的问题:

- `agents` 表中的 `type=human` 行(每个 user 自动生成的 chat-身份镜像)在原 Agents 子 tab 里跟普通 agent 混在一起,造成"我自己也是个 agent"的奇怪呈现

## 目标

- 把 `/team` 做成 AI-native team 的**身份目录入口**:一眼看清"团队由哪些 humans + agents 组成"。
- 让 Humans 和 Agents 在结构上**并列且平等**,不在层级 / 视觉上暗示主从。
- 把 `human`-type agent 这一**实现细节**从产品 UI 里彻底隐去。
- 让 admin 的高频管理动作(invite link、改 role)仍保持 1-click 可达。
- 跟产品扁平、克制的视觉语言对齐。

## 非目标

- 不重做 Workspace(由 #99 chat-first-workspace 设计承担)。
- 不实现 Task primitive、task board、邀请历史 / pending invites 管理 —— 都是后续 issue。
- 不重做 Settings 顶级 tab 的内部结构(Computers / Integrations 在 Settings master-detail 中,与本 doc scope 解耦)。

## 产品模型决策

### Identity model 复用,不新增

`/team` 页面不引入新的产品实体,直接投射 Hub 现有的身份模型:

```text
users        — 全局账号(GitHub-derived)
members      — 用户在某个 org 的成员资格(role: admin/member)
agents       — agent 系统的 actor,type ∈ {human, personal_assistant, autonomous_agent}
```

`/team` 页面是这两份数据的视图聚合:

```text
Humans 表       ← members JOIN users(列出 org members)
Agents 表       ← agents WHERE type ≠ "human"(列出团队的 bot)
```

### `human`-type agent 在 UI 中的定位

`human`-type 是 first-tree-hub 后端为了让 chat 系统统一对待"参与者"而存在的实现机制 —— **每个 user 加入 org 时自动生成一行 `agents.type=human`**,作为 user 在 chat / @-mention / inbox 路由中的身份载体。

代码层面已经在区别对待:

- `agent-detail` 页对 `type=human` 禁用了所有 config tab(`enabled: type !== "human"`)— 它没有 prompt / MCP / runtime config 可改
- `workspace/roster` 内部也是把 humans 和 non-human agents 拆成两组显示
- `chat.ts` 多处特殊处理 humans(它不是被"加进群"的对象,本身就是 chat 的主体)

UI 层面应该跟这一立场对齐 —— **不把 `type=human` 暴露成"agent 实体"**:

- 用户在产品里"是" Ta 自己,不是"Ta 自己的 human-type agent record"
- 用户去 `/team` 看团队人员时,应只看到 humans 一次(在 Humans 表里),不应该在 Agents 表里再看到自己一行被标 `HUMAN`
- 类比:用户不会在某个 settings 页里看到一个叫 "Apple ID record" 的"东西"等待管理 — 用户**就是**自己的 Apple ID

实施上,Agents 表的查询结果在前端 `filter((a) => a.type !== "human")`。

### Members / Agents 平级而非嵌套

不把 Agents 作为 Members 的子集或反过来。两者是**两份不同来源的数据**(`members` 表 vs `agents` 表),代表团队的两类参与者。在 `/team` 页面用两段平行的 section 展示:

```text
Team
├─ Humans · [count]   ← members 表数据
└─ Agents · [count]   ← agents 表数据(filter type=human)
```

count 信息通过 page-level subtitle 表达(`1 human and 2 agents working together`),section header 自身保持纯文字标识(`Humans` / `Agents`)。

## 决策:UI 层级和命名

### 顶 nav 4 项

```text
Workspace · Context · Team · Settings
```

来源:2026-05-06 团队周会决议。`Team` 在顶 nav 是"团队入口";`Settings` 是配置入口,跟 Team 解耦。

### `/team` 内部布局

非 admin:

```text
/team   ← 直接进 Members 单页(无 sidebar)
```

admin:

```text
/team
├─ sidebar
│  ├─ Members        ← 默认进入,渲染 /team
│  └─ Team settings  ← /team/settings,管理 org name / system config 等
└─ main: <Outlet />
```

> Sidebar 只在 admin 时渲染,因为非 admin 的子路由只剩一个 `Members`,master-detail 没意义。

### Type 命名

延用 first-tree 已经写在 `agent-hub/product-direction.md` 和 `roadmap/infrastructure.md:117` 的 canonical term:

| schema | UI label |
|---|---|
| `personal_assistant` | `Personal assistant` |
| `autonomous_agent` | `Autonomous agent` |

不缩写为单词版(`Assistant` / `Autonomous`),因为:

- `Personal` 这个词承载"专属于某人"的关键语义 —— 跟 `Autonomous`(对团队负责)的差异是**身份关系层面**,不是行为层面
- 全称跟 first-tree roadmap / member 角色定义中的反复用法保持一致

### Visibility 命名

| schema | UI label |
|---|---|
| `private` | `Private` |
| `organization` | `Shared` |

`Visibility` 列名保留(GitHub repo 同款),值改友好化("Shared" 比 "organization" 更口语)。

### `Owner` → `Managed by`

`agents.managerId` 字段在 UI 上之前显示为 "Owner"。改为 "Managed by",原因:

- admin 可以**重新指派** agent manager —— "Owner" 暗示永久所属,语义不准
- "Managed by" 更直接表达"这个人能改这只 agent"

## 决策:视觉语言扁平化

跟 chat-first workspace 一致,/team 也走克制现代风:

- **Panel 边框移除** —— Members / Agents 表直接坐在页面上
- **PageHeader 去 bg-fill 和 border-bottom** —— 标题靠字号区分层级,不靠灰条
- **DenseTable 表头 sentence-case** —— 不再 mono uppercase
- **Type / Visibility / Role 改纯文字**(去 DenseBadge)—— 文字本身的"Admin / Personal assistant / Private"已含信号,不需要色块
- **Status 保留 StateChip** —— 实时变化(working / offline)需要可扫描的色 dot

## 决策:Admin 高频动作的入口位置

### `+ Invite link` 在 PageHeader 右侧(admin only)

短期内 invite 功能简单(生成链接 + 复制),不放进 Team settings —— "改 org 配置"是低频(年级别),"邀请人"是高频(团队增长期周级别),频率不同应对应深浅不同的入口。

未来 invite 扩展为复杂面板(history / 邀请角色控制 / 链接 rotation 等)时,再考虑迁入 Team settings。

### `+ New agent` 在 Agents section 右侧

跟 GitHub / Linear 等 SaaS 一致 —— section 级 action 放 section header 右。

## 决策:Members 表中 admin 的 self-delete 防护

admin 看 Members 时,自己那行**不渲染 Delete 按钮**(Edit 仍渲染,以便改自己 displayName 等)。

避免只靠 `window.confirm` 的弱保护造成 admin 失手把自己删掉(role 降级有"最后一个 admin"服务器端保护,但 delete 没有同等保护)。

## 决策:Members 表 legacy 路径清理

下面这些产物在本 PR 中删除:

- 用 username/password 直接创建 member 的 dialog —— 跟 invite link 流程功能重复,且经过 d41e528(decouple client from organization)之后该路径在产品上已不再推荐
- 前端 `createMember` API client —— 没有 caller 后清理
- `/membership` 路由 + `MembershipPage` / `MembershipPanel` —— 已无人引用
- `pages/agents.tsx`(594 LOC)—— `/agents` 顶级路由变 redirect 后该文件无人引用

## 信息架构总览

```text
顶 nav
├─ Workspace            chat-centric collaboration
├─ Context              tree visualization(占位,#101)
├─ Team
│  ├─ /team(默认)
│  │  ├─ PageHeader     "Team / 1 human and 2 agents working together"
│  │  │                 + admin: [Invite link] popover
│  │  ├─ Humans 区
│  │  │  └─ table       Display name | Username | Role | Created | (admin: Edit/Delete)
│  │  └─ Agents 区      + [+ New agent]
│  │     └─ table       Display name | Agent name | Type | Managed by | Visibility | Status | Created
│  └─ /team/settings   admin only(Team identity + System configuration)
└─ Settings
   ├─ /settings/computers
   └─ /settings/integrations
```

## 跨产品共识

- Workspace(#99 chat-first-workspace)和 Team 在 IA 上承担不同角色:
  - **Workspace = 协作面**(在 chat 里跟 actors 一起干活)
  - **Team = 名册面**(看 / 管这些 actors 是谁)
- 两者的人 + agent 视觉处理保持 alignment(都把 humans 和 agents 视觉上区分开,但承认它们都是团队一员)。

## 后续工作

下面这些不在本 PR 范围内,作为独立 issue 推进:

- agent-team-foundation/first-tree-all#99 — Workspace chat-centric refactor(其设计已有 doc:`docs/chat-first-workspace-product-design.zh-CN.md`)
- agent-team-foundation/first-tree-all#101 — Context-tree visualization(`/context` 当前是占位页)
- agent-team-foundation/first-tree-all#103 — Seamless group chat(humans + agents 双向初始化)
- agent-team-foundation/first-tree-all#106 — Task primitive + chat-driven creation
- 邀请管理(pending invites / history / link rotation)等高级面板:扩展 `/team/settings` 子区
- Members 表面向 non-admin 的 read-only 模式精化(目前隐藏了 actions,空状态文案分流,但 Edit dialog 仍按 admin 假设构建)
