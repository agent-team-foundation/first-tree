---
title: "提案：用于 Hub Context 标签页的准确代理 Context Tree 读取遥测"
owners: [Gandy2025]
soft_links:
  - first-tree-cloud/context-tab.md
  - first-tree-cloud/client-runtime.md
  - first-tree-cloud/web-console.md
  - proposals/acp-multi-runtime-support.20260505.md
---

# 提案：用于 Hub Context 标签页的准确代理 Context Tree 读取遥测

**作者：** Gandy2025 / Codex
**日期：** 2026-05-29
**状态：** 提案阶段
**范围：** `first-tree-hub` 客户端运行时、Context 标签页使用动态、面向代理的 Context Tree 工具表面。

---

## TL;DR

Hub 的 Context 标签页应该记录一个客观事实：**哪个代理在哪个聊天中成功读取了哪个 Context Tree 节点**。这是对产品至关重要的证据，用来证明 Context Tree 不只是被配置或注入，而是在工作过程中确实被代理查阅过。

当前实现已经为 Claude Code 提供了一条高完整性路径：在 Context Tree checkout 内成功调用 `Read` / `NotebookRead` 会发出 `context_tree_usage` 事件。缺口在 Codex：`@openai/codex-sdk` 暴露 shell 命令和 MCP 调用，但没有内建的结构化“文件读取”事件。解析任意 shell 命令只能做到尽力而为，并会削弱动态列表的真实性。

建议：继续把 `context_tree_usage` 保持为高置信度的读取事实，并通过 First Tree MCP 工具为 Codex 提供一条受控的结构化读取路径，例如 `first_tree.read_node({ nodePath })`。不要把任意 shell 命令猜测混入同一个指标。

---

## 1. 目标

目标是获得准确、客观、可审计的**代理读取 Context Tree 遥测**。

一次读取事件应该意味着：

> 某个代理成功读取了一个具体的 Context Tree 节点/文件。

这对 First Tree 很重要，因为它让产品能够展示：

- Context Tree 是否真的被代理使用，而不只是完成了配置；
- 哪些代理和聊天查阅了 tree 上下文；
- 哪些节点在实际工作中重要；
- 团队是否存在过期或无人阅读的决策上下文；
- 未来治理信号，例如经常被阅读的决策、缺失的上下文，以及代理上下文覆盖缺口。

这应当和较弱的事实保持区分：

- “代理拥有一个 Context Tree 绑定”；
- “运行时把根上下文注入到了提示词中”；
- “代理搜索了 tree”；
- “某条 shell 命令提到了一个 tree 路径”；
- “Context 标签页快照能够读取 tree 仓库。”

这些事实有用，但它们不等同于“代理读取了这个节点”。

---

## 2. 当前状态与缺口

### 2.1 已经实现的内容

Hub 已经具备存储和展示管线：

1. 客户端运行时发出一个 `kind = "context_tree_usage"` 的 `session_event`。
2. 服务端把它持久化到 `session_events`。
3. Context 快照聚合按组织统计近期 `context_tree_usage` 行。
4. Context 标签页渲染聚合用量和最近使用动态。

对于 Claude Code，客户端运行时已经有准确的信号：

- Claude Code 发出结构化 tool-use / tool-result 消息。
- handler 识别查看类工具：`Read` 和 `NotebookRead`。
- 它提取 `file_path`。
- 它验证路径位于已配置的 Context Tree checkout 之下。
- 它只在工具结果成功后发出 usage。

这是正确的完整性门槛：成功读取、具体路径、明确节点。

### 2.2 当前缺口：Codex

Codex 目前不会产生 Context 标签页读取事件。

在本提案撰写时，仓库使用 `@openai/codex-sdk@0.134.0`。该 SDK 暴露的结构化线程条目包括：

- `command_execution`
- `file_change`
- `mcp_tool_call`
- `agent_message`
- `web_search`
- `todo_list`

它没有暴露等价于 Claude `Read(file_path=...)` 的内建结构化文件读取事件。

当 Codex 通过 shell 读取文件时，Hub 只能看到一个命令条目，例如：

```bash
sed -n '1,120p' /path/to/context-tree/first-tree-cloud/context-tab.md
cat /path/to/context-tree/proposals/foo.md
rg "context telemetry" /path/to/context-tree
```

如果不解析 shell 语法并推断意图，这不足以形成高置信度的逐节点遥测。

### 2.3 为什么这很重要

