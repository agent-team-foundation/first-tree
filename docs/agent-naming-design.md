# Agent 命名收敛设计

> **草稿 / 中文版。** 为了便于团队快速评审，本文档临时以中文撰写。讨论收敛后将重写为英文版本，以符合仓库 "English everywhere on GitHub" 约定。

**状态：** 草稿 — 待评审
**范围：** Agent 标识的 UX 收敛。分阶段在 UI、CLI、schema 上落地。不破坏外部集成契约。

---

## 术语约定

本文档讨论的是 UI 层词汇统一，涉及四个层次的命名，**不互相替换**：

| 场景 | 用词 |
|---|---|
| **UI label**（表单字段、列表列头、详情页字段名） | **Agent name** / **Display name**（两个字段对称命名） |
| **UI 值展示**（mention、CLI 等"机读引用"语境） | `@<name>` 视觉前缀（如 `@coder-agent`）——`@` 不存储，仅视觉层 |
| **代码 / DB 列 / API JSON 字段** | `name` / `displayName`（**保持不变**，零迁移） |
| **错误文案、帮助文字、自然语言句中** | 小写 `agent name` |

所以本文档内：
- 说 **"Agent name"** = UI label
- 说 **`name`** = 代码 / schema / wire format 字段
- 说 `@<name>` 或 `@coder-agent` = mention 语境下值的视觉呈现

---

## 背景

First Tree Hub 目前为每个 agent 维护了若干语义重叠的"名字类"字段：

- 永久 slug `name`（UI 里叫法不统一：列表叫 "Name"、创建表单 helper 又叫 "Hub ID"）
- 可变的友好标签 `displayName`
- 内部投递地址 `inboxId`
- 指向其他 agent 的委派字段 `delegateMention`（存 UUID）
- 独立于服务端命名、每台机器各自维护的 CLI 本地别名

这些字段是随着功能迭代陆续加进来的，在用户心智里边界模糊、校验规则互相打架、展示样式在 Web / CLI / API / 外部集成里各不相同。

本文档提出以 **Agent name + Display name 双名模型**为核心的收敛方案，以及一个不破坏 API 与外部契约的分阶段落地计划。

---

## 目标

1. **统一的心智模型。** 每个使用场景都应明确："哪个字段是给人看的，哪个是给机器看的"。
2. **稳定的对外契约。** Mention、URL、CLI 目标、外部集成绑定，都不应因 display name 改动而失效。
3. **低创建摩擦。** 用户不必"发明"两个名字 —— agent name 从 display name 自动派生，提交前即时校验唯一性。
4. **一致的渲染。** 任何"引用另一个 agent"的位置（delegate、mention、dropdown）都使用同一套视觉样式。
5. **减少命名空间数量。** 取消本地 CLI 别名这个独立概念；**服务端 agent name 是一台机器上 agent 的唯一标识**。
6. **不留 schema 惊喜。** Phase 1 纯 UI + 校验。整条路径上 DB 列与 API wire format 都保持向后兼容。

---

## 非目标（不在本文档范围内）

- 跨 org 的 `@<name>@<org>` 联邦路由（Mastodon 风格）
- Agent name 重命名 / 重定向基础设施（列为 Phase 4，大概率延后）
- Soft-delete tombstone 之外的 name 回收 / 市场机制
- Agent name 支持 emoji / 非 ASCII / 句点
- 跨 org 的全局唯一性
- Human-to-human（非 agent）的 mention
- 重命名 DB 列或 API 字段 —— `name` / `displayName` 一律保留

---

## 1. 现状

### 1.1 承担"命名"语义的字段一览

