# Agent Runtime Provider 接入设计

> **草稿 / 中文版。** 为了便于团队快速评审，本文档临时以中文撰写。讨论收敛后将重写为英文版本，以符合仓库 "English everywhere on GitHub" 约定。

**状态：** 草稿 — 待评审
**范围：** 引入 `runtimeProvider` 抽象层，把 Hub 现有"硬编码 Claude Code"演进为多 runtime 多态。第一个新接入是 OpenAI Codex CLI（基于官方 `@openai/codex-sdk@0.125.0`）。
**预研基础：** 私人 plan 文件 `~/.claude/plans/1-local-computer-agent-runtime-hazy-alpaca.md` —— 含 Phase A 离线 SDK shape 探针、Phase B 端到端 9 项行为验证、6 条 footgun、UX 决策 U1–U6 已敲定。

---

## 术语约定

| 概念 | 用词 | 含义 |
|---|---|---|
| Runtime 多态选择 | **runtime provider** | 一种 LLM CLI runtime 的标识，Hub 端 zod literal union（U5）。当前枚举：`"claude-code"` \| `"codex"`。未来追加 `"devin"` / 自研。 |
| 数据库列 | `agents.runtime_provider` | snake_case；权威字段 |
| TypeScript 字段 | `runtimeProvider` | camelCase；wire / Zod / JS |
| Client 能力 | **capabilities** | client 启动探测后上报的 "我装了哪些 SDK + 鉴权状态" 快照 |
| 切 client / 切 provider | **re-bind** | 统一术语；走同一个对话框（U2） |
| Hub 内部 LLM 子进程承接者 | **handler** | 既有概念，每个 runtime provider 对应一个 handler factory |

---

## 背景

Hub 现状是「单一 Claude Code 硬编码 + 注册表多态机制半就位」：

- `registerHandler(type, factory)` 在 [packages/client/src/runtime/handler.ts:170](../packages/client/src/runtime/handler.ts) 已经在
- `agent_presence.runtimeType` 字段 schema 注释里早就预留 `"claude-code" | "codex" | "devin"`，但只有 claude-code 一个实现
- 本地 `agent.yaml::runtime` 字段默认 `"claude-code"`，Hub 端无对应权威字段
- 配置 schema [packages/shared/src/schemas/agent-runtime-config.ts](../packages/shared/src/schemas/agent-runtime-config.ts) 五字段（prompt / model / mcpServers / env / gitRepos）以 Claude 为中心
- Web Setup section 已有 `SetupRuntimeKind = "claude-code" | "kael"`，**但 §12.1 检查发现 `kael` 是 IM 平台（与 Feishu/Slack 平级），不是 runtime kind 占位** —— P4 必须把这个类型重命名 `RuntimeProvider` 并移除 kael

OpenAI 在 2026 年发布的 `@openai/codex-sdk@0.125.0` 与 `@anthropic-ai/claude-agent-sdk` 模式高度对称（startThread / runStreamed / resumeThread / AbortSignal），让 Codex 接入可以**镜像 Claude handler 模式**而不需要自己 spawn + 解析 JSONL。SDK 包内捆绑 `@openai/codex@0.125.0` 二进制（runtime dep 严格 pinned），无须用户外部安装。

Phase A + Phase B 实测确认了 9 项关键行为，落实了 6 条 footgun，所有不确定项已扫除。

---

## 目标

1. **runtime provider 成为一等公民**。Hub 端 schema / DB / API / UI / Client / Handler 五层一致。
2. **一台 client 多 runtime 共存**。client 启动时探测装了哪些 SDK + 鉴权状态，主动上报；UI 可视化"哪台机器能跑什么"。
3. **agent 选 runtime 与选 computer 原子绑定**。创建强制选；切换走统一 re-bind 对话框（U2）。
4. **Codex 作为 first-class runtime provider 接入**。Handler 镜像 Claude 模式；配置 schema discriminated union（claude-code variant + codex variant）；UI 暴露 Codex-only 字段。
5. **不破坏 Claude 现状**。0 行 Claude handler 代码逻辑改动；Claude 配置 row 默认按 `"claude-code"` variant 解析。
6. **服务层兜底约束**。无 FK / CHECK / triggers，约束在 service（"Integrity in service layer"）。
7. **放宽 R-RUN（scope expansion）**。当前规则锁定 `agents.client_id` 不可变（要换 client 必须 delete + recreate）。本次设计明确把 client + runtime provider 视为 agent binding 的一组属性，可通过 re-bind 流程一起改。session 处理与 owner / org 校验在 service 层兜底。

---

## 非目标

- 引入 `CliRunner` / `EventMapper` 通用抽象（YAGNI；SDK 已经把进程 + 事件流抽象掉了）
- 上移 App Server JSON-RPC 协议（`thread/steer` / `thread/fork` 等当前用不到）
- 跨 client 共享 session（Codex rollout 永远本地）
- 把 Claude Code handler 重写到新抽象之上（保留现状）
- 一对多 binding（agent 同时绑多个 client）
- 自动 runtime fallback（codex 未鉴权时 fallback 到 claude-code）

---

## 1. 现状（精简，详见 plan §1–§7）

### 1.1 多态机制半就位

| 层 | 状态 |
|---|---|
| Handler 注册 | `registerHandler` / `getHandlerFactory` 已就位（单例 Map） |
| 注册入口 | [packages/client/src/handlers/index.ts](../packages/client/src/handlers/index.ts) 仅注册 `"claude-code"` |
| `AgentHandler` 接口 | 5 方法稳定，扩展 0 改 |
| Runtime 选择字段 | 仅本地 `agent.yaml::runtime`，Hub 端无权威字段 |
| Web UI | `SetupRuntimeKind` 已半成型（**kael 非 runtime 占位，是 IM 平台**；P4 重命名 + 清理） |

### 1.2 业务层 LLM-agnostic（无须改造）

- SessionManager / InputController / ResultSink / agent-io / workspace / bootstrap 全部跟具体 LLM 无关
- 新 handler 直接注入即可复用

### 1.3 Codex SDK 关键事实

- `@openai/codex-sdk@0.125.0`，80KB，依赖 `@openai/codex@0.125.0` 严格 pinned（包内捆绑二进制）
- ESM only，Node ≥ 18
- 单 dist 文件，`Codex` / `Thread` 两个 runtime export，其余全是 type-only
- Thread 无 close / dispose，**靠 AbortSignal**
- `env` 提供时不继承 process.env（footgun F1）
- `resumeThread(id)` 不继承首轮 ThreadOptions（footgun F2）

### 1.4 Hub 配置 schema

