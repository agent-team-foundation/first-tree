# 面向用户的 Context Tree UI 技术方案

> 推荐设计已经把主体验从 Map-first 调整为 Impact-first。实现时应优先参考 [user-facing-context-tree-ui-design.zh-CN.md](user-facing-context-tree-ui-design.zh-CN.md)。本文档中的技术选型仍适用,但 Web 实现顺序应以 Impact Feed / Impact Detail 为先。

## 目标

把 Context Tree 转译成 Hub 中可感知的 agent decision context surface。当前版本交付 snapshot-level context visibility,让用户看到:

- agents 背后有一份可用的团队认知树;
- 这棵树正在随团队工作生长;
- 变化会影响 agents 后续判断、协作请求和执行取舍;
- 变化落在哪个 domain / owner / related context。

当前不交付 per-agent readiness 精确计数、node-level usage telemetry、Context Tree 编辑器或通用 graph explorer。

## 数据流

```text
Configured Context Tree repo
  -> Hub Server snapshot service
  -> GET /api/v1/context-tree/snapshot?since=<commit>
  -> Web /context
  -> localStorage lastSeenCommit
```

Hub Server 是只读 snapshot provider。Web 不依赖用户本机 tree checkout,也不直接访问 GitHub API。

## 技术选型

| 能力 | 选型 | 理由 |
| --- | --- | --- |
| Git 读取和 diff | server-side git CLI,必要时封装 service | 最可靠,能处理 private repo、diff、deleted file |
| Frontmatter 解析 | `gray-matter` | 直接解析 `title`、`owners`、`soft_links` |
| Markdown preview | 现有 `react-markdown` | Web 已有依赖,避免重复引入 |
| Tree layout | `d3-hierarchy` | 稳定 hierarchical tree,符合 Context Tree 主结构 |
| Tree render | React + SVG | 精确控制 agent context 文案、change state、selection |
| Files view | 自研 file tree + preview | 作为辅助视图,不让 file browser 成为主体验 |

不把 Obsidian plugin、React Flow 或 Cytoscape 作为主实现。原因是本需求的主目标是 Context Tree value perception,不是 document graph browsing。Obsidian 可以作为本地深看入口,例如 `Open in Obsidian`,但不承担 Hub 的权限、snapshot、stale state、last-seen 或 agent decision context 表达。

## API

```text
GET /api/v1/context-tree/snapshot?since=<commit>
Authorization: Bearer <member-jwt>
```

返回:

```text
ContextTreeSnapshot
├─ repo
├─ branch
├─ headCommit
├─ syncedAt
├─ snapshotStatus: active | stale | unavailable
├─ contextSourceSignal
├─ summary
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
├─ relatedNodeIds[]
├─ affectedContextArea
├─ changeType?: added | edited | removed
└─ changedAtCommit?
```

```text
ContextTreeChange
├─ path
├─ nodeId?
├─ type: added | edited | removed
├─ commit
└─ changedAt?
```

```text
ContextSourceSignal
├─ label
├─ detail
└─ severity: ok | warning | error
```

`summary` 至少包含 `addedCount`、`editedCount`、`removedCount`、`changedNodeCount`。

## Server 实现

### Snapshot service

职责:

- 读取 server config 中的 Context Tree repo、branch、credential。
- refresh repo 到本地 server cache。
- 解析 markdown files 和 directories。
- 生成 parent edges、soft link edges、markdown link edges。
- 生成 preview、owners、title、affected context area。
- 基于 `since` commit 计算 changes。
- 返回 active / stale / unavailable 状态。

### Diff 规则

```text
git diff --name-status <since>..HEAD -- '*.md'
```

映射:

- `A` -> added
- `M` -> edited
- `D` -> removed ghost node
- rename 当前先视为 removed + added

异常处理:

- `since` 不存在或不可达:返回当前 snapshot,并用最近 N 个 commits 作为 fallback change window。
- refresh 失败但有上一份 snapshot:返回 stale snapshot + warning signal。
- 没有可用 snapshot:返回 unavailable。

## Web 实现

### 页面区域

```text
Context Signal
Decision Context Line
Change Summary
Map + Node Detail
Files View
```

首屏文案:

```text
Team context is current
Agents have a synced decision context from Context Tree · main@9e664e

12 changes since your last view
Added 3 · Edited 8 · Removed 1
```

### Tree Map

- 默认视图。
- 使用 `d3-hierarchy` 计算布局。
- ancestor/domain 聚合 changed descendant count。
- changed nodes 高亮。
- removed node 用 ghost node 展示。
- `soft_links` 不全图渲染,只在选中节点的 Node Detail 展示。

### Node Detail

必须回答:

- 这个节点是什么?
- 为什么高亮?
- 这个变化可能影响哪块 agent decision context?
- owner 是谁?
- 相关 context 在哪里?

示例:

```text
web-console
Decision context changed

Affected context area
agent-hub / web console / workspace decisions

Owners
baixiaohang, yuezengwu
```

### Last seen

当前使用浏览器本地存储:

```text
first-tree-hub:context:lastSeenCommit:<repo>:<branch>
```

`Mark all seen` 把当前 `headCommit` 写入 localStorage,并刷新 change state。

## 分阶段交付

### Phase 1: Server snapshot API

- 配置读取。
- repo refresh / stale handling。
- markdown/frontmatter parser。
- nodes / edges / changes DTO。
- API auth。
- parser 和 diff unit tests。

### Phase 2: Web baseline

- `/context` API client。
- Context Signal。
- Decision Context Line。
- Change Summary。
- Node Detail。
- Files View。
- empty / stale / unavailable 状态。

### Phase 3: Tree Map

- 引入 `d3-hierarchy`。
- React SVG tree render。
- selected state。
- changed node highlight。
- ancestor aggregate count。
- removed ghost node。

### Phase 4: Polish

- `Mark all seen`。
- keyboard / focus / loading states。
- responsive layout。
- `Open in repo` / optional `Open in Obsidian`。
- copy path / owner filters。

## 测试计划

- `pnpm check`
- `pnpm typecheck`
- server parser unit tests
- diff mapping tests
- API auth / unavailable / stale tests
- Web smoke tests for current / no changes / stale / unavailable
- manual QA with a small tree and a tree containing deleted files

## 后续扩展

- Server-side user preference for cross-device last-seen。
- Search / owner filter / domain filter。
- Per-agent context readiness: agent 当前使用的 context commit。
- Session-level context usage telemetry:session 注入或读取了哪些 context nodes。
- Workspace agent/session -> Context node deep link。