| 字段 | 所在层 | 格式 | 作用范围 | 是否可变 | 谁生成 | 主要出现位置 |
|---|---|---|---|---|---|---|
| `uuid` | DB / WS | UUIDv7 | 全局 | ❌ | 服务器 | URL 参数 `?a=`、WS frame、内部路由 |
| `inboxId` | DB / 内部 | `inbox_<uuid>` | 全局唯一 | ❌ | 服务器（uuid 派生） | 消息 fan-out 内部使用 |
| `name` | DB / API / UI | `/^[a-z0-9_-]+$/`，1–100 | Org 内唯一 | **❌ 永久** | 用户（可选） | UI label（多处混用 "Name" / "Hub ID"）、`@mention` 目标、CLI 目标 |
| `displayName` | DB / API / UI | 任意 unicode，≤200 | 不唯一 | ✅ | 用户（可选） | "Display" 列、聊天 roster、通知、dropdown |
| `delegateMention` | DB / API | UUID 字符串 | — | ✅ | 用户 | identity section、"Delegate" 列 |
| `metadata.tree.role` / `.domains` | DB JSONB | 字符串 / 数组 | — | ✅ | 用户 | identity badges |
| 本地 CLI 别名 | 每机 YAML | 自由格式 | 单机生效 | N/A | 用户（`agent add <name>`） | CLI 命令、`~/.first-tree/hub/config/agents/<alias>/` 目录 |

### 1.2 各字段在各 surface 的引用关系

- **`NewAgentDialog`** (`packages/web/src/components/new-agent-dialog.tsx`) 收集两个输入：label "Name"（= `name`；helper 文字和错误文案里有 3 处又叫 "Hub ID"，术语分歧）和 "Display name"（= `displayName`）。前端对 `name` 做 slugify，`displayName` 自由输入。
- **Agent 列表**（`packages/web/src/pages/agents.tsx`）两个字段作为独立列展示 —— "Name"（monospace 风格）和 "Display"（友好标签）。
- **Agent 详情 identity section**（`packages/web/src/pages/agent-detail/identity-section.tsx`）并排展示；"Delegate" 这一行把 `delegateMention` UUID 解析成目标 agent 的 `displayName`。
- **Chat / roster** 使用 `displayName`，通过 `useAgentNameMap` hook（`packages/web/src/lib/use-agent-name-map.ts`）兜底到 `name`（当 displayName 为 null）。
- **Mention** 通过正则 `/(?<![A-Za-z0-9_.@-])@([A-Za-z0-9_-]{1,64})\b/g`（`packages/shared/src/mentions.ts:27`）抽取，解析到 `agentId`，最终以 UUID 形式存在消息 metadata 里。
- **CLI** 在 `~/.first-tree/hub/config/agents/<alias>/agent.yaml` 存本地别名（`packages/shared/src/config/agent-config.ts`）。别名独立于 server `name`。所有针对 agent 的 CLI 命令都通过 `--agent <alias>` 指定目标。
- **外部集成** 统一用 UUID 引用 agent（`delegateMention`、`metadata.github.repos`、飞书用户绑定）。Webhook 路由到 `agentId`。

### 1.3 当前 UI 术语分布（2026-04-24 抽样）

| 术语 | 出现位置 | 性质 |
|---|---|---|
| **"Name"** | 5+ 处（创建表单 label、agents 列表列头、admin-all-agents 列表列头、详情页提示、错误文案） | **主导术语** |
| **"Hub ID"** | 3 处（仅 `new-agent-dialog.tsx` 内部的 helper 文字 + 2 条错误文案） | **漂移**，限在一个文件里 |
| **"Handle"** | 0 处 | — |

即使同一个 `new-agent-dialog.tsx` 自己也不一致 —— label 叫 "Name"、错误文案 :190 叫 "Name"、helper :339 叫 "Hub ID"、错误文案 :179/:184 又叫 "Hub ID"。这是**现有代码内部已经存在的术语冲突**，不是本收敛引入的。

---

## 2. 问题

### 2.1 `name` 与 `displayName` 的角色边界模糊

两个相似标签的字段，没有哪个是"主名"的公认规则。光创建表单就对同一字段用了三个词（label "Name"、helper "Hub ID"、API 字段 `name`）。用户无法回答"这个 agent 到底叫什么"。

