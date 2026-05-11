# 面向用户的 Context Tree UI 产品设计

## 状态

推荐方案。对应需求:

- [agent-team-foundation/first-tree-all#101](https://github.com/agent-team-foundation/first-tree-all/issues/101) — user-facing context-tree visualization
- 依赖上游导航重构: [agent-team-foundation/first-tree-all#100](https://github.com/agent-team-foundation/first-tree-all/issues/100)
- 技术方案: [user-facing-context-tree-ui-technical-plan.zh-CN.md](user-facing-context-tree-ui-technical-plan.zh-CN.md)

## 核心判断

Context Tree 的第一用户是 **agent**。面向用户的 Context Tree UI 的第一任务不是让 human 浏览一棵树,而是让 human/operator 感知:

- agents 的判断不是黑盒,背后有 team context source;
- 这份 context 正在随团队工作生长;
- 某些变化会影响 agents 后续如何判断 owner、边界、协作路径和执行取舍;
- 如果影响值得关注,用户能找到 owner 和相关 context。

一句话方案:

> 在 Hub 中提供一个面向用户的 Context Updates surface,让用户优先看到 Context Tree 最近如何生长、哪些变化可能被 agents 用来判断和行动,再通过 Where Context Changed 理解变化在团队认知树中的集中位置。

## 设计原则

1. **Updates-first, not map-first**
   用户第一眼应该看到“哪些变化可能影响 agent decision context”,而不是先看到一张 tree map。

2. **Agent-context-first, not document-first**  
   页面不把 markdown 文件作为主对象,而是把文件变化转译成 agent context source、context updates、owner 和 related context。

3. **Updates before proof**
   当前可以表达“这份 team context 可供 agents 使用”和“变化可能影响 agent 判断”。在没有 runtime telemetry 前,不能声称某个具体 agent 已经读取某个节点。

4. **Map as proof**
   Where Context Changed 保留全局态势和结构证明职责,不是当前 update detail,也不是主解释器。

5. **Read-only, permanently**
   这个 UI 永远不做 Context Tree 编辑。它只负责让用户感知、理解、定位和治理 Context Tree 的影响;Context Tree 的写入、review、owner approval 继续通过 Git-native repo、PR、CODEOWNERS 和 `first-tree` 工具完成。

6. **Mature components first**
   尽可能使用 First Tree Hub 现有 UI primitives 和成熟开源库,不要从零构建通用组件、树布局、markdown 渲染或基础交互。自研部分应该集中在 Context Tree snapshot 到 Context Updates 的产品语义转译。

## 长期边界

面向用户的 Context Tree UI 是只读的 perception / governance surface,不是 authoring surface。

它可以提供:

- context snapshot 可用性和 freshness;
- tree growth 和 Context Updates;
- owner、related context、source file / commit;
- 跳转到 repo、PR、Obsidian 或其他深看工具。

它永远不提供:

- 在 Hub 页面内创建、修改、删除 Context Tree 节点;
- markdown 在线编辑器;
- 在 Hub 页面内直接提交 Context Tree 变更;
- 绕过 Context Tree repo 的 PR / CODEOWNERS / owner approval 流程。

这个边界是产品原则,不是阶段性范围控制。原因是 Context Tree 的可信度来自 Git-native review、ownership 和可追溯历史;如果把编辑搬进 Hub UI,会削弱这套治理模型,也会把本页面从“让用户感知 agents 背后的团队认知树”带偏成文档管理工具。

## 体验目标

| 目标 | 用户问题 | 设计表达 |
| --- | --- | --- |
| Context source visible | agents 背后的 team context 是否可用? | Header 显示 current / stale / unavailable |
| Growth visible | Context Tree 最近如何生长? | Change summary: added / edited / removed |
| Context updates visible | 哪些变化可能影响 agent 判断和行动? | Context Updates 作为主内容 |
| Structure visible | 这些变化集中在树的哪里? | Where Context Changed 作为全局态势 |
| Governance visible | 该找谁、看哪些相关 context? | Selected Change |

## 页面结构

首屏结构:

```text
Context
Context Tree is up to date
Source: main @ 9e664e
Agents have a synced team context snapshot available.

12 context updates in the last 7 days
Added 3 · Edited 8 · Removed 1                 [1 day] [7 days] [30 days]

┌──────────────────────────────────────┬─────────────────────────────────┐
│ Context Updates                      │ Selected Change                 │
│ 12 team context changes agents may   │ What changed                    │
│ use                                  │ What agents can use             │
│                                      │                                 │
│ [Updated] liuchao updated Web       │ Web Console                     │
│ Console                             │ In Agent Hub / Web Console      │
│ In Agent Hub / Web Console           │ What changed                    │
│ Owner: baixiaohang · 2 linked ctxs    │ liuchao updated Web Console...  │
│                                      │ Agents can use updated team      │
│                                      │ knowledge when working on...     │
│                                      │                                 │
│ [added] Breeze delivery              │ What agents can use             │
│ In Agent Hub / Breeze                │ Agents can use new team...       │
│                                      │                                 │
│                                      │ Linked context / Source         │
└──────────────────────────────────────┴─────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ Where Context Changed                                                  │
│ Numbers = updated areas under each branch                              │
│ Selected Context Tree / Agent Hub / Web Console                        │
│ Selected path · Changed branch · Quiet / hidden                        │
│ root                                                                   │
│ ├─ agent-hub       4                                                    │
│ │  ├─ web-console   ~                                                   │
│ │  ├─ breeze        +                                                   │
│ └─ first-tree...   2                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

页面分区:

- **Context Status**:团队认知树是否可用、是否新鲜。
- **Change Summary**:自上次查看后 tree 如何生长。
- **Context Updates**:主区域,展示最近哪些团队知识发生了变化;每张卡片只展示稳定、可扫读的关键信息:变更类型、谁更新了哪块知识、tree 位置、owner、linked context 数量。
- **Selected Change**:紧贴当前选中 update,分成“这次改了什么”和“agents 能用什么”,再展示 owner、linked context、source。
- **Where Context Changed**:第二屏全宽辅助区域,展示变化在树上的集中位置和整体结构。

## 主区域: Context Updates

Context Updates 按“最近哪些团队知识发生了变化”组织,不是按文件路径简单排序。

每张 Update Card 显示:

```text
[Updated] liuchao updated Web Console
In Agent Hub / Web Console
Owner: baixiaohang · 2 linked contexts
```

列表不是文档目录,而是 context update queue。卡片应短、可扫读、可滚动;主句采用稳定的“谁更新了哪块知识”形式,完整 tree 位置单独放到下一行。

当前版本不引入 Context Tree 自身的 `change_summary` metadata,也不从 diff 行里抽半句作为标题。若 commit subject 足够具体,只在右侧 Selected Change 的 `What changed` 中作为补充展示;否则使用稳定 activity 句式。

排序建议:

1. 具体 leaf / subdomain 优先于 root / domain,避免抽象节点占据首屏;
2. 同一层级内,removed / added / edited 按风险和可见性排序;
3. 有 owners 的节点优先;
4. linked contexts 多的节点优先;
5. 最近 commit 优先。

当前版本的 `What agents can use` 是基于 tree structure 和 metadata 的产品化推断,不是 runtime telemetry。它不能声称“某个具体 agent 已经读取该节点”。

## Where Context Changed

Where Context Changed 是全局态势视图,不是当前 update detail,也不是主体验。它表达的是“最近 context 变化集中在哪些 branch”,而不是让用户浏览完整知识图谱。

规则:

- 标题使用 `Where Context Changed`,不使用泛泛的 `Context Tree Overview`。
- 副标题明确数字语义:`Numbers = updated areas under each branch.`
- 图上方必须轻量显示当前 selected path,例如 `Selected Context Tree / Agent Hub / Web Console`。
- 图上方必须显示轻量 legend:`Selected path` / `Changed branch` / `Quiet / hidden`,避免用户猜颜色,但不能做成占注意力的说明 banner。
- 默认展示语义压缩后的全貌,而不是全量展开的 tree canvas。
- 默认节点层级只保留 root、一级 domain、二级重点 domain、最近有变化的 branch,以及当前 selected update 的 ancestor path。
- 未展开区域折叠成聚合节点,例如 `6 hidden · 2 updated` 或 `1 hidden quiet`,让用户知道这里有内容但当前不是重点。
- changed domain / branch 显示贴近节点的聚合计数,不把 count 漂到画布最右侧。
- 选中 Update Card 时,Overview 展开并高亮对应节点和 ancestor path,其他 branch 降权。
- 点击有直接 update 的节点时,选中对应 Update Card;点击聚合 domain 时,只高亮 / focus 该 domain,不改变当前 Selected Change。
- 全量 tree exploration 只能作为显式操作进入,不能作为默认态。
- `soft_links` 不默认画成全图网络,只在 detail 中展示。

这样保留 Context Tree 的空间感,但不会让用户误以为核心价值是“浏览 graph”。Overview 的第一眼应该回答“这棵团队认知树大概长什么样、最近变化集中在哪里”,而不是让用户在全量节点图里横向滚动找位置。

默认态示意:

```text
Context Tree
├─ Agent Hub        6 updates
│  ├─ Web Console   2
│  ├─ Breeze        1
│  └─ +5 quiet areas
├─ Kael             19 updates
│  ├─ Platform      15
│  ├─ Chat          2
│  └─ +7 quiet areas
├─ First Tree       4 updates
└─ Members          2 updates
```

选中态示意:

```text
Context Tree
└─ Kael             19
   └─ Platform      15
      └─ Authentication 15
         ├─ OAuth Provider for Agent Hub
         └─ +5 related leaf nodes

Agent Hub / First Tree / Members remain visible but muted.
```

## Selected Change

Selected Change 回答五个问题:

- 这个变化是什么?
- 它可能影响哪块 agent decision context?
- 相关 context 有哪些?
- owner 是谁?
- 源文件和 commit 在哪里,必要时展开 source preview。

示例:

```text
Web Console
In Agent Hub / Web Console

What changed
liuchao updated Web Console: clarified runtime setup

What agents can use
Agents can use updated team knowledge when working on agent-hub / web console.

Owner
baixiaohang

Linked context
agent-hub/product-direction.md
agent-hub/cli.md

Source
agent-hub/web-console.md · 9e664e7
[Preview source] [Copy path]
```

## 状态文案

当前有 snapshot:

```text
Context Tree is up to date
Source: main @ 9e664e
Agents have a synced team context snapshot available.
```

后续有 stale snapshot:

```text
Context Tree needs attention
Agents may be working from stale team context · last synced 2h ago
```

没有可用 snapshot:

```text
Context Tree sync unavailable
Hub cannot read the team Context Tree yet. Agents and users will see context here after the server can sync the configured repo.
```

不可用态只显示单一 setup / sync state,不显示 update count、Added / Edited / Removed 或时间窗口。原因是这时系统没有可读 snapshot,不能把它表达成“0 个更新”。

等有 per-agent readiness telemetry 后,Header 才升级为:

```text
Context Tree is up to date
8 agents using latest context · 12 updates in the last 7 days
```

## 数据模型

`nodes[]` / `edges[]` 用于 Context Tree Overview 和 source preview。`updates[]` 用于 Context Updates,避免前端临时从 node diff 推断产品语义。

```text
ContextTreeSnapshot
├─ repo
├─ branch
├─ headCommit
├─ syncedAt
├─ snapshotStatus
├─ contextStatus
├─ summary
├─ updates[]
├─ nodes[]
├─ edges[]
└─ changes[]
```

```text
ContextTreeUpdate
├─ id
├─ nodeId?
├─ path
├─ title
├─ changeType: added | edited | removed
├─ affectedContextArea
├─ reason
├─ summary
├─ changedBy
├─ owners[]
├─ relatedNodeIds[]
├─ sourceCommit
└─ riskLevel?: low | medium | high
```

`reason` 当前由结构和 metadata 生成,例如:

- domain / parent path;
- title;
- owners;
- soft_links;
- markdown links;
- changed node 是否为 `NODE.md`。

后续如果接入 session telemetry,`ContextTreeUpdate` 可以增加:

```text
agentUsage
├─ agentsUsingLatestCount
├─ agentsBehindCount
└─ affectedSessionIds[]
```

## 实现顺序

1. **Server snapshot + updates API**
   先产出 `nodes[]`、`changes[]`、`updates[]`。Context Updates 不放到前端临时拼。

2. **Web Updates-first baseline**
   Header、Change Summary、Context Updates、Selected Change、source preview。此阶段即使没有 Where Context Changed,也能传达核心价值。

3. **Where Context Changed**
   用成熟的 `d3-hierarchy` 负责 tree layout,用 Hub 现有 UI primitives + React SVG 做 overview 渲染,并和 Context Updates 联动。

4. **Polish**
   time-window selector、stale/unavailable、removed risk group、Open in repo / optional Open in Obsidian。

## Obsidian 的位置

Obsidian 可以做辅助深看,不作为主实现。

原因:

- Obsidian 是 document-first / graph-first;
- 本设计是 updates-first / agent-context-first;
- Obsidian 不承担 Hub member JWT、org 权限、server snapshot、stale state、last-seen baseline;
- Obsidian 不能表达 per-agent readiness 或 session usage telemetry。

可以做:

- `Open in Obsidian`;
- source preview 交互参考;
- backlinks / outgoing links 的 detail 参考。

不做:

- 用 Obsidian plugin 承担 `/context` 主界面;
- 把 Hub `/context` 变成 vault viewer。

## 推荐结论

采用 Context Updates 方案。

这个方案更符合本需求目标:让用户感知 Context Tree 的价值,即 agents 背后有一棵正在生长、正在影响判断和行动、可以被治理的团队认知树。
