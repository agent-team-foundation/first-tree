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

> 在 Hub 中提供一个面向用户的 Agent Context Impact surface,让用户优先看到哪些 Context Tree 变化可能影响 agents 的判断和行动,再通过 Tree Map 理解变化在团队认知树中的位置。

## 设计原则

1. **Impact-first, not map-first**  
   用户第一眼应该看到“哪些变化可能影响 agent decision context”,而不是先看到一张 tree map。

2. **Agent-context-first, not document-first**  
   页面不把 markdown 文件作为主对象,而是把文件变化转译成 agent context source、decision impact、owner 和 related context。

3. **Signal before proof**  
   当前可以表达“这份 team context 可供 agents 使用”和“变化可能影响 agent 判断”。在没有 runtime telemetry 前,不能声称某个具体 agent 已经读取某个节点。

4. **Map as locator**  
   Tree Map 保留,但职责是空间定位和结构理解,不是主解释器。

## 体验目标

| 目标 | 用户问题 | 设计表达 |
| --- | --- | --- |
| Context source visible | agents 背后的 team context 是否可用? | Header 显示 current / stale / unavailable |
| Growth visible | Context Tree 最近如何生长? | Change summary: added / edited / removed |
| Decision impact visible | 哪些变化可能影响 agent 判断和行动? | Impact Feed 作为主内容 |
| Structure visible | 这些变化在树的哪里? | Tree Map Overview 作为辅助定位 |
| Governance visible | 该找谁、看哪些相关 context? | Impact Detail / Node Detail |

## 页面结构

首屏结构:

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

页面分区:

- **Context Signal**:团队认知树是否可用、是否新鲜。
- **Change Summary**:自上次查看后 tree 如何生长。
- **Impact Feed**:主区域,展示可能影响 agent decision context 的变化。
- **Tree Map Overview**:辅助区域,展示变化在树上的位置。
- **Impact Detail**:治理入口,展示 owner、related context、source commit。
- **Files View**:辅助深看,展示源文件和 markdown preview。

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

Tree Map 是 overview,不是主体验。

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

## 数据模型

`nodes[]` / `edges[]` 用于 Tree Map 和 Files View。`impacts[]` 用于 Impact Feed,避免前端临时从 node diff 推断产品语义。

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

## 实现顺序

1. **Server snapshot + impacts API**  
   先产出 `nodes[]`、`changes[]`、`impacts[]`。Impact Feed 不放到前端临时拼。

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
- 本设计是 impact-first / agent-context-first;
- Obsidian 不承担 Hub member JWT、org 权限、server snapshot、stale state、last-seen baseline;
- Obsidian 不能表达 per-agent readiness 或 session usage telemetry。

可以做:

- `Open in Obsidian`;
- Files View 交互参考;
- backlinks / outgoing links 的 detail 参考。

不做:

- 用 Obsidian plugin 承担 `/context` 主界面;
- 把 Hub `/context` 变成 vault viewer。

## 推荐结论

采用 Impact-first 方案。

这个方案更符合本需求目标:让用户感知 Context Tree 的价值,即 agents 背后有一棵正在生长、正在影响判断和行动、可以被治理的团队认知树。