### 2.2 `displayName` 的 fallback 只在 web 端实现

用户未填 `displayName` 时，DB 存 null。Web 端 `useAgentNameMap` 透明回退到 `name`。但 CLI、管理员日志、WebSocket frame、IM bridge（Slack / 飞书）全都绕过这个 hook，看到的是 null 或占位符。创建表单 "Defaults to the Name above" 的承诺只兑现了一半。

### 2.3 Mention 正则与 `name` 长度规则不一致

`createAgentSchema` 允许 `name` 最长 100 个字符，`MENTION_REGEX` 只匹配 `{1,64}`。**任何 name 超过 64 字符的 agent 无法被 @ 到** —— 这是一个潜在 bug。首字符规则也不对齐：name 正则允许 `-` / `_` 开头，mention 正则不允许；实际使用中以 `-` 开头的 name 会和 CLI flag 解析冲突。

### 2.4 Delegate 展示有三种不同形态

同一个 `delegateMention` UUID 在三处被渲染成三种样式：profile 那一行是 "仅 displayName"、列表列是 "解析后的 displayName"、dropdown 选项是 "Display Name (Hub ID)"。没有共享组件。

### 2.5 本地 CLI 别名构成第三套命名空间

一台机器上别名可能是 `coder`，另一台可能是 `my-coder`，两者都指向 server `name = coder-agent`、`displayName = code-agent`。三路不一致带来认知成本，也让基于名字的排查变难（"你说的 `coder` 是哪一个？"）。

### 2.6 创建时没有唯一性反馈

`name` 永久且 org 内唯一，但**碰撞只能在 submit 之后才知道**。没有从 `displayName` 自动 slugify、没有实时 availability check，保留字规则也只有一条 `__` 前缀。

### 2.7 缺失 mention 自动补全

mention 要等到整条消息发送之后才会被校验。没有自动补全，agent name —— 这本应是普通用户感知不到的字段 —— 就以最糟的方式被暴露出来：**在自由输入的聊天里手打**。

---

## 3. 方案模型：Agent name + Display name

两个面向用户的标识，职责不重叠：

| 概念（UI 术语） | 职责 | 规则 |
|---|---|---|
| **Agent name** | **唯一的**机器 / mention / URL / CLI 引用 | 永久、Org 内唯一、小写 ASCII slug；在 mention / CLI 等"机读"上下文中以 `@<name>` 形式渲染 |
| **Display name** | **唯一的**人类可读标签 | 必填（服务端强制）、可变、任意 unicode |

内部字段（`uuid`、`inboxId`、`delegateMention`、`metadata.*`）保持不变，但**永远不在 UI label 里以"名字"的身份出现**。

代码、DB 列、API JSON 字段继续沿用 `name` / `displayName`（零迁移）；UI 层的词汇（label、错误文案、帮助文字）统一为 `Agent name` / `Display name`。这对应 GitHub 的 `Username` / `Name` 配对心智 —— 让**排版 + 修饰词**承担"这两者是不同类型名字"的解释，而不是造新术语。

### 3.1 Agent name 规则

```
name := lowercase(input)
  where input matches /^[a-z0-9][a-z0-9_-]{0,63}$/
    and input not in RESERVED_AGENT_NAMES
    and (org_id, name) is unique in agents table
    and (once set) never changes
```

- 字符集 `[a-z0-9_-]` —— 不允许大写、unicode、句点或其他标点
- 首字符必须 alphanumeric（`-` / `_` 开头会与 CLI flag 解析 / markdown 列表语法冲突）
- 长度 1–64，与 `MENTION_REGEX` 对齐
- 保留前缀 `__*`（既有）；追加一个小黑名单：`admin`、`system`、`null`、`undefined`、`first-tree`、`hub`、`agent`、`me`
- Org 内唯一（不变）
- 永久（不变）。重命名基础设施放在 Phase 4，基本不做

### 3.2 Display name 规则

