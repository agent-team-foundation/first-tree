---
title: Context Tree 写作规范
date: 2026-06-04
author: gandy-assistant
status: draft for discussion
scope:
  - Context Tree 写作规范
  - node 正文结构
  - PR/backfill 审计 metadata
non_goals:
  - 修改 Context Tree schema
  - 强制迁移历史节点
  - 把 tree 变成 wiki、规则清单或 source repo 摘要
---

# Context Tree 写作规范

## 背景

Context Tree 是组织语义层，不是资料仓库。它保存会改变未来 agent 或 human 判断/行动的 durable context：决策、边界、职责、授权、跨 domain 关系、取舍理由和经过审查的洞察。

当前真实问题：

- source repo / PR 已更新，但 tree 会残留 stale context；
- 有价值判断会留在 Claude/Codex/Hub session、PR body、gandy-log、gstack、本地 proposal 中；
- 原始记录只是线索，不等于事实权威；
- 只写“怎么做”会变成脆弱规则，agent 遇到冲突或新场景仍无法判断；
- header 字段过多会提高维护成本，降低更新意愿。

本规范目标：**低摩擦、可审查、能提升 agent 判断质量。**

## 核心方案

```text
最小 frontmatter
+
Statement / Why / Implication 三段正文
+
必要时加 optional sections
+
PR/backfill 阶段保留审计 metadata
```

长期 node 只保留读者真正需要的稳定内容。语义说明写在正文里；证据链、gap 分类、写入方式等过程信息留在 PR/backfill 阶段，供 reviewer 判断和追溯。

## Frontmatter

必填：

```yaml
---
title:
owners:
---
```

可选：

```yaml
status: draft | needs-review | superseded | deprecated
soft_links:
```

不写 `status` 默认 `active`。`soft_links` 只用于重要 cross-domain 关系。

默认不进入 frontmatter：

```yaml
semanticKind:
authority:
scope:
source:
confidence:
review:
domain_profile:
gapType:
updateMode:
disposition:
source_chain:
target_tree_nodes:
```

其中部分内容可写在正文，或只留在 PR/backfill 阶段。

## 正文必备三段

每条重要 context 至少写三段。

### Statement

结论是什么。要短、明确、可引用。

### Why / Rationale

为什么这样定；解决了什么问题；排除了什么方案；依赖什么假设。

Why 是 tree 区别于规则清单的关键。规则告诉 agent 做什么；why 帮 agent 在新场景里迁移判断。

### Implication for agents

未来 agent 应该如何判断、行动、处理冲突。

如果一条 context 不能改变未来 agent 行为，它大概率不该进 tree。

## Optional Sections

默认不加。只有当不加会导致误读、漏执行、伪事实或冲突时才加。

其中 **Boundary / Protocol / Review** 最值得优先考虑单独列出：

- `Boundary` 防止硬约束被读成普通建议；
- `Protocol` 防止重复场景漏步骤或重复发明流程；
- `Review` 防止 insight、hypothesis、阶段性判断沉积成伪事实。

`Evidence` 在来源复杂、有争议、或 source/tree/PR 冲突时也应单独列出。

| Section | 什么时候加 | 不加时通常放哪 |
|---|---|---|
| `Boundary` | **优先单独列出**：有硬边界，违反会造成架构、权限、产品定位、合规或授权问题 | Implication |
| `Protocol` | **优先单独列出**：重复场景需要稳定步骤、顺序或升级路径 | Implication |
| `Review` | **优先单独列出**：context 可能过期、带假设、依赖阶段性事实 | Why / 末尾一句 |
| `Evidence` | 来源复杂、有争议、存在 source/tree/PR 冲突时单独列出 | Why |
| `Concept` | 术语容易误解，或跨 domain 含义不同 | Statement |
| `Guidance` | 没有硬规则，但需要稳定权衡原则 | Implication |
| `Insight` | 观察、经验、风险或 hypothesis，不是 hard truth | Why，并配 Review |
| `Decision Log` | 旧方案容易被误读为当前事实 | Why / Evidence |

原则：

```text
能清楚写进 Statement / Why / Implication，就不要拆。
拆出来必须有实际作用。
```

## PR / Backfill Metadata

这些字段用于写入过程，不默认进入长期 node：

```yaml
disposition: must_update | human_review | process_protocol | covered | excluded | issue_only
gapType: missing | stale | contradictory | overclaimed | covered | excluded
updateMode: patch_existing | add_leaf | supersede | delete | process_note
evidence_level:
source_chain:
target_tree_nodes:
domain_profile:
```

它们应放在：

- backfill audit 文档；
- Context PR description；
- agent context suggestion report；
- review checklist。

长期 node 应保留结论、why 和对 agent 的影响；过程 metadata 留在 PR/history 中可审查即可。

## Evidence Levels

Backfill 或 PR 阶段使用：

| Level | Source | 用途 |
|---|---|---|
| A1 | `origin/main`、已合并 commit、release tag | 已接受实现事实 |
| A2 | 当前 clean Context Tree | tree 当前覆盖、遗漏、矛盾 |
| A3 | 已合并 PR body / review / commit message | rationale 和已采纳方向 |
| B | 原始 Claude / Codex / Hub transcript | 工作过程和决策形成 |
| C | prompt logs | coverage clue，不证明结论 |
| D | daily review / gstack / memory | 二级线索，必须交叉验证 |
| E | dirty checkout / untracked proposal | 草稿材料 |

