# Context Tab 产品设计

## 状态

设计草案。对应需求:

- [agent-team-foundation/first-tree-all#101](https://github.com/agent-team-foundation/first-tree-all/issues/101) — user-facing context-tree visualization
- 依赖上游导航重构: [agent-team-foundation/first-tree-all#100](https://github.com/agent-team-foundation/first-tree-all/issues/100)

## 核心判断

Context Tree 的第一用户是 **agent**。它不是普通文档库,而是 agent 用来理解团队边界、决策背景、owner 和跨域关系的团队认知层。

First Tree Hub 的 `/context` 不是要把 Context Tree 改造成 human wiki,而是做 **agent context radar**:

> 把后台被 agents 使用的 Context Tree,转化成 human/operator 可感知的同步、结构、变化和责任信号。

本需求的产品使命有两个:

- **Operational**:让 operator 知道 agents 用于判断和行动的 context 是否可用、是否新鲜、哪里变了、谁负责。
- **Perception**:让用户感知 First Tree 的核心价值不是 markdown 文件,而是 agents 会读取、用于判断和行动的团队认知树。

## 当前范围

本需求只做四层信号,其中前三层是核心交互,第一层是首屏感知:

| 信号 | 回答的问题 | 当前表达 |
| --- | --- | --- |
| Usage signal | 这棵树是否已被 Hub 同步,并可作为 agents 判断和行动的 context? | Header 显示 snapshot active / stale / unavailable |
| Freshness signal | agents 用于判断和行动的 context 自上次查看后有没有变化? | 变化数量和 added / edited / removed 统计 |
| Structure signal | 变化在 agent 可导航的团队认知结构里哪里? | 默认 Tree Map,domain/subdomain 聚合变化 |
| Accountability signal | 这个变化该找谁、和哪些上下文有关? | Node Detail 显示 owners、path、links、preview |

不做:

- Context Tree 编辑器。
- 通用 graph database 浏览器。
- 默认展示全量 `soft_links` 网络。
- 跨设备 last-seen 同步。
- per-agent commit readiness 或真实读取 telemetry。
- 替代 GitHub PR review / CODEOWNERS / First Tree 写入流程。

## 用户故事

### Story 1: 感知 Context Tree 正在作为 agent context 可用

作为 First Tree Hub 用户,我打开 `/context` 时,想看到 Context Tree snapshot 是否已同步并可用,这样我能理解 agents 不是只靠零散 prompt,而是在读取一棵团队认知树来判断和行动。

验收标准:

- 首屏显示 `Team context active` / `Snapshot stale` / `Snapshot unavailable`。
- 显示 repo branch、head commit、最近同步时间。
- 本需求不暗示每个 agent 实际加载了哪个 commit。

### Story 2: 看到自上次查看后的 agent context 变化

作为 human/operator,我想看到自上次查看后 Context Tree 发生了多少变化,这样我知道 agents 用于判断和行动的上下文是否出现了需要关注的新变化。

验收标准:

- 显示 `changes since your last view`。
- 分开显示 added / edited / removed。
- 支持 `Mark all seen`,把当前 head commit 写入本地 last-seen baseline。

### Story 3: 在树结构中定位变化

作为 human/operator,我想在树图上看到变化分布在哪些 domain / subdomain,这样我不用从文件路径或 commit log 推断它属于 agent 将读取的哪块团队认知。

验收标准:

- 默认进入 `Map` 视图。
- changed nodes 在 Tree Map 上高亮。
- ancestor/domain 节点聚合子树变化数量。

### Story 4: 判断变化是否需要我介入

作为 human/operator,我点击变化节点时,想看到 owner、path、变化类型、关联节点和内容预览,这样我可以判断是否相关,以及该找谁确认。

验收标准:

- 右侧 Node Detail 随选中节点更新。
- 显示 title、owners、path、change type、related links、preview。
- changed node 显示最近变化 commit / 时间。
- removed node 显示 previous path 和 removed 状态。

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

### Hub 是只读消费者

Hub 只消费 Context Tree snapshot,不写入 Context Tree。编辑、review、owner approval 仍走 Git-native tree repo / PR / CODEOWNERS 流程。

## UI 方案

### 页面结构

```text
Context
Team context active · snapshot synced 18m ago
12 changes since your last view · main@9e664e
                                      [Map] [Files] [Mark all seen]

┌──────────────────────────────────────────────┬───────────────────────┐
│ Tree Map                                     │ Node Detail           │
│                                              │                       │
│ root                                         │ web-console           │
│ ├─ agent-hub                     4 changes   │ Edited since last view│
│ │  ├─ web-console                edited      │ Owners                │
│ │  ├─ breeze                     added       │ baixiaohang,yuezengwu │
│ │  └─ messaging                              │ Path                  │
│ ├─ first-tree-skill-cli          2 changes   │ agent-hub/web-...     │
│ └─ kael                          no change   │ Related               │
└──────────────────────────────────────────────┴───────────────────────┘
```

`Map` 是默认视图。`Files` 保留文件浏览,但只是辅助视角。

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
- 该找谁或看哪里?

内容:

```text
web-console
Edited since your last view

Path
agent-hub/web-console.md

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
2. Header 显示 usage signal:`Team context active · snapshot synced 18m ago`。
3. Header 显示 freshness signal:`12 changes since your last view`。
4. Map 展示整棵树并高亮 changed nodes。
5. 默认选中最近 changed node,右侧显示 Node Detail。
6. 用户点击 `Mark all seen`,当前 head commit 写入 last-seen baseline。

### 无变化

```text
Team context active · snapshot synced 18m ago
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

### Snapshot DTO

```text
ContextTreeSnapshot
├─ repo
├─ branch
├─ headCommit
├─ syncedAt
├─ snapshotStatus: active | stale | unavailable
├─ usageSignal
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
usageSignal
├─ label: Team context active | Snapshot stale | Snapshot unavailable
├─ detail
└─ severity: ok | warning | error
```

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