- **必填**。用户未填时，服务端以 `name` 作为默认值存入（而非存 null）
- 通过 `updateAgentSchema` 可修改
- 任意 unicode，最长 200 字符
- 不唯一

### 3.3 各 Surface 的展示约定

| Surface | Agent name 展示 | Display name 展示 |
|---|---|---|
| Workspace agent 卡片 | 不显示 | 主展示 |
| Chat 列表 / 参与者 | 不显示 | 主展示 |
| 通知 | 不显示 | 主展示 |
| 聊天正文里的 mention 链接 | 主（文本形如 `@coder-agent`），tooltip 显示 display name | 通过 tooltip |
| Agent 详情页标题栏 | 副标题（小字灰色，形如 `@coder-agent`） | 主标题 |
| Delegate / mention dropdown | 副位 `@<name>`，用于消歧 | 主展示 |
| Agent 列表表格 | 副列 "Agent name"（等宽字体 + `@` 前缀视觉） | 主列 "Display name" |
| CLI `agent list` | 主键（唯一主键） | 次列 |
| URL 路径（Phase 3+） | 主（`/agents/<name>`，URL 路径不含 `@` 字符） | — |

所有 delegate / agent 引用的渲染统一通过一个 `<AgentChip>` 组件，保证列表、详情、dropdown 共用同一份 markup。

### 3.4 本地 CLI 别名 —— 移除

把每机一份的别名收敛到服务端 agent name。改动：

- 目录改为 `~/.first-tree/hub/config/agents/<name>/agent.yaml`（以 agent name 而非自由别名为 key）
- `first-tree-hub agent add <name>` —— 去掉本地名参数；name 在服务端解析
- `first-tree-hub agent create <name>` —— 服务端和本地 key 永远一致
- `--agent <name>` flag 语义明确地指向 agent name
- 客户端 runtime 启动时做一次迁移：对每个本地 agent dir，用 `agentId` 查当前 server `name`，如果目录名不同则重命名 dir + 对应的 `sessions/<old-alias>.json`。幂等，冲突时仅 log 跳过

### 3.5 Mention 自动补全

作为一等特性引入到聊天输入框。在任意输入位置键入 `@`，弹出下拉菜单按 display name 和 agent name 双向匹配，选中后把 `@<name>` 字面量插入消息体。**这是让 agent name 从日常输入里"退出前台"的机制** —— 普通用户不需要记忆，只需认得 display name 即可。

### 3.6 创建 UX

- 主要字段：**Display name**（表单最上方、必填、unicode）
- 派生字段：**Agent name**，带一个不可编辑的 `@` 前缀装饰，默认从 display name slugify 生成，用户可编辑
- 用户一旦手动编辑过 agent name，就断开跟随 display name 的"粘连"
- 即时 availability 校验：新增端点 `GET /api/v1/admin/agents/names/:name/availability`（300ms debounce）
- 报错 inline，附示例与保留字提示

### 3.7 校验与 wire format

- `createAgentSchema` —— 收紧 `name` 正则为 `^[a-z0-9][a-z0-9_-]{0,63}$`。旧数据（创建时规则更宽松）保留（grandfather），只在新建时校验
- `MENTION_REGEX` —— 保持 `{1,64}`，加首字符 alnum 约束
- **API JSON 字段 `name` 与 `displayName` 完全不变** —— UI label 改名 "Agent name" 只是文本层的事，不触及 wire format，不需要向下游提供 `handle` 别名字段
- DB 列 `agents.name` 不变。Phase 1 零 migration

---

## 4. 分阶段实施

### Phase 1 —— 术语与创建 UX 收敛（单 PR，无 DB migration / 无 API breaking change）

> 主要工作量在前端，**但不是"纯前端"**：需要共享 schema 改正则 + 服务端加一个新端点。两者都是加法式改动，不影响现有数据和契约。

**改动（按层次）**

