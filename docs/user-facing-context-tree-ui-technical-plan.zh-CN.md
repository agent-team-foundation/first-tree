# 面向用户的 Context Tree UI 技术方案

> 推荐设计已经把主体验从 Map-first 调整为 Updates-first。实现时应优先参考 [user-facing-context-tree-ui-design.zh-CN.md](user-facing-context-tree-ui-design.zh-CN.md)。本文档中的技术选型仍适用,但 Web 实现顺序应以 Context Updates / Selected Change 为先。

## 目标

把 Context Tree 转译成 Hub 中可感知的 agent decision context surface。当前版本交付 snapshot-level context visibility,让用户看到:

- agents 背后有一份可用的团队认知树;
- 这棵树正在随团队工作生长;
- 变化会影响 agents 后续判断、协作请求和执行取舍;
- 变化落在哪个 domain / owner / related context。

当前不交付 per-agent readiness 精确计数、node-level usage telemetry 或通用 graph explorer。Context Tree 编辑器不是当前缺省能力,而是长期不做:这个 UI 永远只读,不在 Hub 页面内创建、修改、删除或提交 Context Tree 节点。

## 数据流

```text
Configured Context Tree repo
  -> Hub Server snapshot service
  -> GET /api/v1/context-tree/snapshot?window=7d
  -> Web /context
```

Hub Server 是只读 snapshot provider。Web 不依赖用户本机 tree checkout,也不直接访问 GitHub API,更不写入 Context Tree repo。

## 长期非目标

这个 UI 永远不承担 Context Tree authoring。所有 Context Tree 写入继续通过 Git-native repo、PR、CODEOWNERS、owner approval 和 `first-tree` 工具完成。

明确不做:

- Hub 页面内 markdown 编辑器;
- Hub 页面内新增、重命名、移动或删除节点;
- Hub 页面内直接 commit / push Context Tree 变更;
- 绕过 tree repo review 流程的快捷写入 API。

技术上,本需求只暴露 read model: `snapshot`、`nodes`、`edges`、`changes`、`updates`。不要为写入预留 mutation endpoint、编辑状态模型或 optimistic update 机制。

## 构建原则

优先使用成熟可用的组件和库,避免从零构建通用能力。

- 页面结构、按钮、面板、markdown preview 优先复用 Hub 现有组件。
- tree layout 使用 `d3-hierarchy`,不手写布局算法。
- 图渲染保持为轻量 React SVG,因为本需求需要的是稳定树形 overview,不是通用 graph editor。
- 自研代码只负责 Context Tree read model、updates 语义生成、selection / filter 等业务 glue。

## 技术选型

| 能力 | 选型 | 理由 |
| --- | --- | --- |
| Git 读取和 diff | server-side git CLI,必要时封装 service | 最可靠,能处理 private repo、diff、deleted file |
| Frontmatter 解析 | `gray-matter` | 直接解析 `title`、`owners`、`soft_links` |
| Markdown preview | 现有 `react-markdown` | Web 已有依赖,避免重复引入 |
| Tree layout | `d3-hierarchy` | 稳定 hierarchical tree,符合 Context Tree 主结构 |
| Tree render | React + SVG | 精确控制 agent context 文案、change state、selection |
| Source preview | 折叠在 Selected Change 中 | 支持深看原始 markdown,不让 file browser 成为主体验 |

不把 Obsidian plugin、React Flow 或 Cytoscape 作为主实现。原因是本需求的主目标是 Context Tree value perception,不是 document graph browsing。Obsidian 可以作为本地深看入口,例如 `Open in Obsidian`,但不承担 Hub 的权限、snapshot、stale state、time-window updates 或 agent decision context 表达。

## API

```text
GET /api/v1/context-tree/snapshot?window=7d
Authorization: Bearer <member-jwt>
```

`window` 只允许 `1d`、`7d`、`30d`,默认 `7d`。

返回:

```text
ContextTreeSnapshot
├─ repo
├─ branch
├─ headCommit
├─ syncedAt
├─ snapshotStatus: active | stale | unavailable
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
└─ riskLevel: low | medium | high
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
├─ changedAt?
├─ changedBy?
└─ summary?
```

```text
ContextTreeStatus
├─ label
├─ detail
└─ severity: ok | warning | error
```

`summary` 至少包含 `addedCount`、`editedCount`、`removedCount`、`changedNodeCount`。

## Server 实现

### Snapshot service

职责:

- 读取 server config 中的 Context Tree repo / branch。
- 以 server config 中的 remote Context Tree repo / branch 作为 source of truth。
- Hub Server 自动把 remote repo 同步到 server-managed readonly checkout;`FIRST_TREE_HUB_CONTEXT_TREE_PATH` / `contextTree.localPath` 仅作为 dev/self-host override。
- 解析 markdown files 和 directories。
- 生成 parent edges、soft link edges、markdown link edges。
- 生成 preview、owners、title、affected context area。
- 基于固定时间窗口计算 changes。
- 生成 updates,把 file diff 转译为 agent decision context update。
- 读取最后一次触碰该文件的 commit author 和 commit subject,作为 `changedBy` 与可选 `summary`。
- 校验本地 checkout branch 与 server config 是否一致,避免错标 branch。
- 对 git command 设置 timeout / buffer 上限,并对 diff entry 做上限保护。
- 用短 TTL in-memory cache 缓解同一 `repo + branch + headCommit + window` 的重复请求。
- 返回 active / unavailable 状态;不可用态表达 sync/access 问题,不把 server 机器环境变量暴露给用户。