规则：

```text
只有 C/D/E 的候选不能进入 active tree context。
未合并 PR 不能作为 active truth。
本地 detached worktree 不能作为当前 source fact。
```

## Backfill 流程

1. 建立 source inventory：路径、时间范围、证据层级、覆盖缺口。
2. 抽取候选主题：日志和 session 只做线索。
3. 用 A1/A2/A3 验证。
4. 分类 gap：`missing / stale / contradictory / overclaimed / covered / excluded`。
5. 决定 updateMode：优先 patch existing node，必要时 add leaf。
6. 写正文：`Statement / Why / Implication`，按需加 optional sections。
7. 在 PR description 保留 `source_chain`。

## Review Checklist

写完后只问这些问题：

- Statement 是否一句话讲清结论？
- Why 是否解释了原因、取舍和假设？
- Implication 是否能改变 agent 行动？
- 是否有硬边界需要单独写 `Boundary`？
- 是否有重复流程需要写 `Protocol`？
- 是否有过期风险需要写 `Review`？
- 来源复杂时，是否写了 `Evidence` 并在 PR 保留 `source_chain`？
- 这条是否真的属于 tree，而不是 issue、README、source repo 或聊天记录？

## 最小模板

```md
---
title:
owners:
soft_links:
---

# Title

## Statement

...

## Why / Rationale

...

## Implication for agents

...
```

按需追加：

```md
## Boundary
## Protocol
## Review
## Evidence
```

## 示例：不同类型

### Protocol

```md
---
title: Human request protocol
owners: [baixiaohang, yuezengwu]
soft_links:
  - /first-tree-cloud/chat/messaging.md
---

# Human request protocol

## Statement

Open question 现在是 message-native request，不再是 NHA/attention object。

## Why / Rationale

NHA/attention 把“问人”做成独立机制，导致消息系统、UI open state 和 agent escalation path 分裂。
PR #747 移除 NHA，PR #782 把 open question 收敛回 messages，让 request、reply、open_request_count 都围绕 message thread 推导。

## Implication for agents

Agent 不应再调用 `first-tree attention`、AskUserQuestion 或 NHA。
需要问人时，使用 request message / `chat send --request` 语义。
看到旧 NHA 文档时，先判断为 stale。
```

### Boundary

```md
---
title: Cloud agent identity boundary
owners: [yuezengwu, baixiaohang]
soft_links:
  - /first-tree-cloud/agents/claim-agent.md
---

# Cloud agent identity boundary

## Statement

Cloud agent identity is server-managed; Context Tree `members/` is not the canonical source for Hub agent rows.

## Why / Rationale

旧 members-sync 模型会误导 agent 通过修改 tree 处理 Cloud identity。当前 source truth 是 Hub Admin API、user JWT、client registration 和 `agent:bind` live DB join。

## Boundary

Context Tree `members/` only expresses tree member ownership/review metadata. It must not be treated as Cloud runtime identity.

## Implication for agents

调试 agent bind、visibility 或 identity 时，先查 Hub source/API/runtime state，不要假设编辑 `members/` 会创建或更新 Cloud agent。
```

### Insight

```md
---
title: Login is not connected
owners: [yuezengwu]
status: needs-review
---

# Login is not connected

## Statement

`first-tree login` 完成不等于 computer 已 connected。

## Why / Rationale

Login 写入 credential 并安装/启动 daemon；connected 需要 daemon 建立 WebSocket 并收到 `client:registered`。launchd/systemd environment 也可能和交互式 shell 不同。

## Implication for agents

排查 onboarding stuck 时，检查 daemon service state、logs、PATH/env 和 `client:registered`，不要只看 login 是否返回成功。

## Review

如果后续 onboarding/support 不再出现这类问题，可降级为 troubleshooting doc，不保留为 durable insight。
```

### Concept / Guidance

```md
---
title: Resources settings placement
owners: [baixiaohang, yuezengwu]
soft_links:
  - /first-tree-cloud/web-console.md
---

# Resources settings placement

## Statement

Resources configuration belongs in Settings, not Team roster.

## Why / Rationale

Resources 是团队级配置对象；把它放进 Settings 能和 Context tree、GitHub、Onboarding 等配置入口保持一致，也避免 Team roster 同时承担成员管理和资源配置。

## Implication for agents

更新 Web Console docs 或导航说明时，把 Resources 路由到 `/settings/resources`；不要把它描述成 Team roster sub-tab。
```

### Stale Cleanup

```md
---
title: W1 source repo cleanup
owners: [liuchao-001, 286ljb, bingran-you]
soft_links:
  - /first-tree-context-management/workspace-layout.md
---

# W1 source repo cleanup

## Statement

Under the W1 workspace-rooted model, source repos should not carry First Tree runtime injection artifacts.

## Why / Rationale

Binding state lives at the workspace root. Keeping per-source skill mirrors, framework blocks, or generated source-repo indexes creates stale context and can mislead agents launched from old worktrees.

## Implication for agents

When source repo instructions conflict with workspace-rooted W1 docs, treat source-local First Tree injection as legacy unless `origin/main` and current tree confirm otherwise.

## Evidence

Check `origin/main` and current clean tree before using local detached worktree files as source truth.
```