**① 共享 schema** — `packages/shared`
- 收紧 `createAgentSchema.name` 正则为 `^[a-z0-9][a-z0-9_-]{0,63}$`，与 `MENTION_REGEX` 对齐
- 追加 `RESERVED_AGENT_NAMES` 黑名单常量并在 Zod 校验里应用
- `MENTION_REGEX` 加首字符 alnum 约束，保持 `{1,64}` 长度

**② 服务端** — `packages/server`（仅两处加法，零 schema 改动）
- 新增端点 `GET /api/v1/admin/agents/names/:name/availability` —— 给创建表单做 debounced 预检，返回 `{ available: boolean, reason?: "taken" | "reserved" | "invalid" }`
- 对应新增 service 函数 `checkAgentNameAvailability(orgId, name)`
- 共享 schema 收紧后，服务端 Zod 校验自动受益，无需额外改

**③ 前端** — `packages/web`（大头工作）
- UI 术语统一为 **"Agent name"**：
  - 清理 `new-agent-dialog.tsx` 里 3 处 "Hub ID" 漂移（helper 文字 + 2 条错误文案）
  - 列表列头 "Name" → "Agent name"（`agents.tsx`、`admin-all-agents.tsx`）
  - 详情页、identity edit 统一用 "Agent name"
- 所有 agent name 输入与只读展示加 `@` 前缀视觉（等宽字体 + 灰色 `@`）
- 新增 `<AgentChip>` 组件；替换列表 delegate 列、identity profile、identity edit dropdown 的 delegate 渲染
- 创建表单：display-name-first 布局、自动 slug、粘连覆盖、实时调用 availability 端点
- 聊天输入框的 mention 自动补全（按 display name 和 agent name 双向匹配，插入 `@<name>`）

**风险：** 低
- 无 DB migration
- 新端点是**加法**，不影响现有 API 消费者
- 正则收紧对**新建**生效，旧 `name` 数据 grandfathered
- 回滚 = revert PR

### Phase 2 —— `displayName` 必填（单 PR + migration）

**改动**

- 服务端 `createAgent` 在 `displayName` 为 null 时默认填 `name`
- DB migration：把现有 null 行回填为 `name`，然后把列改成 `NOT NULL`
- Web 端去除 `useAgentNameMap` 里的 fallback
- CLI、日志、IM bridge 自动受益（它们从此拿到的永远是非空值）

**风险：** 中。需要 schema migration + 服务端客户端协同发布。回滚需要 migration 反转。上线前先在 staging 验证数据集

### Phase 3 —— 移除本地 CLI 别名（单 PR + 本地状态迁移）

**改动**

- `first-tree-hub agent add <name>` 去掉本地名参数
- `agent list` 用 agent name 作主键；去掉别名列
- 客户端 runtime 启动时做迁移：重命名与 server `name` 不一致的目录，同步重命名 `sessions/<old-alias>.json`
- `--agent <name>` flag 文档 + 错误文案更新
- CLI 帮助里所有 `alias` / `local name` 字样清除

**风险：** 中。本地迁移必须幂等；重命名后如果两个目录会冲突，必须 log 跳过而非合并。回滚需要从备份恢复 client YAML（迁移代码里写清楚）

### Phase 4 —— Agent name 重命名（可选，延后）

允许改 agent name，伴以 90 天旧 name 冷却期 + 重定向 + 变更通知。`delegateMention` 已经是 UUID 所以引用不会断。本文档不展开，除非出现明确需求

**风险：** 高。需另起设计文档

---

## 5. 验收标准

### Phase 1

