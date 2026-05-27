---
title: Doc preview — 放开 inline code 包裹 + 失败 case 显式可见
date: 2026-05-26
author: gandy-assistant (代 gandy2025 立项)
status: draft for @gandy-developer
related-code:
  - packages/shared/src/lib/doc-link-scan.ts
  - packages/client/src/runtime/doc-snapshots.ts
  - packages/web/src/lib/doc-preview-links.ts
  - packages/web/src/pages/workspace/center/chat-view.tsx
  - packages/shared/src/schemas/me-doc.ts (failedMentions metadata 扩展)
---

# 背景

Hub 的 doc preview 当前要求 agent 在消息里把 `.md` 路径**裸贴**（不能被反引号或 fenced code block 包裹），命中后运行时打 snapshot，web 端渲染成可点击 chip。

实际观察：agent 写消息时**最自然的习惯是用反引号包裹路径**（mono-spaced 视觉，符合"这是个文件标识符"的直觉），结果消息发出去 preview 不触发，用户和 agent 都不知道哪里出了问题。

## 实测数据（19 个真实 session，37 条 `.md` mention）

| 类别 | 数量 | 占比 | 当前是否预览 |
|---|---|---|---|
| 裸路径 | 21 | 57% | ✅ |
| Markdown 链接 `[text](path)` | 3 | 8% | ✅ |
| **反引号包裹** | **11** | **30%** | ❌ |
| Fenced code block 内 | 2 | 5% | ❌ |

**当前失败率 35%；其中反引号 case 占失败的 85%。**

真实样本（来自历史 retro / stale node 分析 / 提案讨论）：
- `` `agent-hub/NODE.md` ``、`` `tools.md` ``、`` `CLAUDE.md` ``
- `` `/Users/.../worktrees/.../docs/doc-preview-worktree-fence-design.md` `` (绝对路径)
- `` `agent-hub/messaging.md` §218-229 `` (带 section 引用)
- `` `proposals/hub-agent-status-working-freshness.20260525.md` ``
- `` `members/Gandy2025/designs/context-tree-usage-signal.20260520.md` ``

这些都是高价值场景（设计讨论、context-tree 节点引用、提案推进），值得修。

# 目标

1. 让 inline code（单反引号）包裹的 `.md` 路径也能触发 doc preview，且**保留 agent 的视觉意图**（依然是 mono-spaced code style，但可点击）。
2. 让 snapshot 失败的 `.md` mention 在 UI 上**可见、可调试**，而不是静默降级为纯文本。

# 非目标 / 暂不放开