如果没有可靠的 Codex 信号：

- Context 标签页会低估 Codex 代理的使用量。
- 即使 Codex 通过 shell 查阅了文件，团队也可能看到“没有代理读取过 Context Tree”。
- 当前动态列表的承诺仍然诚实，但并不完整。
- 如果直接把 shell 解析加入 `context_tree_usage`，就会把该指标从事实变成猜测。

---

## 3. 候选方案

### 方案 A：First Tree MCP 读取工具（推荐）

为 Context Tree 访问新增 First Tree MCP 工具表面：

```txt
first_tree.list_nodes()
first_tree.read_node({ nodePath })
first_tree.search_nodes({ query })
```

Codex SDK 已经把 `mcp_tool_call` 暴露为结构化条目。Codex handler 可以检测对 `first_tree.read_node` 的成功调用，并使用传入的 `nodePath` 发出 `context_tree_usage`。

**优点**

- 高置信度、结构化、可审计。
- 不需要等待 SDK 文件读取事件，就能适配 Codex。
- 让 First Tree 拥有 tree 语义，而不是解析 shell。
- 区分读取和搜索/列出/浏览。
- 自然扩展到未来支持 MCP 的运行时。
- 后续可以加入权限、路径校验、节点元数据和相关节点查询。

**缺点**

- 需要实现并发布 First Tree MCP server/tool surface。
- 需要更新 Codex briefing / `AGENTS.md` 生成逻辑，使其优先使用 MCP 工具。
- 代理仍然可以绕过工具使用 shell；除非加入较低置信度路径，否则这些绕过读取不会被追踪。

**评估**

这是长期产品和工程方向上的最佳选择。它保留了动态列表的事实语义。

### 方案 B：First Tree 专用 CLI 读取命令

提供一个受控的 CLI 入口：

```bash
first-tree context read first-tree-cloud/context-tab.md --json
first-tree context search "read telemetry" --json
```

Codex handler 识别 `command_execution` 中这一精确命令族，并在成功执行 `context read` 时发出遥测。

**优点**

- 比 MCP 更快实现。
- 比解析任意 shell 更稳定。
- 对人类和代理都有用。

**缺点**

- 仍然经由 shell。
- 至少需要解析一种命令语法。
- 对结构化结果和未来交互而言，不如 MCP 表达力强。
- 代理更容易无意绕过。

**评估**

如果 MCP 尚未就绪，这是可以接受的临时路径，但应被视为过渡，而不是目标。

### 方案 C：解析任意 Codex shell 命令

从 `cat`、`sed`、`nl`、`head`、`tail`、`rg`、`grep`、`awk`、`python -c` 或 shell 循环等命令中推断读取。

**优点**

- 不改变提示词或工具，也能捕获一部分既有 Codex 行为。
- 不需要新的代理工具表面。

**缺点**

- 天然不完整：变量、子 shell、循环、脚本、Python/Node 读取器和管道都很难推理。
- 可能误报：命令中出现一个路径，并不能证明成功读取了该节点。
- 搜索命令可能扫描大量文件，无法干净地映射到“读取了这个节点”。
- 会把 Context 标签页动态从事实削弱为尽力推断。

**评估**

不要把它作为主要遥测来源。如果实现，应单独保留、明确标记为低置信度，并默认排除在高置信度读取计数之外。

### 方案 D：文件系统读取审计

使用平台特定的文件系统或审计 hook，监控 Context Tree checkout 下的真实文件读取。

**优点**

- 有可能捕获 shell、脚本和语言运行时读取。
- 不依赖代理配合。

**缺点**

- 跨平台复杂度很高。
- 难以把读取归因到正确的代理/聊天/轮次。
- 噪音大，并且可能成本较高。
- 需要谨慎的隐私和权限分析。

**评估**

不适合作为近期 Hub 实现。

### 方案 E：等待 Codex SDK 文件读取事件

如果未来 Codex SDK 暴露结构化文件读取事件，Hub 可以像处理 Claude `Read` 事件一样处理它们。

**优点**

- 干净的供应商原生信号。
- 自定义协议表面最少。

**缺点**

- 不受 First Tree 控制。
- 时间线和语义未知。
- 可能仍然无法区分 Context Tree 读取/搜索/列出语义。

**评估**

跟踪上游，但不要让产品遥测依赖它。

---

## 4. 建议

采用**方案 A：First Tree MCP 读取工具**作为目标设计。