[packages/shared/src/schemas/agent-runtime-config.ts](../packages/shared/src/schemas/agent-runtime-config.ts)：5 字段 superset，存于 `agent_configs.payload` JSONB，乐观锁版本控制。

---

## 2. 数据模型设计

### 2.1 实体关系

```
Member
  └─ owns ─→ Client (local computer)
                ├─ supports many → RuntimeProvider (claude-code | codex | ...)
                └─ hosts many   → Agent
                                    └─ pinned to one → RuntimeProvider ∈ Client.capabilities
```

四条核心约束（plan §11.1）：
1. 一个 Client 上可同时支持多种 runtime provider
2. 一个 Agent 任一时刻绑 1 个 Client + 1 个 runtime provider
3. Agent 选的 provider 必须在 Client 当前 capabilities 集合内
4. Provider 选择跟 Client 绑定**原子**完成

### 2.2 表 / 列 改动（增量）

实际仓库迁移路径是 `packages/server/drizzle/`，最新已用编号 **0025_inbox_silent_entries.sql**。本设计的两条迁移用 **0026 / 0027**。

#### 2.2.1 `agents` — 新列 `runtime_provider` + 放宽 R-RUN

**现状**：[packages/server/src/db/schema/agents.ts:44](../packages/server/src/db/schema/agents.ts#L44) 把 `client_id` 标注为 "set at creation time and never changes (Rule R-RUN)"，目前换 client 必须 delete + recreate。

**本次改动**：
1. 加 `runtime_provider` 列
2. **放宽 R-RUN**：允许 service 层在 re-bind 流程中改 `client_id` + `runtime_provider`（一对原子改动）

| 字段 | 类型 | 默认值 | 备注 |
|---|---|---|---|
| `runtime_provider` | text NOT NULL | `'claude-code'` | snake_case；现有行 backfill 默认值 |

**R-RUN 放宽细则**（在 service `rebindAgent({ clientId, runtimeProvider, force })` 里）：
- 新 clientId 必须属于同一 owner（manager_id）+ 同一 organization
- 新 runtimeProvider 必须 ∈ `keys(newClient.capabilities)`（force 可绕过）
- 当前活跃 sessions 在 re-bind 提交前 suspend（[packages/server/src/services/agent-session.ts](../packages/server/src/services/agent-session.ts) 协同）
- agents.client_id FK ON DELETE 行为不变（仍 RESTRICT）

迁移策略：单步（Hub 是 stop-migrate-restart 模型，参见 [drizzle/0020](../packages/server/drizzle/0020_unified_user_token.sql) 注释；C10 检查门确认）：
- **0026**：单字段 — `agents.runtime_provider` NOT NULL DEFAULT `'claude-code'` + backfill。`clients.capabilities` 复用现有 `clients.metadata` jsonb（C 方案，无 SQL 改动），由 zod schema 与 service 层校验子键 `metadata.capabilities` 的形状

#### 2.2.2 `agent_configs.payload` — discriminated union（**无 migration，纯 schema 改动**）

[packages/server/src/db/schema/agent-configs.ts](../packages/server/src/db/schema/agent-configs.ts) 现状已是 jsonb 任意 payload，**SQL 层无需任何改动**。改动全在 zod schema [packages/shared/src/schemas/agent-runtime-config.ts](../packages/shared/src/schemas/agent-runtime-config.ts)：

| Variant | kind 值 | 共享字段 | Variant-only 字段 |
|---|---|---|---|
| Claude | `"claude-code"` | prompt / model / mcpServers / env / gitRepos | （保持不变） |
| Codex | `"codex"` | 同上 | 不在本期暴露（按用户偏好 §6） |

**Zod 解析路径**（C3 修订）：

`z.discriminatedUnion("kind", [...])` 严格要求 `kind` 字段存在；旧行没 `kind` 会 parse 失败。用 `z.preprocess` 包一层在 parse 前补默认值：

```
agentRuntimeConfigPayloadSchema = z.preprocess(
  (input) => {
    if (input && typeof input === "object" && !("kind" in input)) {
      return { ...input, kind: "claude-code" };
    }
    return input;
  },
  z.discriminatedUnion("kind", [claudePayloadSchema, codexPayloadSchema]),
)
```

写侧：每次 PATCH 后服务把 `kind` 写回 payload；老行被读到 + 写回时自然落地 kind 字段。**不需要 SQL UPDATE / 软窗口**（C1 修订）。

服务层硬约束：`payload.kind === agents.runtime_provider`，不一致 reject。

#### 2.2.3 `clients.metadata.capabilities` — 复用现有 `clients.metadata` jsonb（C 方案）

[clients.ts:39](../packages/server/src/db/schema/clients.ts#L39) 现有 `metadata jsonb` 字段（nullable，无 default）几乎闲置，仅 [client service](../packages/server/src/services/client.ts) 透传一处。**复用为 capabilities 容器**，避免新加列：

| 路径 | 形态 | 备注 |
|---|---|---|
| `clients.metadata.capabilities` | jsonb 子键 | 形状与 §2.3 zod schema 一致（含每 provider 的 state / sdkVersion 等） |

**SQL 改动**：无（不动 metadata 列定义）。
**Read 兜底**：service 提取 `client.metadata?.capabilities ?? {}`。
**Write 路径**：`PATCH /api/v1/clients/:clientId/capabilities` endpoint 写入 `metadata.capabilities` 子键，不影响其他 metadata 子键（如 future 集成扩展）。
**约束**：service 层用 zod 校验 `metadata.capabilities` 子键的形状（独立 `clientCapabilitiesSchema`，不污染 metadata 顶层 schema）。
**查询**：未来若要 "列出装了 codex 的 client"，加 expression index `((metadata->'capabilities'->'codex'))`（post-MVP）。

JSONB 形状（zod 单独定义于 shared）：

```
{
  "claude-code": {
    state: "ok" | "missing" | "unauthenticated" | "error",
    available: boolean,            // 派生：state ∈ {ok, unauthenticated}
    authenticated: boolean,        // 派生：state === "ok"
    sdkVersion: string?,           // 仅 available 时填
    authMethod: "api_key" | "oauth" | "none",
    error: string?,                // 仅 state === "error" 时填
    detectedAt: ISO8601 timestamp
  },
  "codex": {
    state: "ok" | "missing" | "unauthenticated" | "error",
    available: boolean,
    authenticated: boolean,
    sdkVersion: string?,           // 仅 available 时填
    authMethod: "auth_json" | "api_key" | "none",
    error: string?,
    detectedAt: ISO8601 timestamp
  }
  // 未来 provider 自然扩展
}
```

`state` 是权威字段；`available` / `authenticated` 是派生 boolean，保留方便简单查询。UI 用 `state` 决定图标 / 文案。

迁移：0026 同时加该列，老 client 上线后自然填充。

#### 2.2.4 `agent_presence.runtime_type` — 现状保持 + mismatch reject

[agent-presence.ts](../packages/server/src/db/schema/agent-presence.ts) 字段已存在。语义分工：
- `agents.runtime_provider`（**配置权威**）：用户期望的 runtime
- `agent_presence.runtime_type`（**运行时实际**）：client 当前实际跑的 runtime

[agent-bind frame schema](../packages/shared/src/schemas/presence.ts) 已经包含 `runtimeType` + `runtimeVersion`，无需新增协议字段。

**Mismatch 处理（Gap-1 + B2 修订）**：
- `presenceService.bindAgent({ agentId, runtimeType, ... })` 调用前，service 层加校验：`runtimeType === agents.runtime_provider`
- 不一致时返回 `agent:bind:rejected` 帧 reason = `runtime_provider_mismatch`；这要求 [shared/schemas/presence.ts:62](../packages/shared/src/schemas/presence.ts#L62) 的 `AGENT_BIND_REJECT_REASONS` 加新枚举值 + `agentBindRejectReasonSchema` 同步扩展
- Client 收到该 reject reason 后走 repair path：通过 member-scoped admin API 重 fetch 权威 `runtime_provider`，重写本地 `agent.yaml`，重新 spawn handler，再次 bind
- 一致时正常写入 `agent_presence.runtime_type`，长期一致是健康信号

### 2.3 Capabilities 探测协议

| 维度 | 决定 |
|---|---|
| 时机 | client 启动 ClientConnection.connect 之前 |
| 探测方式 | **独立 capability modules**（C2 修订；不扩展 [HandlerFactory](../packages/client/src/runtime/handler.ts#L149) 接口）：每个 provider 一个 `<provider>-capability.ts` 模块导出 `probeCapability(): Promise<CapabilityEntry>`；`capabilities.ts` 编排器调用所有内置 modules 汇总 |
| 上报路径 | client → server，**`PATCH /api/v1/clients/:clientId/capabilities`**（B4 修订）；走 memberAuth；service 层校验 `clients.user_id === jwt.userId` 才允许 update |
| 鉴权 | member JWT（不存在 client token，已由 PR #95 / 0020 unified-user-token 废弃） |
| 重新探测触发 | 启动时 + 鉴权状态变更（监听 `~/.codex/auth.json` mtime / ANTHROPIC_API_KEY env 变化）+ TTL 5 分钟兜底 |
| 静默失败保护 | 探测异常不阻塞启动；exception → `state="error", error=<msg>` |
| Stale 处理 | client offline 时仍读上次 capabilities，UI 显示 `last reported X ago` |

### 2.4 服务层约束（"Integrity in service layer"）

无 FK / CHECK / triggers。所有约束在 service：

| 约束 | 实现位置 |
|---|---|
| `agents.runtime_provider ∈ keys(client.metadata.capabilities)` | Agent service `createAgent` / `updateAgent` |
| `agent_configs.payload.kind === agents.runtime_provider` | AgentConfig service `patchConfig` |
| Capabilities mismatch 默认 block，可 force（U3） | Service layer `force: boolean` 参数 |
| Client capabilities update 鉴权 | memberAuth + service 校验 `clients.user_id === jwt.userId`（B4 修订；不存在 client token） |
| Re-bind 时 sessions 暂停 | 跨 service 协同：Agent + Inbox + Presence |

### 2.5 Schema 形态（U5）

shared 包定义：

```
runtimeProviderSchema = z.enum(["claude-code", "codex"])
type RuntimeProvider = z.infer<typeof runtimeProviderSchema>
```

新增 provider = 改这一行 union + 新增 handler 文件 + 新增 capabilities probe；schema 演进零迁移。

---

## 3. UX 设计

### 3.1 创建 Agent

| 步骤 | 字段 | 行为 |
|---|---|---|
| 1 | Display name / type | 跟现状一致 |
| 2 | Local Computer | 必选；列出 member 的 clients；显示 online + capabilities 摘要 |
| 3 | Runtime provider | 字段在 Computer 选定后激活；列表 = `keys(client.metadata.capabilities)` ∪ hub 端硬编码 future（灰色禁用 + 安装指引） |
| 默认值 | 优先 claude-code（向后兼容），否则按 capabilities 第一个 available + authenticated |
| Lock | 创建后 provider 与 client 一起锁定（locked after creation rhetoric 跟现有一致） |

### 3.2 Re-bind Agent（统一对话框，U2）

切 Computer / 切 Runtime / 都改 → 走同一个对话框。

| 字段 | 行为 |
|---|---|
| Computer | 下拉框，预填当前；切换时显示新 client capabilities 摘要 |
| Runtime provider | radio 列表 = 选中 Computer 的 capabilities；不支持的灰禁 + 安装提示 |
| 警告 1（永远显示） | "Current sessions on `<from>` will be suspended. Chat history is preserved." |
| 警告 2（仅 provider 切换时显示） | "Some config fields won't transfer between providers (claude permission_mode dropped, codex sandboxMode reset to default)." |
| Re-bind 按钮 | 选择对比当前无变化时 disabled |
| Force 选项（U3） | mismatch 时显示 "Override capability check"，需用户确认 |

### 3.3 Settings → Computers 能力一览

每台 client 一行卡片，显示：
- online / offline + last seen
- 各 runtime provider 的 available + sdkVersion + authenticated + authMethod
- 未装的 runtime provider 灰色 + 安装指引链接

UX 目标：一页看完用户所有 computer 的能力分布，引导后续 agent 创建/迁移决策。

### 3.4 Codex 未鉴权状态（U6）

`available=true, authenticated=false` 时：
- Re-bind 对话框：选项可见但带 "⚠ Click for instructions" 提示
- Settings 页 Computers 一览：单独 surface "Run `codex login` on this computer" 引导
- 创建 agent 后：handler 启动时若仍未鉴权，turn 失败但不 crash agent；用户能看到 error message

---

## 4. Codex Handler 实现

### 4.1 模块结构（增量）

| 路径 | 状态 | 内容 |
|---|---|---|
| `packages/client/src/handlers/codex.ts` | **新建** | Codex handler factory，~250 行（vs Claude 959 行） |
| `packages/client/src/handlers/index.ts` | 修改 | 注册 `"codex"` factory |
| `packages/client/src/runtime/bootstrap.ts` | 修改 | 把 `generateClaudeMd` 改名为 `generateAgentBriefing(format: "claude" \| "agents-md")`，新增 `AGENTS.md` 写出分支（Codex 默认读取）；**写 `.first-tree-workspace` 空文件作为 codex project root marker（Gap-2）**，避免 codex 向上 walk 文件系统找 AGENTS.md |
| `packages/client/src/runtime/capabilities/index.ts` | **新建** | `probeCapabilities()` 编排：调用每个 provider 的 capability module 汇总（C2 修订；放 capabilities/ 子目录，独立模块不扩展 HandlerFactory） |
| `packages/client/src/runtime/capabilities/codex.ts` | **新建** | Codex SDK import 试 + 鉴权探测（CODEX_API_KEY / `~/.codex/auth.json`） |
| `packages/client/src/runtime/capabilities/claude-code.ts` | **新建** | Claude SDK 探测（与 codex.ts 平级） |

注意：**不需要** `codex-executable.ts` —— SDK 包内捆绑二进制，`codexPathOverride` 默认即可（详见 plan §10.5）。

### 4.2 SDK 集成要点

| 维度 | 决定 |
|---|---|
| SDK 包 | `@openai/codex-sdk@^0.125.0`（**stable latest as of 2026-04-28**；0.126.x 仍处 alpha 不固定），加入 `packages/client/package.json` 依赖 |
| 调用模式 | `new Codex(opts).startThread(threadOpts).runStreamed(input, { signal })` |
| Resume | 持久化 `thread.id` + 首轮 ThreadOptions 在 hub session state；每次 resume 重传（footgun F2） |
| Shutdown | 不依赖手动信号；调用 `abortController.abort()`（footgun F6） |
| Inject | 单 turn run-to-completion 不支持中途 inject；buffer 消息，turn 完成后自动 resumeThread().run(buffered) |

### 4.3 ThreadOptions 默认值

| 字段 | 默认值 | 理由 |
|---|---|---|
| `model` | `"gpt-5-codex"`（或 SDK 默认） | 单一推荐 |
| `sandboxMode` | `"workspace-write"` | 跟 Claude `bypassPermissions` 信任域对齐；agent workspace 是隔离区 |
| `approvalPolicy` | `"never"` | hub 已假设 client = 信任域，不弹 approval |
| `modelReasoningEffort` | `"high"` | minimal 与默认工具不兼容（footgun F3）；high 给最佳推理 |
| `webSearchEnabled` | `false` | hub 已有自己的 MCP 工具策略；避免 minimal 兼容问题（footgun F3） |
| `additionalDirectories` | `gitRepos[].localPath` | 把 hub `gitRepos` 字段映射进去 |
| `skipGitRepoCheck` | `true` | workspace 是 hub 自管目录，不一定 git init |
| `workingDirectory` | hub-acquired workspace 路径 | 复用 `acquireWorkspace` |
| `config.project_root_markers` | `["first-tree-workspace"]` | **Gap-2**：让 codex 把 walk-up 截在 workspace；配合 bootstrap 写的 `.first-tree-workspace` 空文件 |

### 4.4 配置字段映射

Hub 5 字段（`agentRuntimeConfigPayloadShape`）→ Codex SDK：

| Hub 字段 | Codex 注入方式 |
|---|---|
| `prompt.append` | 拼到 user prompt 前缀（Codex 没有独立 system prompt 字段；`<context>...</context>` 包裹） |
| `model` | `ThreadOptions.model`，alias 翻译表（claude alias `"opus"` → codex `"gpt-5-codex"`） |
| `mcpServers[]` | 翻译为 `CodexOptions.config.mcp_servers.<name>.{command,args,url,headers}`（TOML 路径式 nested object） |
| `env[]` | 透传到 `CodexOptions.env`，必须 explicit merge process.env（footgun F1） |
| `gitRepos[]` | gitMirrorManager 在 workspace 下材化 worktree；额外塞进 `additionalDirectories` |

### 4.5 SessionEvent 翻译

Codex `ThreadEvent` → hub `SessionEvent`：

| Codex Event | Hub SessionEvent | 备注 |
|---|---|---|
| `thread.started` | （记录 `thread.id`） | 触发 `setRuntimeState("working")` |
| `turn.started` | （内部） | — |
| `item.started` / `item.updated` | 暂忽略（仅终态发） | 与 Claude handler 当前流式策略一致 |
| `item.completed: agent_message` | `assistant_text` | text payload |
| `item.completed: command_execution` | `tool_call` (status, command, exit_code) | hub UI 显示为 bash 工具 |
| `item.completed: file_change` | `tool_call` (changes[]) | 翻译为 file ops 列表 |
| `item.completed: mcp_tool_call` | `tool_call` (server, tool, arguments, result) | 直接 1:1 |
| `item.completed: reasoning` | （可选 surface） | hub 当前不显示 Claude 的 thinking blocks，对齐做法 |
| `item.completed: web_search` / `todo_list` | `tool_call` | 通用包装 |
| `item.completed: error` | `error` | 非 fatal |
| `turn.completed` | `turn_end` + usage 上报 | — |
| `turn.failed` | `error` | — |
| `error` | `error` | fatal |

### 4.6 Footgun 处理

| # | Footgun | 处理 |
|---|---|---|
| F1 | `env` 不继承 process.env | `buildAgentEnv` explicit merge `process.env` |
| F2 | `resumeThread` 不继承 ThreadOptions | session state 持久化首轮 options，每次 resume 重传 |
| F3 | `minimal` reasoning + 默认工具不兼容 | 默认值 `"high"` + `webSearchEnabled: false` |
| F4 | sandbox 拦截不发 `command_execution` event | UI 不依赖该事件枚举所有命令尝试；assistant_text 文本是补充信号 |
| F5 | MCP server 启动失败静默 | handler `start()` 启动后等 N 秒检查 codex 自报的 MCP 状态，写入 client 日志（P3） |
| F6 | Thread 无 close | shutdown 用 AbortController.abort() |

---

## 5. 阶段推进

| Phase | 范围 | CC effort | 可发布性 |
|---|---|---|---|
| **P1 — Schema + Migration** | shared 包加 `runtimeProviderSchema` + `clientCapabilitiesSchema` + agent-runtime-config discriminated union；server 仅加 `agents.runtime_provider` 列（C 方案：clients.capabilities 走 `metadata.capabilities` 子键）；service 校验逻辑 | ~1 CC 半天 | DB 可发布；不带 UI；老 client 不受影响 |
| **P2 — Capabilities 上报** | client 端 `probeCapabilities()`；启动时 + auth 变化时 → PATCH `/api/v1/clients/:clientId/capabilities`；server 端 endpoint（memberAuth + user_id 校验） | ~1 CC 半天 | client 上线后 capabilities 自动填充 |
| **P3 — Codex Handler** | `codex.ts` handler + SDK 依赖 + bootstrap 加 `AGENTS.md`；index.ts 注册 | ~1.5 CC 半天 | client 端可跑 codex；UI 还没；用户走 API 设 `runtime_provider="codex"` 才能用 |
| **P4 — UI runtime selector + Re-bind** | agent-detail / setup-section 加 runtime picker；re-bind dialog；Computers 能力一览 | ~2 CC 半天 | 完整可用 |
| **P5 — Codex 独有字段（可选，按需）** | `agent_configs.payload` codex variant 加 `sandboxMode` / `approvalPolicy` / `modelReasoningEffort`；UI 条件渲染 | ~1 CC 半天 | 增强；不阻塞 P4 |

**总计 P1–P4 = ~5.5 CC 半天**（不含 P5）。

> CC 半天定义：在私人 plan §10.8 已经把 handler 估到 ~250 行（vs Claude 959）；其他工作量按现仓库类似改动经验估。

---

## 6. 迁移与回滚

### 6.1 Forward path（向前）

| Step | 改动 | 风险 |
|---|---|---|
| 0026 migration | 单步、单列：`agents.runtime_provider` NOT NULL DEFAULT `'claude-code'` + backfill。`clients.capabilities` 走 `metadata.capabilities` 子键（C 方案，无 SQL 改动） | 低（stop-migrate-restart 模型，无 rolling deploy 间隙问题） |
| `command` 包发布 | tarball 发布（CI / 手动 tag 触发） | 低 |
| 老 client 兼容 | 老 client 没 capabilities 上报 → server 容忍 `'{}'`，UI 显示 "Capabilities not yet reported" | 低 |
| Schema discriminated union | 读端兼容：missing `kind` → `"claude-code"`；写端补 `kind` | 低 |

### 6.2 Backward path（回滚）

如发现严重问题：

| 阶段 | 回滚方式 |
|---|---|
| P1 已上线 | 不回滚 schema（NOT NULL flip 后）；通过 service 屏蔽 codex provider 选项 |
| P2 已上线 | client 停止 capabilities 上报无影响（默认 `'{}'`） |
| P3 已上线 | UI / API 屏蔽 `runtime_provider="codex"`；已配 codex 的 agent 退到 claude-code（service 层 force 改回） |
| P4 已上线 | 同 P3 + 隐藏 UI runtime picker（feature flag） |

### 6.3 Feature flag

P3 / P4 上线时建议加 hub config flag `codexRuntimeEnabled`（默认 false → true 切换），能在事故时快速关停 codex provider。

---

## 7. 风险与开放问题

继承私人 plan §11.8 + §10.7 的合并集：

| # | 项 | 严重 | 缓解 |
|---|---|---|---|
| R-DM1 | client capabilities 上报与 agent 创建 race | 中 | UI 等 client online + capabilities `detectedAt` 不为空（loading） |
| R-DM2 | 离线 client capabilities 时效 | 低 | UI "stale, last reported X ago"；force 选项 |
| R-DM3 | hub 端硬编码"未装"列表 | 低 | runtime provider 主表（小，纯展示） |
| R-DM4 | 鉴权状态频繁变化 | 低 | 文件 mtime watch + 5min TTL 兜底 |
| R-DM6 | `agent.yaml` `runtime` 与 hub 权威分歧 | 低 | client 启动时若不一致 → warning log + 以 hub 为准 |
| F1–F6 | SDK footgun | 中 | §4.6 已处理 |
| R-CD1 | Codex SDK 0.x 版本变动风险 | 中 | pin minor，每次升级前重跑 Phase B 9 项 |
| R-CD2 | OpenAI Responses API endpoint 变动 | 低 | SDK 版本对齐时一并升级 |

### 已敲定的设计点（之前的开放问题）

1. **`runtime_provider` schema 演进策略**：✅ **决定：保持 zod literal union**，YAGNI。新增 provider = 改一行 union + 新增 handler 文件 + 新增 capability probe，无需运行时 schema 表。
2. **Capabilities probe 失败模式细分**：✅ **决定：单独区分** probe 抛错 vs unauthenticated。capability entry 增加显式状态字段 `state: "ok" | "missing" | "unauthenticated" | "error"`，UI 用不同图标呈现。`available` / `authenticated` 两个 boolean 仍然保留（向后兼容简单查询），但 `state` 是真值：
   - `ok` = available + authenticated
   - `missing` = SDK 未装 / 二进制缺失
   - `unauthenticated` = SDK 装了但鉴权失败
   - `error` = probe 抛错（写入 `error: string`）
3. **Re-bind 时 codex thread 数据保留**：✅ **决定：保留**。旧 `~/.codex/sessions/<id>/` rollout 文件不立即清理（用户日后可能回退）。**Post-MVP** 加 7 天定时清理任务（cron job 检查 mtime）。
4. **Multi-tenant 视角**：✅ **决定：`clients.metadata.capabilities` 仅 owner 可见**，与 `clients` 表现有 RBAC 一致（`userId == jwt.userId`）。Capabilities 包含 SDK 版本与鉴权方式，属于半敏感信息。

---

## 8. 验证

### 8.1 已完成（plan Phase A + Phase B）

| 项 | 结果 |
|---|---|
| SDK 类型 / 包结构 | 全部对齐（plan §10.1–§10.5） |
| 流式事件 schema | B1 通过 |
| CODEX_HOME 隔离 | B2 通过 |
| resumeThread 跨实例 | B3 通过（footgun F2 已记录） |
| Sandbox + Approval | B4 通过（footgun F4 已记录） |
| ReasoningEffort | B5 通过（footgun F3 已记录） |
| MCP 注入接口 | B6 通过（footgun F5 已记录） |
| AbortSignal | B7 通过（0 孤儿） |
| local_image 输入 | B8 通过 |
| API key 三层路径 | B9 通过 |

### 8.2 实施期需做（P1–P4 合并验证）

| 阶段 | 验证项 |
|---|---|
| P1 | shared zod schema 单元测试；agent_configs discriminated union 读写兼容；mismatch reject |
| P2 | client 启动 capabilities 上报；offline 后再上线刷新；auth 变化触发上报 |
| P3 | 端到端：创建 codex agent → 发消息 → 收到回复；resume 跨进程；abort 中断；MCP 配置生效 |
| P4 | UI 流：创建 agent + 选 codex；re-bind dialog 切 provider；Settings → Computers 显示 capabilities；force override 路径 |

### 8.3 回归测试

不破坏 Claude path：
- 老 agent_configs 行（无 `payload.kind`）能继续读 + 编辑
- 老 client（无 capabilities 上报）老 agent 能继续工作
- 现有 Claude handler 0 行逻辑改动（仅 capabilities probe 模块新加）

---

## 9. 实施顺序与文件清单

### 9.1 P1 (shared + server)

| 文件 | 改动 |
|---|---|
| `packages/shared/src/schemas/runtime-provider.ts` | **新建** — `runtimeProviderSchema = z.enum([...])` |
| `packages/shared/src/schemas/client-capabilities.ts` | **新建** — capabilities JSONB shape |
| `packages/shared/src/schemas/agent-runtime-config.ts` | 改 — `z.preprocess` 包 `discriminatedUnion("kind", [...])`，缺失 kind 默认补 `"claude-code"`（C3 修订） |
| `packages/shared/src/schemas/agent.ts` | 加 `runtimeProvider` 字段 |
| `packages/server/src/db/schema/agents.ts` | 加 `runtimeProvider` 列 |
| `packages/server/src/db/schema/clients.ts` | **不动列定义**（C 方案：复用 `metadata.capabilities` 子键） |
| `packages/server/drizzle/0026_runtime_provider.sql` | **新建** — 单步、单列：`agents.runtime_provider NOT NULL DEFAULT 'claude-code'` + backfill；`clients` 表无 SQL 改动（drizzle-kit 生成） |
| `packages/server/src/services/agent.ts` | 加 `runtime_provider ∈ capabilities` 校验；**B1 修订**：`createAgent` / `rebindAgent` 推送 `agent:pinned` 时填 `runtimeProvider` 字段 |
| `packages/server/src/services/agent-config.ts` | 加 `payload.kind === runtime_provider` 校验 |
| `packages/server/src/api/agent/ws-client.ts` | **B2 修订**：`agent:bind` handler 在 `presenceService.bindAgent` 前加 `runtimeType === agents.runtime_provider` 校验，不一致返回 `agent:bind:rejected` reason `runtime_provider_mismatch` |

### 9.2 P2 (client capabilities + Hub 权威启动同步)

| 文件 | 改动 |
|---|---|
| `packages/client/src/runtime/capabilities/index.ts` | **新建** — `probeCapabilities()` 编排（C2 修订：放 capabilities/ 子目录，独立模块不扩展 HandlerFactory） |
| `packages/client/src/runtime/capabilities/claude-code.ts` | **新建** — `probeCapability()` Claude SDK 探测 |
| `packages/client/src/runtime/capabilities/codex.ts` | **新建** — `probeCapability()` Codex SDK 探测 |
| `packages/client/src/runtime/runtime.ts` | 修改 — **B3 修订**：startup 用 member JWT 调 `GET /api/v1/clients/me/agents` 拉权威 `runtime_provider`，覆盖本地 yaml；`getHandlerFactory(authoritativeProvider)` 选 handler；后续 probe + 上报 capabilities |
| `packages/client/src/sdk.ts` | 修改 — 新增 `updateCapabilities()` + `listMyAgents()` SDK methods |
| `packages/command/src/core/client-runtime.ts` | **B1 修订**：[L248](../packages/command/src/core/client-runtime.ts#L248) `handleAgentPinned` 用 `message.runtimeProvider` 替代硬编码 `"claude-code"`，写入本地 `agent.yaml::runtime` |
| `packages/client/src/runtime/repair.ts` | **新建** — bind reject reason `runtime_provider_mismatch` 处理：member JWT 拉权威值 → 重写 yaml → 关 handler instance → spawn 正确 handler → 重新 bind |
| `packages/server/src/api/clients.ts` | 修改 — PATCH `/api/v1/clients/:clientId/capabilities` 路由（memberAuth + service 层 `clients.user_id === jwt.userId` 校验） |

### 9.3 P3 (Codex handler)

| 文件 | 改动 |
|---|---|
| `packages/client/package.json` | 加 dep `@openai/codex-sdk@^0.125.0` |
| `packages/command/package.json` | **Gap-4**：build 脚本加 `--external @openai/codex-sdk` flag（与 `@anthropic-ai/claude-agent-sdk` 对称处理）；codex SDK 包内 codex 二进制随 npm install 自然就位 |
| `packages/client/src/handlers/codex.ts` | **新建** — handler factory |
| `packages/client/src/handlers/index.ts` | 修改 — 注册 codex |
| `packages/client/src/runtime/bootstrap.ts` | 修改 — `generateAgentBriefing(format)` + `AGENTS.md` 写出 |
| `packages/client/src/__tests__/codex-handler.test.ts` | **新建** — 单元测试 + fixtures |

### 9.4 P4 (Web UI)

| 文件 | 改动 |
|---|---|
| `packages/web/src/pages/agent-detail/setup-section.tsx` | 把 `SetupRuntimeKind = "claude-code" \| "kael"` 改为 `RuntimeProvider = "claude-code" \| "codex"`（**Gap-3**：移除 kael，因 kael 是 IM 平台不是 runtime kind）；渲染 capabilities |
| `packages/web/src/components/new-agent-dialog.tsx` | **Gap-3**：把 `Runtime = "claude-code" \| "kael"` 类型改为 `RuntimeProvider`；移除 kael；加 codex |
| `packages/web/src/pages/agents.tsx` | **Gap-3**：`handleCreated` 函数签名 `runtime: "claude-code" \| "kael"` → `runtimeProvider: RuntimeProvider`；移除 kael 分支 |
| `packages/web/src/pages/agent-detail.tsx:410` | **Gap-3**：清理"kael" runtime 注释与误用 |
| `packages/web/src/pages/agent-detail/re-bind-dialog.tsx` | **新建** — 统一 re-bind 对话框 |
| `packages/web/src/pages/settings/computers-section.tsx` | **新建** — Computers 能力一览 |
| `packages/web/src/api/agents.ts` | 加 `rebindAgent({ clientId, runtimeProvider, force })` |
| `packages/web/src/api/clients.ts` | 加 `getCapabilities(clientId)` |

**注**：`packages/web/src/pages/binding-form.tsx` 与 `bindings.tsx` 的 `kael` 是另一种语义（IM 平台 binding，与 Feishu/Slack 平级），**保持不动**。

---

## 10. 文档与跟进

- 本设计文档（待评审通过后重写英文版）
- 评审通过后更新：
  - [docs/cli-reference.md](cli-reference.md) — 加 `agent config set-runtime` 命令（如新增）
  - [docs/claim-agent-guide.md](claim-agent-guide.md) — 加 codex 相关章节
  - 新建 `docs/codex-onboarding.md`（codex login 引导 + 鉴权说明，对应 U6）
- Phase 推进时分别开 PR：每个 Phase 一 PR，`packages/command` 版本按规则 bump

---

## 12. 实施前检查门（Pre-Implementation Gate）

> 在 P1 启动前对仓库现有事实做的全面核查（C1–C11）。下方仅记 **会改设计** 与 **会简化设计** 的关键发现；完整检查项 + 路径详情见 plan §12 / 各 Explore agent 报告。

### 12.1 ⚠️ Critical（必须更新设计的发现）

**C6-A — Web 中 `"kael"` 是 IM 平台不是 LLM runtime**

[packages/web/src/components/new-agent-dialog.tsx:55](../packages/web/src/components/new-agent-dialog.tsx#L55) 与 [packages/web/src/pages/agents.tsx:147](../packages/web/src/pages/agents.tsx#L147) 现有 `type Runtime = "claude-code" | "kael"`，但 [packages/web/src/pages/binding-form.tsx](../packages/web/src/pages/binding-form.tsx) 中 `kael` 是与 feishu / slack 平级的 **外部 IM 平台**（带 `kaelUserId` / `kaelProjectId` 字段）。

**两个 kael 概念不同**：UI 一处把它当 runtime kind，绝大多数地方当 IM platform。

**对设计的影响**：
- 我们的 `runtime_provider` zod literal union 只包括 `"claude-code" | "codex"`，**绝不**包括 `"kael"`
- P4 UI 改造时必须把 `Runtime` 类型重命名为 `RuntimeProvider`，把 `kael` **从 union 移除**（kael 在 IM binding 维度处理，跟 LLM runtime 无关）
- 这是 scope 项，需在 P4 文件清单加一条："清理 new-agent-dialog.tsx + agents.tsx 的 kael runtime 误用"

**C7-A — Codex AGENTS.md 行为：directory walk-up 到 git root**

deepwiki 抓取 codex 源码确认：codex 从 cwd 向上 walk 找 AGENTS.md，直到 project root（默认 `.git` marker）。**Hub workspace 不一定 git init**，可能 walk 到文件系统根，拾起不期望的 AGENTS.md（如 hub 本身 repo 的）。

**对设计的影响**：
- `bootstrapWorkspace` 必须确保 workspace 是 codex 认可的 project root
- 两条路径任选其一：
  - **(a) `git init` workspace**（轻量；workspace 已经是 hub 自管目录，empty git repo 无副作用）
  - **(b) `project_root_markers` 配置**：在 `CodexOptions.config` 加自定义 marker 如 `["first-tree-workspace"]`，bootstrap 写一个空文件 `.first-tree-workspace`
- 推荐 **(b)** —— 不引入 git 概念，且 marker 文件可作为 workspace 自识别

§4.1 模块清单需新增：bootstrap 写 `.first-tree-workspace` marker；`CodexOptions.config.project_root_markers = ["first-tree-workspace"]`

**C10 — Hub 不走 rolling deploy，single migration 即可**

[packages/server/drizzle/0020_unified_user_token.sql](../packages/server/drizzle/0020_unified_user_token.sql) 注释明确："operators stop SDK/CLI processes, run migration, restart" — Hub 是 stop-migrate-restart 模型。

**对设计的影响**：
- §2.2.1 / §6.1 / §9.1 拆 0026 + 0027 两步迁移是**过度设计**
- 改为：**单步 0026 直接 `NOT NULL DEFAULT 'claude-code'`** + backfill
- 节省一次 release 周期

### 12.2 ✓ Important（简化设计的发现）

**C3-A — `agent:bind` 帧已经带 `runtimeType`**

[packages/shared/src/schemas/presence.ts:55-59](../packages/shared/src/schemas/presence.ts#L55) 现状：

```
agentBindRequestSchema = z.object({
  agentId: z.string().min(1),
  runtimeType: z.string().max(50),
  runtimeVersion: z.string().max(50).optional(),
})
```

**对设计的影响**：
- 不需要改 `agent:bind` frame schema
- client 上报的 `runtimeType` 直接对应我们的 `runtime_provider` —— 命名差异在 §12.4 单独处理
- `presenceService.bindAgent` 已经写入 `agent_presence.runtime_type`，对接现有路径

**C5-A — agent_configs 历史从未有 `kind` 字段**

迁移 0019 起的 payload 形态：`{prompt, model, mcpServers, env, gitRepos}`，**所有现存行都没 `kind`**。

**对设计的影响**：
- 读侧默认补 `kind="claude-code"` 是唯一兼容路径
- 不需要 SQL UPDATE 批量补 kind（service 层每次 PATCH 时回写就够了）
- 软窗口可以去掉

**C9 — tsdown 已经把 Anthropic SDK 设为 `--external`**

[packages/command/package.json](../packages/command/package.json) build 命令：`tsdown ... --external @anthropic-ai/claude-agent-sdk && node scripts/embed-assets.mjs`

**对设计的影响**：
- 加 `@openai/codex-sdk` 到 dependencies + 加 `--external @openai/codex-sdk` build flag
- 包内 codex 二进制随 npm install 自然就位（与 Anthropic SDK 同模式）
- 不需要改 embed-assets.mjs

### 12.3 ✓ Confirmed（验证设计假设）

| 项 | 结论 |
|---|---|
| **C1** R-RUN enforcement | 4 处：service / middleware / WS handler / schema 注释。放宽实际改动 ~250-310 行 |
| **C2** updateAgent schema | 已允许 clientId 字段，仅 service 层 reject —— 删 4 行 immutability 检查 + 新加 `rebindAgent` 函数即可 |
| **C7-Q2** CODEX_HOME 在 cwd 子目录 | 安全：codex 不扫 home 作 project content；sandbox 允许写 home 但每 chat 独立避免 race |
| **C11** 老 client 兼容 | server 走 `passthrough()`；新增 `client:capabilities` 帧老 client 不发即可 |

### 12.4 ⚠️ 设计漏掉的 4 个细节（必须补）

**Gap-1 — `runtime_type` (presence) 与 `runtime_provider` (agents) 命名分工要明文写**

§2.2.4 现有的"二者解耦"描述不足以指导实施。需明确写入 §12.5 决策：

- `agents.runtime_provider`（**配置权威**）：用户期望该 agent 跑哪种 runtime
- `agent_presence.runtime_type`（**运行时实际**）：client 当前实际跑的 runtime
- **mismatch 行为**：client 上报 `runtime_type` 与 hub `runtime_provider` 不一致时，`presenceService.bindAgent` **拒绝绑定**，触发 client 重启 handler 或重 fetch config

**Gap-2 — workspace project root marker（继 C7-A）**

`bootstrapWorkspace` 加一步：写一个 `.first-tree-workspace` 空文件作为 codex 的 project root marker。

**Gap-3 — Web "kael" runtime 误用清理列入 P4**

P4 文件清单加一行：清理 new-agent-dialog.tsx + agents.tsx 的 `Runtime = "claude-code" | "kael"` 类型，重命名为 `RuntimeProvider` 并移除 kael。

**Gap-4 — tsdown `--external @openai/codex-sdk`**

P3 文件清单加一行：[packages/command/package.json](../packages/command/package.json) build 脚本添加 `--external @openai/codex-sdk` flag。

### 12.5 检查门最终决策

| 项 | 处理 |
|---|---|
| 0026 + 0027 拆两步 | **取消**，合并为单步 0026 `NOT NULL DEFAULT 'claude-code'` |
| `bootstrapWorkspace` 写 `.first-tree-workspace` marker | **加** |
| `CodexOptions.config.project_root_markers = ["first-tree-workspace"]` | **加** |
| `runtime_type` ↔ `runtime_provider` mismatch reject | **加 service 层校验** |
| Web `Runtime = "claude-code" \| "kael"` 类型 | **重命名为 RuntimeProvider 并移除 kael**（P4） |
| `--external @openai/codex-sdk` | **加** P3 build 配置 |

### 12.6 §6.1 修订

原"0026 + 0027 两步"改为单步：

| Step | 改动 | 风险 |
|---|---|---|
| 0026 migration | 一次性、单列：`agents.runtime_provider` NOT NULL DEFAULT `'claude-code'` + backfill。`clients.capabilities` 走 `metadata.capabilities` 子键（C 方案，无 SQL 改动） | 低（stop-migrate-restart 模型，无 rolling deploy 间隙问题） |

`packages/server/drizzle/0027_runtime_provider_not_null.sql` 从 §9.1 文件清单中**删除**。

### 12.8 Codex 二轮 review 反馈（已落实）

Codex agent 对前述设计做了 review，提出 4 个 critical gap + 3 个矛盾。逐项核实全部成立，已修订。

| # | 反馈 | 修订位置 |
|---|---|---|
| **B1** | `agent:pinned` 帧漏 `runtimeProvider`，[client-runtime.ts:248](../packages/command/src/core/client-runtime.ts#L248) 硬编码 `runtime: "claude-code"` 会让 codex agent 落地成 Claude | §9.1 文件清单加 [shared/schemas/agent.ts:177](../packages/shared/src/schemas/agent.ts#L177) `agentPinnedMessageSchema` 加字段；§9.1 加 [command/src/core/client-runtime.ts:248](../packages/command/src/core/client-runtime.ts#L248) 改用 `message.runtimeProvider` |
| **B2** | `RUNTIME_PROVIDER_MISMATCH` 不在 [presence.ts:62](../packages/shared/src/schemas/presence.ts#L62) reject enum 内，"reject reason 未注册" | §2.2.4 修订；§9.1 加 enum 扩展 |
| **B3** | Hub 权威启动路径未完整：[runtime.ts:70](../packages/client/src/runtime/runtime.ts#L70) bind 前就选 handler，alias 过期会循环 reject | §4 加 startup repair path（见下） |
| **B4** | `PATCH /clients/me/capabilities` + "client token only" 与现状矛盾（PR #95 后只有 member JWT） | §2.3 修订为 `PATCH /clients/:clientId/capabilities` + memberAuth + `clients.user_id === jwt.userId` 校验 |
| **C1** | `payload.kind` 软窗口表述前后矛盾 | §2.2.2 删除"两周软窗口" |
| **C2** | capability probe 扩展 [handler.ts:149](../packages/client/src/runtime/handler.ts#L149) HandlerFactory 接口 vs 独立模块 | §2.3 改为独立 `<provider>-capability.ts` modules |
| **C3** | `z.discriminatedUnion("kind", [...])` 不能 parse 老行 | §2.2.2 改用 `z.preprocess` 补默认 `kind` |

### 12.9 Hub 权威启动路径（B3 完整方案）

针对 [runtime.ts:70](../packages/client/src/runtime/runtime.ts#L70) "bind 前选 handler" 的问题，三层互补：

| 层 | 时机 | 机制 |
|---|---|---|
| **预取** | client 启动后 / connect 前 | 用 member JWT 调 `GET /api/v1/clients/me/agents`（**新建** endpoint，返回该 client 上所有 pinned agent + 权威 `runtime_provider`），覆盖本地 `agent.yaml::runtime` |
| **推送** | server → client，每次 client connect 后立即推 | 复用现有 `agent:pinned` 帧（B1 修订加 `runtimeProvider` 字段），server 在 client connect 时为每个 pinned agent 重新发一遍（不仅在 admin UI 创建时发） |
| **Repair** | bind reject reason `runtime_provider_mismatch` | client 收到后用 member JWT 重 fetch 权威值，重写本地 yaml，关掉错的 handler instance，按权威值 spawn 正确 handler，再次 bind |

预取 + 推送二选一够用，加 repair 兜底。**推荐组合**：以预取为主路径（简单），repair 为容错；推送可作 P3 增量优化。

### 12.10 检查门通过状态

| 检查项 | 状态 |
|---|---|
| C1 R-RUN enforcement | ✓ Confirmed + 改动量估清 |
| C2 agents service 现状 | ✓ Confirmed |
| C3 AgentHandler / WS frame | ✓ Confirmed + 简化（runtimeType 已存在） |
| C4 runtime_type writers | ✓ Confirmed + Gap-1 补 |
| C5 agent_configs payload 形态 | ✓ Confirmed + 简化（无软窗口） |
| C6 Web kael 现状 | ⚠ Critical — Gap-3 补到 P4 |
| C7 Codex AGENTS.md + CODEX_HOME | ⚠ Critical — Gap-2 补 |
| C8 CODEX_HOME 副作用 | ✓ Safe |
| C9 tsdown bundling | ✓ Confirmed + Gap-4 补到 P3 |
| C10 Migration cadence | ⚠ Critical — 单步合并 |
| C11 老 client 兼容 | ✓ Safe |

**Gate 决议**：上述 4 个 Gap 落实到 §6.1 / §9.1 / §4.1 后，**P1 可以启动**。
