# Context Tab 产品设计

## 状态

设计草案。对应需求:

- [agent-team-foundation/first-tree-all#101](https://github.com/agent-team-foundation/first-tree-all/issues/101) — user-facing context-tree visualization
- 依赖上游导航重构: [agent-team-foundation/first-tree-all#100](https://github.com/agent-team-foundation/first-tree-all/issues/100)
- 推荐方案 V2: [context-tab-product-design-v2.zh-CN.md](context-tab-product-design-v2.zh-CN.md)
- 实现计划: [context-tab-implementation-plan.zh-CN.md](context-tab-implementation-plan.zh-CN.md)

## 核心判断

Context Tree 的第一用户是 **agent**。它不是普通文档库,而是 agents 用来理解团队边界、决策背景、owner 和跨域关系的团队认知层。

First Tree Hub 的 `/context` 要让这层后台能力变成可感知的产品体验:

> 用户应该明确感知到:agents 的判断和行动背后,有一棵正在被维护、正在生长、可以被治理的团队认知树。

因此 `/context` 不是 human wiki,也不是纯文件浏览器。它是 **agent context radar**:把 agents 使用的 Context Tree 转译成 human/operator 能理解的结构、变化和责任信号。

一句话方案:

> 在 Hub 里提供一张 Agent Context Map,让用户看到 agents 背后的团队认知树当前是否可用、最近如何生长、变化影响哪块决策上下文、以及该由谁治理。

## 用户应形成的认知

用户打开 `/context` 后,应该形成三个判断:

1. **Agents are grounded**  
   agents 不是只靠零散 prompt 工作,而是有一个团队维护的 context source。

2. **Team context is alive**  
   这棵树会随团队工作持续生长,并改变 agents 用于判断和行动的上下文。

3. **Agent decisions are shaped by the tree**  
   Context Tree 的变化不是孤立文档变化,而是会进入 agents 的工作上下文,影响后续判断、协作请求和执行取舍。

4. **I can govern it**  
   如果某个 context 变化影响团队决策、agent 行动或跨域协作,我能看到它在哪里、谁负责、和哪些上下文有关。

## 核心场景排序

| 优先级 | 场景 | 用户价值 | 本需求表达 |
| --- | --- | --- | --- |
| P0 | 建立对 agent 判断来源的信任 | 用户知道 agents 不是黑盒执行,而是依赖一棵团队维护的 Context Tree | 首屏 Header 表达 context snapshot 可用性和同步状态 |
| P0 | 感知团队认知树正在生长 | 用户看到 tree 的变化会持续影响 agents 的理解、判断和行动 | `changes since your last view`、added / edited / removed |
| P0 | 感知 tree 正在影响 agent 决策 | 用户理解 tree 不是给人看的 markdown,而是 agents 的决策上下文来源 | 文案、Story、Node Detail 都围绕 agent context / decision impact 表达 |
| P0 | 判断变化影响的知识区域 | 用户能把变化放回 agent 可导航的团队知识版图里 | 默认 Tree Map,domain/subdomain 聚合变化 |
| P1 | 从变化进入治理动作 | 用户能找到 owner、关联节点和内容线索,判断是否需要确认或介入 | Node Detail 显示 owners、path、links、preview |
| P2 | 精确看到每个 agent 是否已使用最新 context | 用户能判断某些 agent 的行动是否落后于最新团队认知 | 属于正确方向,但需要 per-agent readiness / usage telemetry |

这里的关键判断是: **agent 使用感知属于本需求的核心价值,但当前只能先做 snapshot-level 的产品表达**。如果没有这个表达,`/context` 会退化成文件 diff 浏览器;如果没有 telemetry 就展示 agent count,又会让 UI 承诺不存在的数据。

## 体验目标

| 目标 | 用户问题 | 设计表达 |
| --- | --- | --- |
| Context source visible | agents 背后的 context source 是否可用? | Header 显示 Team context current / stale / unavailable |
| Growth visible | 这棵团队认知树最近如何生长? | added / edited / removed 变化统计 |
| Decision impact visible | tree 如何影响 agents 后续判断和行动? | Header / Map / Node Detail 使用 agent context 和 decision impact 叙事 |
| Structure visible | 变化发生在 agent 可导航的知识版图哪里? | 默认 Tree Map,domain/subdomain 聚合变化 |
| Governance visible | 这个变化该找谁、会连到哪些上下文? | Node Detail 显示 owners、path、links、preview |

## 用户故事

### Story 1: 看到 agents 的判断来源

作为 First Tree Hub 用户,当我看到 agent 的输出、协作请求或执行结果时,我希望能在 `/context` 看到它背后依赖的是一棵已同步的团队认知树,从而理解 agent 的判断来源不是黑盒。

验收标准:

- 产品文案优先使用 `Team context is current` / `Team context needs attention` / `Team context unavailable`。
- 显示 repo branch、head commit、最近同步时间。
- 文案表达的是 context source 可用性,不暗示每个 agent 已实际加载该 commit。

### Story 2: 看到团队认知树正在生长

作为 human/operator,我希望看到自上次查看后 Context Tree 新增、修改、删除了哪些内容,从而感知团队认知不是静态文档,而是在持续影响 agents 的判断和行动。

验收标准:

- 显示 `changes since your last view`。
- 分开显示 added / edited / removed。
- 支持 `Mark all seen`,把当前 head commit 写入本地 last-seen baseline。

### Story 3: 理解变化影响哪块 agent context

作为 human/operator,我希望在树图上看到变化分布在哪些 domain / subdomain,从而判断这些变化会影响 agents 对哪块团队知识的理解,以及可能影响哪些后续协作判断。

验收标准:

- 默认进入 `Map` 视图。
- changed nodes 在 Tree Map 上高亮。
- ancestor/domain 节点聚合子树变化数量。

### Story 4: 感知 tree 正在影响 agent 决策

作为 human/operator,我希望 `/context` 明确表达 Context Tree 是 agents 的决策上下文来源,而不只是 markdown 文件集合。这样当我看到某个节点变化时,能理解它可能改变 agents 后续如何判断 owner、边界、协作路径和执行取舍。

验收标准:

- 页面核心文案使用 `team context` / `agent context` / `decision context` 语义,避免把页面描述成 file browser。
- Node Detail 对 changed node 显示“可能影响的 context area”,例如 domain、parent path、related links。
- 当前版本不声称某个具体 agent 已读取该节点;只表达“这份 snapshot 是 agents 可使用的 context source”。

### Story 5: 从变化进入治理动作

作为 human/operator,当某个 context 变化可能影响团队决策、agent 行动或跨域协作时,我希望点击节点就能看到 owner、path、关联节点和内容预览,从而判断是否需要介入、找谁确认、以及这个变化连接到哪些上下文。

验收标准:

- 右侧 Node Detail 随选中节点更新。
- 显示 title、owners、path、change type、related links、preview。
- changed node 显示最近变化 commit / 时间。
- removed node 显示 previous path 和 removed 状态。

## 本需求交付什么

本需求交付的是 **让用户感知 agents 背后的团队认知树**。当前实现用 snapshot-level context visibility 完成这个目标:

- **Context source**:Hub 已经拿到哪份 Context Tree snapshot,这份 snapshot 是否可作为 agents 的团队上下文来源。
- **Context growth**:这份 agent context 自上次查看后新增、修改、删除了什么。
- **Context map**:变化在树结构中的位置,以及归属哪个 domain / subdomain。
- **Context governance**:每个变化节点的 owner、关联节点和内容线索。

本需求暂不做以下能力,避免偏离“感知和理解”这个核心体验:

- Context Tree 编辑器。
- 通用 graph database 浏览器。
- 默认展示全量 `soft_links` 网络。
- 跨设备 last-seen 同步。
- 替代 GitHub PR review / CODEOWNERS / First Tree 写入流程。
- per-agent readiness 的精确计数和真实读取 telemetry。

`8 agents using latest context` / `3 agents behind latest context` 这类表达不是错误方向,反而是后续更完整的目标体验:它能直接回答“哪些 agent 已经基于最新团队认知行动”。但它需要新的 per-agent readiness / usage telemetry,例如 agent 当前加载的 context commit、session 注入记录或读取记录。当前没有可靠数据前,UI 只表达 snapshot 可用性和 tree growth,并在数据模型上预留 readiness 扩展。

## 产品模型

### 同一棵树,不同的未读变化层

所有 human/operator 看到同一棵 Context Tree:

- 节点结构、owners、links、preview 来自同一个 tree repo snapshot。
- 当前 branch / commit 对所有人一致。

不同 human/operator 看到不同的变化高亮:

- `last seen commit` 是个人 baseline。
- 当前用浏览器本地存储:

```text
first-tree-hub:context:lastSeenCommit:<repo>:<branch>
```

后续如果需要跨设备一致,再升级为 server-side user preference。

### 本 tab 是只读感知面

本 tab 只消费 Context Tree snapshot,不在页面内写入 Context Tree。编辑、review、owner approval 仍走 Git-native tree repo / PR / CODEOWNERS 流程。

这不否定 Hub 与 Context Tree 后续更深的 authoring integration。这里的边界只是:本需求先解决“用户能否感知 agents 背后的团队认知树”,不把可视化页扩展成 Tree 编辑器。

## UI 方案

### 页面结构

```text
Context
Team context is current
Agents have a synced decision context from Context Tree · main@9e664e

12 changes since your last view
Added 3 · Edited 8 · Removed 1                 [Map] [Files] [Mark all seen]

┌──────────────────────────────────────────────┬───────────────────────┐
│ Tree Map                                     │ Node Detail           │
│                                              │                       │
│ root                                         │ web-console           │
│ ├─ agent-hub                     4 changes   │ Decision context      │
│ │  ├─ web-console                edited      │ Owners                │
│ │  ├─ breeze                     added       │ baixiaohang,yuezengwu │
│ │  └─ messaging                              │ Path                  │
│ ├─ first-tree-skill-cli          2 changes   │ agent-hub/web-...     │
│ └─ kael                          no change   │ Related               │
└──────────────────────────────────────────────┴───────────────────────┘
```

`Map` 是默认视图。`Files` 保留文件浏览,但只是辅助视角。

页面结构分四层:

| 区域 | 作用 | 必须表达 |
| --- | --- | --- |
| Context Signal | 建立“agents 背后有团队认知树”的感知 | `Team context is current` 和 synced/stale/unavailable 状态 |
| Decision Context Line | 明确 tree 与 agent 决策的关系 | `Agents have a synced decision context from Context Tree` |
| Change Summary | 让用户感知 tree 正在生长 | changes since last view、added / edited / removed |
| Map + Detail | 把变化落到结构和治理动作 | changed nodes、affected domain、owners、related context |

Header 承担本需求最重要的产品表达:用户一进入页面,先看到“agents 背后的 Context Tree snapshot 已经被 Hub 同步 / 已过期 / 不可用”,再看到“这棵团队认知树自上次查看后如何变化”。它不是单纯报 commit,而是在建立 agent context source 的存在感。

推荐文案:

```text
Team context is current
Agents have a synced decision context from Context Tree · main@9e664e
12 changes since your last view
```

异常时:

```text
Team context needs attention
Agents may be working from stale team context · last synced 2h ago
12 changes at head
```

等有 per-agent readiness / usage telemetry 后,Header 再升级为:

```text
Team context is current
8 agents using latest context · 12 changes since your last view
```

当前不展示 agent count,但页面的叙事必须始终围绕 agents 背后的团队认知树,而不是围绕 markdown 文件本身。

### Tree Map

使用稳定 hierarchical tree,不使用 force-directed graph。原因:

- Context Tree 的主关系是目录父子结构。
- 用户要回答的是“agent context 变化在哪里”,稳定布局比漂移布局更容易理解。
- 当前树规模约百级 markdown 文件,React + SVG 足够。

渲染规则:

| 类型 | 表达 |
| --- | --- |
| root/domain | 结构锚点,可显示子树变化计数 |
| subdomain | 中间层节点 |
| leaf markdown | 小节点 |
| unchanged | 低对比结构背景 |
| selected | 高对比描边 |
| added | 绿色边框 / `+` |
| edited | 琥珀色点 / 高亮描边 |
| removed | 红色虚线 ghost node |

`soft_links` 和 markdown links 默认不全量展示,只在选中节点时强调相关连接,避免把树图变成杂乱网络。

### Node Detail

Node Detail 回答三个问题:

- 这个节点是什么?
- 为什么被高亮?
- 这个变化可能影响哪块 agent decision context?
- 该找谁或看哪里?

内容:

```text
web-console
Decision context changed

Path
agent-hub/web-console.md

Affected context area
agent-hub / web console / workspace decisions

Owners
baixiaohang, yuezengwu

Last change
9e664e7 · 18 minutes ago

Related
agent-hub/product-direction.md
agent-hub/cli.md

Preview
Browser-based workstation for Agent Hub...
```

removed node 显示 previous path 和 removed commit/time。底部可提供 `Open in Files`。

### Files View

Files view 使用同一份 snapshot 和 change state:

```text
agent-hub/
  NODE.md
  web-console.md       ~ edited
  breeze.md            + added
```

它回答“在 repo 文件结构哪里”,不替代 Map。

## 状态流程

### 有变化

1. human/operator 进入 `/context`。
2. Header 显示 context source signal:`Team context is current`。
3. Header 显示 freshness signal:`12 changes since your last view`。
4. Map 展示整棵树并高亮 changed nodes。
5. 默认选中最近 changed node,右侧显示 Node Detail。
6. 用户点击 `Mark all seen`,当前 head commit 写入 last-seen baseline。

### 无变化

```text
Team context is current
No changes since your last view · main@9e664e
```

Map 仍展示,但没有强高亮。

### 未配置 / 不可用

未配置:

```text
Context Tree is not configured
Connect a tree repo in server config to show team context here.
```

同步失败:

```text
Snapshot unavailable
Last successful sync: yesterday 16:20
```

如果有上一次成功 snapshot,优先展示 stale snapshot 并明确标记 stale。

## 数据与 API

Hub Server 提供只读 snapshot projection:把 Git-native Context Tree repo 投射成 Web DTO。Web 不依赖用户本机 client clone。

建议当前 API:

```text
GET /api/v1/context-tree/snapshot?since=<commit>
```

这是 Hub-specific read model,不是 Context Tree 本体已有或必须新增的 core API。同步行为优先作为 Server 内部能力:

- server start refresh;
- 定时 refresh;
- snapshot 过期时 opportunistic refresh;
- sync 失败时返回 stale snapshot + error state。

约束:

- 该 endpoint 需要 Hub member JWT,不能像 `/context-tree/info` 一样 public。
- Hub Server 必须具备读取 configured Context Tree repo 的权限;私有 repo 需要 GitHub token、GitHub App installation、SSH deploy key 或运行环境 git credentials。
- 如果 Server 无法读取 tree repo,UI 进入 unavailable / stale 状态,不能回退到浏览器直接访问 GitHub API。

### Snapshot DTO

```text
ContextTreeSnapshot
├─ repo
├─ branch
├─ headCommit
├─ syncedAt
├─ snapshotStatus: active | stale | unavailable
├─ contextSourceSignal
├─ nodes[]
├─ edges[]
└─ changes[]
```

```text
ContextTreeNode
├─ id
├─ path
├─ title
├─ kind: root | domain | subdomain | leaf
├─ owners[]
├─ parentId
├─ preview
├─ changeType?: added | edited | removed
└─ changedAtCommit?
```

```text
ContextTreeEdge
├─ source
├─ target
└─ kind: parent | soft_link | markdown_link
```

```text
contextSourceSignal
├─ label: Team context is current | Team context needs attention | Team context unavailable
├─ detail
└─ severity: ok | warning | error
```

当前 context source signal 先说明 Hub Server 是否有可用 Context Tree snapshot。后续 readiness 信号需要继续回答:

- 每个 agent 是否使用了最新 context commit;
- 有多少 agents 已同步到最新 context;
- 某个 agent 在某次 session 中是否实际读取了某个节点。

这些属于后续 readiness / telemetry 设计。当前文案必须避免过度承诺。

### 变化计算

当前变化来源:

```text
git diff --name-status <lastSeenCommit>..HEAD -- '*.md'
```

映射:

- `A` -> added
- `M` -> edited
- `D` -> removed ghost node
- rename 可先视为 removed + added

首次访问没有 baseline 时,建议显示最近 N 个 commit 的变化,避免首屏空白。

## 后续

- 跨设备 last-seen 同步。
- 搜索 / filter by owner / filter by domain。
- 时间范围:`since last view` / `last 7 days` / `last release`。
- Context Tree 健康度:长期未维护区域、owner coverage、link density。
- Per-agent context readiness:各 agent 当前使用的 context commit 是否落后于 tree head。
- Usage telemetry:哪些 agents 最近同步过 Context Tree,哪些 session 注入了 context。
- 从 Workspace agent/session 跳转到相关 Context Tree 节点。