当前实现支持 remote repo 自动 materialize:当 `contextTree.repo` 是 remote URL 或 `owner/repo` shorthand 时,Hub Server 会 clone/fetch 到 `$FIRST_TREE_HUB_HOME/data/context-tree-repos/<hash>` 并从该 managed checkout 生成 snapshot。`contextTree.localPath` 保留为本地开发、self-host debug 或特殊部署 override,不是线上默认路径。

### 性能和复用边界

当前 snapshot projection 是 request-time 计算:扫描本地 markdown tree、解析 frontmatter、读取 git diff,再生成 nodes / edges / changes / updates。实现中有短 TTL memory cache、git timeout、diff entry cap 和固定窗口枚举,以避免页面刷新导致重复重算或请求超大范围;但它仍不是长期最优边界。

生产化演进方向:

- 按 `repo + branch + headCommit` 缓存 nodes / edges / previews。
- `window` 只影响 changes / updates,不要导致每次请求都重建整棵树。
- credential refresh、stale snapshot fallback 放到 server refresh/cache 层。
- 通用扫描、frontmatter 解析、soft link 解析长期应沉到 `first-tree` 包,例如 `first-tree tree export --json` 或包内 `readContextTreeSnapshot()`;Hub 只保留 auth、config、cache、API wrapper 和 Context Updates 产品表达。

这样既避免 request-time 重复计算,也避免 Hub 长期拥有一套越来越厚的 Context Tree parser。

### Diff 和摘要规则

```text
git diff --name-status <window-base>..HEAD -- '*.md'
```

映射:

- `A` -> added
- `M` -> edited
- `D` -> removed ghost node
- rename 当前先视为 removed + added

`window-base` 由 server 根据固定窗口计算,不是用户提交的 commit。规则:

- `window=1d | 7d | 30d`;
- 找到窗口开始时间之前最近的 commit,然后 diff 到 `HEAD`;
- 如果 repo 的全部 commit 都在窗口内,用 empty tree 作为 comparison base,确保首次部署也能看到当前 Context Tree 内容。

左侧 Context Updates 不展示 diff 内容,避免把 markdown 半句误当成可理解摘要。`summary` 当前只来自最后一次触碰该文件的 commit subject:

- 如果 commit subject 足够具体,在 Selected Change 的 `What changed` 中作为补充;
- 如果 commit subject 过短、泛化或不可读,前端回退到稳定句式,例如 `Bingran You updated Client Runtime.`;
- 当前不要求 Context Tree 文件提供 `change_summary` metadata,也不新增写入或维护该 metadata 的流程。

异常处理:

- 没有可用 snapshot:返回 unavailable。
- remote URL 未绑定到本地 checkout:返回 unavailable,并提示配置本地路径。

## Web 实现

### 页面区域

```text
Context Status
Change Summary
Context Updates + Selected Change
Context Tree Overview
Source preview inside Selected Change
```

首屏文案:

```text
Team context is current
Agents have a synced team context snapshot available · main@9e664e

12 context updates in the last 7 days
Added 3 · Edited 8 · Removed 1
```

### Context Tree Overview

- 全局态势视图,不是当前 update detail,也不是默认主体验。
- 使用 `d3-hierarchy` 计算布局。
- ancestor/domain 聚合 changed descendant count。
- changed nodes 高亮。
- removed node 用 ghost node 展示。
- Selected Change 只跟随 selected update;Overview 可以独立高亮聚合 domain,避免把非 update 节点信息混入 detail。
- `soft_links` 不全图渲染,只在选中节点的 Selected Change 展示。

### Selected Change

必须回答:

- 这个 update 是什么?
- agents 能使用什么更新后的团队知识?
- 这个变化属于哪块 area?
- owner 是谁?
- 相关 context 在哪里?
- source path / commit 在哪里,是否需要展开 preview?

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

Source
agent-hub/web-console.md · 9e664e7
[Preview source] [Copy path]
```

### Time window

当前不做 per-user last-seen / unread 状态。页面使用固定时间窗口:

```text
1 day | 7 days | 30 days
```

默认 `7 days`。这样页面表达的是“团队 context 最近如何生长”,不是“这个用户哪些没读过”。如果后续要做治理型 ack / review workflow,再引入 server-side last-seen,不使用 localStorage 作为核心状态。

## 分阶段交付

### Phase 1: Server snapshot API

- 配置读取。
- 本地 Context Tree checkout 读取。
- markdown/frontmatter parser。
- nodes / edges / changes / updates DTO。
- API auth。
- unavailable 状态。
- parser 和 diff unit tests。

### Phase 2: Web baseline

- `/context` API client。
- Context Status。
- Change Summary。
- Context Updates。
- Selected Change。
- source preview。
- empty / unavailable 状态。

### Phase 3: Context Tree Overview

- 引入 `d3-hierarchy`。
- React SVG tree render。
- selected state。
- changed node highlight。
- ancestor aggregate count。
- removed ghost node。

### Phase 4: Polish

- time-window selector。
- keyboard / focus / loading states。
- responsive layout。
- `Open in repo` / optional `Open in Obsidian`。
- copy path / owner filters。
- server cache / stale snapshot fallback。

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