- Web UI 创建 agent 要求输入 **Display name** 和 **Agent name**（带 `@` 前缀视觉），顺序从上到下
- Display name slugify 产生的默认 agent name 合法；手动编辑 agent name 后停止自动跟随
- 实时 availability 在 submit 前就能暴露碰撞
- **UI 上不再出现 "Hub ID" 字样**；所有引用 slug 字段的 label 统一为 "Agent name"
- `createAgentSchema` 拒绝 `-` / `_` 开头、超过 64 字符、含大写或 unicode 或句点的输入
- `MENTION_REGEX` 与 `createAgentSchema` 正则对任何输入给出一致的通过 / 拒绝结果
- `<AgentChip>` 在列表 delegate 列、identity profile、delegate dropdown 的渲染完全一致
- 任意聊天输入框键入 `@` 弹出 mention 自动补全；选中后插入 `@<name>` 字面量
- 英文 PR 描述 / 代码注释中的技术讨论仍可使用 `handle` / `slug` 等 GitHub 业界术语（不强制），但 **UI、错误文案、帮助文字、用户文档**一律用 "Agent name"

### Phase 2

- `agent` 表中不存在 `display_name` 为 null 的行
- CLI `agent list` 输出中，每个 agent 的 display name 都非空
- IM bridge 外发通知中 display name 永远非空

### Phase 3

- 没有一个本地 agent 目录的名字与该 agent 当前 server `name` 不同
- CLI help 里不再出现 "alias" 或 "local name" 字样
- `agent add` / `agent create` 只接受 agent name（加可选 flag）

---

## 6. 待决问题

- **Agent name 保留字黑名单是否公开？** 显示在创建表单帮助文案会暴露系统结构；或只在碰撞时才告知。倾向：碰撞时告知 + 在文档页列出完整名单
- **Mention 自动补全的匹配策略**：display name 是否做内部字符模糊匹配？agent name 是否只做前缀匹配？倾向：display name 做模糊（体验好），agent name 做前缀（精准）
- **CLI：`first-tree-hub chat send @coder-agent` 是推荐写法，还是 `@` 可选？** 倾向：两者都接受，内部统一剥离 `@` 前缀

> 原草案中"API 响应是否除了 `name` 也暴露 `handle` 字段"这一问题已**作废** —— 因为 UI 术语已统一为 "Agent name"（不引入 "handle" 新概念），API 字段继续用 `name` 即可，下游无迁移压力

---

## 7. 涉及文件清单

每行末尾 `[P1]` / `[P2]` / `[P3]` 标注该文件在哪个 Phase 被触及（同一文件可能跨多个 Phase）。

**Shared** — `packages/shared`
- `src/schemas/agent.ts` —— Zod create/update schema 正则收紧；追加 `RESERVED_AGENT_NAMES` 黑名单 `[P1]`
- `src/mentions.ts` —— `MENTION_REGEX` 首字符 alnum 约束，对齐 schema `[P1]`
- `src/config/agent-config.ts` —— 本地 agent 配置结构调整 `[P3]`

**Server** — `packages/server`
- `src/services/agent.ts` —— 新增 `checkAgentNameAvailability(orgId, name)` `[P1]`；`createAgent` 默认 `displayName` `[P2]`
- `src/api/admin/agents.ts` —— 新增 `GET /agents/names/:name/availability` `[P1]`
- `drizzle/` —— migration（回填 `display_name` + 设 `NOT NULL`） `[P2]`

**Web** — `packages/web`
- `src/components/new-agent-dialog.tsx` —— UI 术语统一为 "Agent name"、清理 "Hub ID" 漂移、display-name-first 布局、自动 slug、实时校验 `[P1]`
- `src/pages/agents.tsx` —— 列头改名 "Name" → "Agent name"，使用 `<AgentChip>` `[P1]`
- `src/pages/admin-all-agents.tsx` —— 同上 `[P1]`
- `src/pages/agent-detail/identity-section.tsx` —— 详情页术语 "Agent name"、标题样式、编辑 dropdown `[P1]`
- `src/components/agent-chip.tsx` —— **新建** `[P1]`
- `src/components/mention-autocomplete.tsx` —— **新建** `[P1]`
- `src/lib/use-agent-name-map.ts` —— 简化 / 移除 fallback `[P2]`

**CLI** — `packages/command`
- `src/commands/agent.ts` —— `agent add` / `agent list` / `--agent` 调整 `[P3]`
- `src/core/` —— 启动时的本地状态迁移 `[P3]`