将 `context_tree_usage` 继续保留给高置信度节点读取：

- Claude Code 在 tree checkout 下成功调用 `Read` / `NotebookRead`。
- First Tree MCP 成功调用 `read_node`。
- 未来供应商原生文件读取事件，如果它们提供等价证据。

不要把任意 shell 解析猜测计入 `context_tree_usage`。

为相邻事实创建单独的事件类型或 payload 分类：

- `context_tree_search`：用于成功搜索操作。
- `context_tree_browse`：用于列出/导航操作，如果需要。
- 只有当产品刻意需要低置信度 shell 推断时，才使用 `context_tree_usage_guess` 或 `confidence: "best_effort"`。

如果 Context 标签页未来展示混合置信度事件，应让置信度边界可见。

---

## 5. 实施计划

### 阶段 1：锁定遥测语义

- 将 `context_tree_usage` 定义为高置信度读取事实。
- 为 payload 增加来源元数据，例如 `source: "claude_read" | "first_tree_mcp"`。
- 保留当前 `nodePath` 要求。
- 除非产品文案明确改变，否则不要把搜索/列出计入 usage count。

### 阶段 2：实现 First Tree MCP 工具

最小 MCP 表面：

- `read_node({ nodePath })`
- `search_nodes({ query })`
- `list_nodes({ prefix? })`

运行时行为：

- 校验 `nodePath` 是 tree 相对路径。
- 拒绝路径穿越和 tree checkout 之外的路径。
- 返回结构化内容和来源元数据。
- 对于 `read_node`，返回用于遥测的规范 `nodePath`。

### 阶段 3：接入 Codex handler 遥测

在 Codex handler 的 `mcp_tool_call` 分支中：

- 识别 First Tree MCP server/tool。
- 在成功调用 `read_node` 时，提取规范 `nodePath`。
- 发出 `context_tree_usage`。
- 不要在失败、等待中、搜索、列出或无关 MCP 调用时发出。

必需测试：

- 成功的 `read_node` 会发出 usage；
- 失败的 `read_node` 不会发出；
- 无关 MCP 调用不会发出；
- `search_nodes` 不会发出读取 usage；
- 格式错误或路径穿越的 `nodePath` 会在遥测之前被拒绝。

### 阶段 4：更新代理 briefing

更新面向 Codex 的 briefing / 生成的 `AGENTS.md` 指引：

- 使用 First Tree MCP 工具读取 Context Tree。
- 使用 `read_node` 读取具体节点。
- 使用 `search_nodes` 做发现。
- 当任务要求获取 Context Tree 上下文时，避免通过 shell 读取 tree。

提示词不应声称禁止 shell 读取；它应该解释 MCP 读取是可审计的产品路径。

### 阶段 5：改进 Context 标签页展示

- 在有用时展示读取来源：Claude Read、First Tree MCP、未来原生供应商。
- 保持当前聚合读取计数为高置信度。
- 如果产品想展示上下文发现活动，后续再加入单独的搜索活动。

---

## 6. 开放问题

1. **First Tree MCP 应该放在 CLI 包、client 包，还是共享 runtime 包中？**
   该工具需要访问本地 tree checkout，并且应复用现有配置/路径解析。

2. **是否完全应该存在 shell 尽力推断？**
   如果存在，应清晰显示为较低置信度，并默认不要混入读取计数。

3. **`search_nodes` 是否应该创建动态条目？**
   搜索是上下文发现的证据，但不是具体节点读取。

4. **代理 briefing 应该多严格？**
   更强措辞能提升遥测完整性，但可能降低代理在调试时的灵活性。

5. **该提案是否应该取代较早的 Context 标签页边界，即禁止节点级使用声明？**
   当前实现已经有逐节点 Claude 遥测。如果这个方向被接受，应修订 `first-tree-cloud/context-tab.md`，说明只有高置信度读取事件才允许节点级声明。

---

## 7. 需要决策

接受或拒绝以下方向：

1. Context 标签页动态是一个高置信度读取事实表面。
2. Codex 应通过 First Tree MCP `read_node` 进入动态列表，而不是通过任意 shell 解析。
3. 搜索/列出/浏览是独立的上下文活动信号，不是读取事件。
4. 如果未来实现低置信度 shell 推断，必须单独标记，并从默认读取计数中排除。

如果接受，下一次实现 PR 应从 MCP 读取表面和 Codex `mcp_tool_call` 遥测集成开始。
