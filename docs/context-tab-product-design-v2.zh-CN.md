# Context Tab 产品设计 V2

## 状态

推荐方案。对应需求:

- [agent-team-foundation/first-tree-all#101](https://github.com/agent-team-foundation/first-tree-all/issues/101) — user-facing context-tree visualization
- 依赖上游导航重构: [agent-team-foundation/first-tree-all#100](https://github.com/agent-team-foundation/first-tree-all/issues/100)
- V1: [context-tab-product-design.zh-CN.md](context-tab-product-design.zh-CN.md)
- 实现计划: [context-tab-implementation-plan.zh-CN.md](context-tab-implementation-plan.zh-CN.md)

## 为什么需要 V2

V1 的方向是对的:不把 `/context` 做成 markdown file browser,而是表达 Context Tree 是 agents 背后的团队认知树。

但 V1 的信息架构仍然偏 **Map-first**。用户第一眼会看到 tree structure,容易把产品理解成“Context Tree viewer”。这不够强地传达本需求的核心价值:

> 用户需要先感知 Context Tree 如何影响 agents 的判断和行动,再需要地图去理解这些变化在树上的位置。

V2 把主体验改成 **Impact-first**:

- 先表达 agents 背后有一份 team context source。
- 再展示哪些 Context Tree 变化可能影响 agent decision context。
- 然后用 Tree Map 作为定位和空间理解工具。
- 最后进入 owner / related context / source file 的治理动作。

## 核心判断

Context Tree 的第一用户是 **agent**。Hub `/context` 的第一任务不是让 human 浏览一棵树,而是让 human/operator 感知:

- agents 的判断不是黑盒,背后有 team context source;
- 这份 context 正在随团队工作生长;
- 某些变化会影响 agents 后续如何判断 owner、边界、协作路径和执行取舍;
- 如果影响值得关注,用户能找到 owner 和相关 context。

一句话方案:

> 在 Hub 中提供一个 Agent Context Impact surface,让用户优先看到哪些 Context Tree 变化可能影响 agents 的判断和行动,再通过 Tree Map 理解变化在团队认知树中的位置。

## 体验目标

| 目标 | 用户问题 | V2 表达 |
| --- | --- | --- |
| Context source visible | agents 背后的 team context 是否可用? | Header 显示 current / stale / unavailable |
| Growth visible | Context Tree 最近如何生长? | Change summary: added / edited / removed |
| Decision impact visible | 哪些变化可能影响 agent 判断和行动? | Impact Feed 作为主内容 |
| Structure visible | 这些变化在树的哪里? | Tree Map Overview 作为辅助定位 |
| Governance visible | 该找谁、看哪些相关 context? | Impact Detail / Node Detail |

## 页面结构

V2 首屏结构:

```text
Context
Team context is current
A synced team context is available for agents · main@9e664e

12 changes since your last view
Added 3 · Edited 8 · Removed 1                 [Mark all seen]

┌──────────────────────────────────────────────┬─────────────────────────┐
│ Changes that may affect agent decisions      │ Tree Map Overview       │
│                                              │                         │
│ [edited] agent-hub / web-console             │ root                    │
│ May affect: workspace decisions,             │ ├─ agent-hub       4    │
│ agent operation UI                           │ │  ├─ web-console   ~   │
│ Owners: baixiaohang, yuezengwu               │ │  ├─ breeze        +   │
│ Related: product-direction, cli              │ └─ first-tree...   2    │
│                                              │                         │
│ [added] agent-hub / breeze                   │                         │
│ May affect: GitHub delivery surface          │                         │
└──────────────────────────────────────────────┴─────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ Impact Detail / Node Detail                                            │
│ Decision context changed                                               │
│ Affected context area: agent-hub / web console / workspace decisions   │
│ Source: agent-hub/web-console.md · 9e664e7                             │
└────────────────────────────────────────────────────────────────────────┘
```

V2 不是取消 Tree Map,而是改变它的职责:

- **Impact Feed** 是主解释器,回答“为什么这个变化值得看”。
- **Tree Map Overview** 是定位工具,回答“这个变化在团队认知树哪里”。
- **Files View** 是辅助深看,回答“源文件是什么”。

## 主区域: Impact Feed

Impact Feed 按“可能影响 agent decision context 的变化”组织,不是按文件路径简单排序。

每张 Impact Card 显示:

```text
[edited] agent-hub / web-console
May affect: workspace decisions, agent operation UI
Owners: baixiaohang, yuezengwu
Related: product-direction, cli
Source: agent-hub/web-console.md
```

排序建议:

1. changed domain 节点优先于普通 leaf;
2. 有 owners 的节点优先;
3. related links 多的节点优先;
4. 最近 commit 优先;
5. removed node 显示在独立风险组。

当前版本的 `May affect` 是基于 tree structure 和 metadata 的产品化推断,不是 runtime telemetry。它不能声称“某个具体 agent 已经读取该节点”。

## Tree Map Overview

Tree Map 在 V2 中是 overview,不是主体验。

规则:

- 默认展示整棵树或主要 domain。
- changed domain 显示聚合计数。
- 选中 Impact Card 时,Map 高亮对应节点和 ancestor path。
- 点击 Map 节点会筛选或选中对应 Impact Card。
- `soft_links` 不默认画成全图网络,只在 detail 中展示。

这样保留 Context Tree 的空间感,但不会让用户误以为核心价值是“浏览 graph”。

## Impact Detail

Impact Detail 回答五个问题:

- 这个变化是什么?
- 它可能影响哪块 agent decision context?
- 相关 context 有哪些?
- owner 是谁?
- 源文件和 commit 在哪里?

示例:

```text
web-console
Decision context changed

Affected context area
agent-hub / web console / workspace decisions

Why it matters
Agents may use this context when reasoning about Hub workspace behavior,
operator workflows, or UI-related implementation choices.

Owners
baixiaohang, yuezengwu

Related context
agent-hub/product-direction.md
agent-hub/cli.md

Source
agent-hub/web-console.md · 9e664e7
```

## 状态文案

当前有 snapshot:

```text
Team context is current
A synced team context is available for agents · main@9e664e
```

有 stale snapshot:

```text
Team context needs attention
Agents may be working from stale team context · last synced 2h ago
```

没有可用 snapshot:

```text
Team context unavailable
Connect a Context Tree repo to show the decision context available to agents.
```

等有 per-agent readiness telemetry 后,Header 才升级为:

```text
Team context is current
8 agents using latest context · 12 changes since your last view
```

## 数据模型调整

V1 的 `nodes[]` / `edges[]` 仍然保留,但 V2 增加 `impacts[]`,让 Web 可以直接渲染 Impact Feed。

```text
ContextTreeSnapshot
├─ repo
├─ branch
├─ headCommit
├─ syncedAt
├─ snapshotStatus
├─ contextSourceSignal
├─ summary
├─ impacts[]
├─ nodes[]
├─ edges[]
└─ changes[]
```

```text
ContextTreeImpact
├─ id
├─ nodeId?
├─ path
├─ title
├─ changeType: added | edited | removed
├─ affectedContextArea
├─ reason
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

后续如果接入 session telemetry,`ContextTreeImpact` 可以增加:

```text
agentUsage
├─ agentsUsingLatestCount
├─ agentsBehindCount
└─ affectedSessionIds[]
```

## 实现计划调整

V2 的实现顺序应该改成:

1. **Server snapshot + impacts API**  
   先产出 `nodes[]`、`changes[]`、`impacts[]`。Impact Feed 不能放到前端临时拼。

2. **Web Impact-first baseline**  
   Header、Change Summary、Impact Feed、Impact Detail、Files View。此阶段即使没有 Tree Map,也能传达核心价值。

3. **Tree Map Overview**  
   用 `d3-hierarchy + React SVG` 做 overview,并和 Impact Feed 联动。

4. **Polish**  
   Mark all seen、stale/unavailable、removed risk group、Open in repo / optional Open in Obsidian。

## Obsidian 的位置

Obsidian 可以做辅助深看,不作为主实现。

原因:

- Obsidian 是 document-first / graph-first;
- V2 是 impact-first / agent-context-first;
- Obsidian 不承担 Hub member JWT、org 权限、server snapshot、stale state、last-seen baseline;
- Obsidian 不能表达 per-agent readiness 或 session usage telemetry。

可以做:

- `Open in Obsidian`;
- Files View 交互参考;
- backlinks / outgoing links 的 detail 参考。

不做:

- 用 Obsidian plugin 承担 `/context` 主界面;
- 把 Hub `/context` 变成 vault viewer。

## V2 与 V1 的差异

| 维度 | V1 | V2 |
| --- | --- | --- |
| 主体验 | Tree Map | Impact Feed |
| Tree Map 职责 | 默认主视图 | Overview / spatial locator |
| 用户第一眼 | tree structure + changes | changes that may affect agent decisions |
| Detail | Node Detail | Impact Detail + Node Detail |
| API | nodes / edges / changes | impacts + nodes / edges / changes |
| 风险 | 容易变成 tree viewer | 更贴近 value perception |

## 推荐结论

采用 V2。

V1 可以作为技术可落地的基础,但 V2 更符合本需求目标:让用户感知 Context Tree 的价值,即 agents 背后有一棵正在生长、正在影响判断和行动、可以被治理的团队认知树。