- **Fenced code block（三反引号）**：保留 skip。fenced block 里典型是目录树、代码示例、错误日志粘贴，开放后误识别成本高。实测仅 2 例，影响小。
- **HTML 标签 / 属性、reference link 定义**：保留 skip（避免双重 linkify）。
- **Domain-shaped 外链**（`example.com/foo.md`）：保留 skip。
- **隐藏路径段**（`.agent/`、`.git/`、`.cursor/`）：保留拒绝（安全边界）。
- **非 ASCII 文件名 / Windows `\` 路径**：scanner 仍只支持 ASCII POSIX。实测 0 例。

# 设计

## 方案 1：Scanner + Rewrite 支持 inline code 包裹

### Scanner 改造（`packages/shared/src/lib/doc-link-scan.ts`）

`scanBareDocPathTokens` 当前在 `findInlineSkipRanges` 把单反引号 inline code span 加入 skip ranges。改为：
- **不再跳过 inline code span**——但要在返回的 `BarePathMatch` 上新增字段标识 token 落在 inline code 里。

```ts
export type BarePathMatch = {
  raw: string;
  start: number;
  end: number;
  /** 当 token 落在单反引号包裹的 inline code 内时，给出外层反引号的 [start, end) span。 */
  enclosingCodeSpan?: { start: number; end: number };
};
```

`findInlineSkipRanges` 拆成两个函数：
- `findInlineCodeRanges`（用于上报 enclosingCodeSpan，**不**作为跳过依据）
- `findFencedAndHtmlSkipRanges`（fenced block、HTML tag、reference link 定义——仍作为 hard skip）

注意：fenced code block 检测（`FENCE_OPEN_RE` + `inFence` 状态机）保持原样。

### Rewrite 改造（`packages/client/src/runtime/doc-snapshots.ts`）

`buildMessageDocumentSnapshots` 的 Pass 3 rewrite 现在产出 `[display](key)`。改为：
- 如果 `occ.enclosingCodeSpan` 存在 → rewrite 的 span 扩展为整个反引号包裹段，replacement 改为 `` [`raw`](key) ``。
  - CommonMark 允许 link text 里嵌 inline code，渲染结果就是 code-style monospace 文本 + click target。
- 如果不存在 → 保持当前 `[display](key)` 形式。

`DocPathOccurrence` 同步新增 `enclosingCodeSpan` 字段，由 `collectDocPathOccurrences` 从 scanner 透传。

### Web 端

Web 端 `linkifyMarkdownDocPaths` 是 legacy fallback（runtime 已经把 snapshotted token 改写成 explicit markdown link，web 端不需要重扫）。但为了对 pre-fix 老消息保持兼容，**`linkifyMarkdownDocPaths` 也同步放开 inline code skip**，并产出 `` [`raw`](snapshotKey) `` 形式。

## 方案 2：失败 mention 显式 inert chip

### Metadata 扩展（`packages/shared/src/schemas/me-doc.ts`）

`documentContextSchema` 在 `kind: "snapshot"` 下新增可选字段：

```ts
failedMentions: z.array(z.object({
  raw: z.string().min(1).max(512),       // agent 原始 token 文本
  reason: z.enum([
    "missing",           // 文件不存在
    "out-of-fence",      // 路径越出 agent home / workspaces 公共根
    "hidden-segment",    // 路径段以 . 开头
    "too-large",         // 单文件超 MAX_DOC_SNAPSHOT_BYTES
    "budget-exceeded",   // 消息累计 snapshot 超 total cap
    "unreadable",        // realpath / readFile 抛错
  ]),
})).optional()
```

### Runtime 收集失败原因（`doc-snapshots.ts`）

Pass 2 现在的 `skipped += 1` 计数升级为：在每个失败分支里记录 `{ raw, reason }` 到 `failedMentions[]`，最终一并返回。

注意：只收集**runtime 自己判定的失败**（文件不存在、越界、超大）。Scanner 已经过滤的 domain-like / 隐藏段 / fenced block 不进 failedMentions（设计意图）。

### Web 端 inert chip 渲染（`chat-view.tsx`）

- 读取 `metadata.documentContext.failedMentions`。
- 渲染 message body 时，在原 token 位置（scanner 同款扫描定位）渲染一个 disabled 状态的 doc chip：
  - 视觉：和 success chip 类似的 mono-spaced 样式，但灰底/灰字 + cursor 不变手。
  - hover tooltip 文案（按 reason 映射）：
    - `missing` → "文档不存在"
    - `out-of-fence` → "文档不在当前工作区"
    - `hidden-segment` → "路径包含受限段"
    - `too-large` → "文档超过预览大小限制"
    - `budget-exceeded` → "本条消息引用文档过多"
    - `unreadable` → "无法读取该文档"

### Web inert chip 也要避开 inline code 撞车

如果 failed mention 本身落在 inline code 内（方案 1 触发但 snapshot 失败），按方案 1 同款 rewrite 策略——把外层反引号一并替换为带 code style 的 disabled chip。

# 验收标准

1. **历史回归零损失**：所有"当前能 preview"的 mention 在改后**仍然**能 preview，且 snapshot key 不变（向后兼容必须验）。
2. **反引号包裹场景正常**：发送一条消息 `` 文档已写入 `proposals/foo.md`，请查阅 ``，文件真实存在 → web 端渲染成 mono-spaced 可点击 chip，点击打开 preview。
3. **绝对路径 + 反引号**：`` 详见 `/Users/.../workspaces/<self>/docs/x.md` ``，文件真实存在 → 正常 preview。
4. **Fenced block 内的路径仍然 plain text**（保持现状）。
5. **隐藏段 / domain-like 仍然 plain text**（保持现状）。
6. **失败 mention 在 UI 上可见**：
   - 引用不存在文件 → 灰底 disabled chip + "文档不存在" tooltip。
   - 引用越界文件 → 灰底 chip + "文档不在当前工作区"。
   - 单文件超大 → 灰底 chip + "文档超过预览大小限制"。
7. **e2e 测试覆盖**：`packages/e2e` 新增至少 3 个场景：(a) 反引号包裹成功 (b) 反引号包裹失败显示 inert chip (c) fenced block 内仍 plain text。

# 风险评估

- **假阳性**（agent 写 `` `README.md` `` 当文档示例，恰好工作区里真有一个 `README.md`）：会被识别为可点击预览。后果是用户多了一次点击选项，没安全风险。实测 0 例，可接受。
- **CommonMark 兼容**：`` [`code`](url) `` 是 commonmark 标准语法，react-markdown 默认支持。无需新依赖。
- **Metadata schema 扩展**：`failedMentions` 是 optional，旧 web 端读不到不影响。server schema 验证要相应放过这个新字段。

# 估算

- Scanner + rewrite 改造：~80 行 + 单元测试。
- Metadata schema + runtime 失败收集：~60 行 + 测试。
- Web inert chip 组件 + chat-view 接入：~120 行 + 测试。
- E2E 测试：~80 行。
- **总计：约 350 行业务代码 + 测试**，单 PR 可完成，预计 1-2 天工作量。

# 开放决策（由用户拍板）

1. ✅ **Fenced code block 是否一并放开？** — 推荐 **不放开**，理由见"非目标"。
2. ✅ **Inert chip 默认显示样式：灰底 chip vs 内联文字 + ⚠ 图标？** — 推荐**灰底 chip**，视觉一致性更好。
3. ❓ **是否需要把 failedMentions 也对 source 是 web 的消息生效？** — 当前只 agent 消息走 runtime snapshot 流程。Web 端用户发的消息也可能引用文档。如果要支持，需要 web→server 走一遍 snapshot 流程。**初版建议先不做**（增量太大），用户消息里的 `.md` 仍按现有 web fallback 路径处理。

# 实施顺序建议

1. **第一步：scanner + rewrite 改造（方案 1）**——单独一个 PR 即可解决 85% 的失败 case，可以快速 ship。
2. **第二步：metadata + inert chip（方案 2）**——独立 PR，覆盖剩余 15% + 提供调试可见性。

两步可以分别独立 review、独立 merge，降低单 PR review 负担。

# 测试入口

- 反引号包裹场景的最小复现：当前 chat（`403f324b-...`）里 gandy-assistant 那条 "Proposal 已写好：`/Users/.../connect-computer-optimization.md`"
- 文档：`proposals/connect-computer-optimization.md`（已真实存在于 gandy-s-assistant workspace）
