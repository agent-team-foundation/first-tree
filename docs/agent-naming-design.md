# Agent 命名收敛设计

> **草稿 / 中文版。** 为了便于团队快速评审，本文档临时以中文撰写。讨论收敛后将重写为英文版本，以符合仓库 "English everywhere on GitHub" 约定。

**状态：** 草稿 — 待评审
**范围：** Agent 标识的 UX 收敛。分阶段在 UI、CLI、schema 上落地。不破坏外部集成契约。

---

## 背景

First Tree Hub 目前为每个 agent 维护了若干语义重叠的"名字类"字段：

- 永久 slug `name`（创建表单里又叫 "Hub ID"）
- 可变的友好标签 `displayName`
- 内部投递地址 `inboxId`
- 指向其他 agent 的委派字段 `delegateMention`（存 UUID）
- 独立于服务端命名、每台机器各自维护的 CLI 本地别名

这些字段是随着功能迭代陆续加进来的，在用户心智里边界模糊、校验规则互相打架、展示样式在 Web / CLI / API / 外部集成里各不相同。

本文档提出以 **`@handle` + `displayName` 双名模型**为核心的收敛方案，以及一个不破坏 API 与外部契约的分阶段落地计划。

---

## 目标

1. **统一的心智模型。** 每个使用场景都应明确："哪个字段是给人看的，哪个是给机器看的"。
2. **稳定的对外契约。** Mention、URL、CLI 目标、外部集成绑定，都不应因 display name 改动而失效。
3. **低创建摩擦。** 用户不必"发明"两个名字 —— handle 从 display name 自动派生，提交前即时校验唯一性。
4. **一致的渲染。** 任何"引用另一个 agent"的位置（delegate、mention、dropdown）都使用同一套视觉样式。
5. **减少命名空间数量。** 取消本地 CLI 别名这个独立概念；**服务端 handle 是一台机器上 agent 的唯一标识**。
6. **不留 schema 惊喜。** Phase 1 纯 UI + 校验。整条路径上 DB 列与 API wire format 都保持向后兼容。

---

## 非目标（不在本文档范围内）

- 跨 org 的 `@handle@org` 联邦路由（Mastodon 风格）
- Handle 重命名 / 重定向基础设施（列为 Phase 4，大概率延后）
- Soft-delete tombstone 之外的 handle 回收 / 市场机制
- Handle 支持 emoji / 非 ASCII / 句点
- 跨 org 的全局唯一性
- Human-to-human（非 agent）的 mention

---

## 1. 现状

### 1.1 承担"命名"语义的字段一览

| 字段 | 所在层 | 格式 | 作用范围 | 是否可变 | 谁生成 | 主要出现位置 |
|---|---|---|---|---|---|---|
| `uuid` | DB / WS | UUIDv7 | 全局 | ❌ | 服务器 | URL 参数 `?a=`、WS frame、内部路由 |
| `inboxId` | DB / 内部 | `inbox_<uuid>` | 全局唯一 | ❌ | 服务器（uuid 派生） | 消息 fan-out 内部使用 |
| `name` | DB / API / UI | `/^[a-z0-9_-]+$/`，1–100 | Org 内唯一 | **❌ 永久** | 用户（可选） | "Name" 列、创建表单 "Hub ID"、`@mention` 目标、CLI 目标 |
| `displayName` | DB / API / UI | 任意 unicode，≤200 | 不唯一 | ✅ | 用户（可选） | "Display" 列、聊天 roster、通知、dropdown |
| `delegateMention` | DB / API | UUID 字符串 | — | ✅ | 用户 | identity section、"Delegate" 列 |
| `metadata.tree.role` / `.domains` | DB JSONB | 字符串 / 数组 | — | ✅ | 用户 | identity badges |
| 本地 CLI 别名 | 每机 YAML | 自由格式 | 单机生效 | N/A | 用户（`agent add <name>`） | CLI 命令、`~/.first-tree/hub/config/agents/<alias>/` 目录 |

### 1.2 各字段在各 surface 的引用关系

- **`NewAgentDialog`** (`packages/web/src/components/new-agent-dialog.tsx`) 收集两个输入："Name"（= `name`，帮助文案里叫 "Hub ID"）和 "Display name"（= `displayName`）。前端对 `name` 做 slugify，`displayName` 自由输入。
- **Agent 列表**（`packages/web/src/pages/agents.tsx`）两个字段作为独立列展示 —— "Name"（monospace 风格）和 "Display"（友好标签）。
- **Agent 详情 identity section**（`packages/web/src/pages/agent-detail/identity-section.tsx`）并排展示；"Delegate" 这一行把 `delegateMention` UUID 解析成目标 agent 的 `displayName`。
- **Chat / roster** 使用 `displayName`，通过 `useAgentNameMap` hook（`packages/web/src/lib/use-agent-name-map.ts`）兜底到 `name`（当 displayName 为 null）。
- **Mention** 通过正则 `/(?<![A-Za-z0-9_.@-])@([A-Za-z0-9_-]{1,64})\b/g`（`packages/shared/src/mentions.ts:27`）抽取，解析到 `agentId`，最终以 UUID 形式存在消息 metadata 里。
- **CLI** 在 `~/.first-tree/hub/config/agents/<alias>/agent.yaml` 存本地别名（`packages/shared/src/config/agent-config.ts`）。别名独立于 server `name`。所有针对 agent 的 CLI 命令都通过 `--agent <alias>` 指定目标。
- **外部集成** 统一用 UUID 引用 agent（`delegateMention`、`metadata.github.repos`、飞书用户绑定）。Webhook 路由到 `agentId`。

---

## 2. 问题

### 2.1 `name` 与 `displayName` 的角色边界模糊

两个相似标签的字段，没有哪个是"主名"的公认规则。创建表单本身就对同一字段用了三个词：label 叫 "Name"、帮助文案叫 "Hub ID"、API 字段叫 `name`。用户无法回答"这个 agent 到底叫什么"。

### 2.2 `displayName` 的 fallback 只在 web 端实现

用户未填 `displayName` 时，DB 存 null。Web 端 `useAgentNameMap` 透明回退到 `name`。但 CLI、管理员日志、WebSocket frame、IM bridge（Slack / 飞书）全都绕过这个 hook，看到的是 null 或占位符。创建表单 "Defaults to the Name above" 的承诺只兑现了一半。

### 2.3 Mention 正则与 `name` 长度规则不一致

`createAgentSchema` 允许 `name` 最长 100 个字符，`MENTION_REGEX` 只匹配 `{1,64}`。**任何 handle 超过 64 字符的 agent 无法被 @ 到** —— 这是一个潜在 bug。首字符规则也不对齐：name 正则允许 `-` / `_` 开头，mention 正则不允许；实际使用中以 `-` 开头的 name 会和 CLI flag 解析冲突。

### 2.4 Delegate 展示有三种不同形态

同一个 `delegateMention` UUID 在三处被渲染成三种样式：profile 那一行是 "仅 displayName"、列表列是 "解析后的 displayName"、dropdown 选项是 "Display Name (Hub ID)"。没有共享组件。

### 2.5 本地 CLI 别名构成第三套命名空间

一台机器上别名可能是 `coder`，另一台可能是 `my-coder`，两者都指向 server `name = coder-agent`、`displayName = code-agent`。三路不一致带来认知成本，也让基于名字的排查变难（"你说的 `coder` 是哪一个？"）。

### 2.6 创建时没有唯一性反馈

`name` 永久且 org 内唯一，但**碰撞只能在 submit 之后才知道**。没有从 `displayName` 自动 slugify、没有实时 availability check，保留字规则也只有一条 `__` 前缀。

### 2.7 缺失 mention 自动补全

mention handle 要等到整条消息发送之后才会被校验。没有自动补全，handle —— 这本应是普通用户感知不到的字段 —— 就以最糟的方式被暴露出来：**在自由输入的聊天里手打**。

---

## 3. 方案模型：`@handle` + Display Name

两个面向用户的标识，职责不重叠：

| 概念 | 职责 | 规则 |
|---|---|---|
| **`@handle`**（当前 `name` 字段在 UI 层的新称呼） | **唯一的**机器 / mention / URL / CLI 引用 | 永久、Org 内唯一、小写 ASCII slug、**始终带 `@` 前缀**展示 |
| **Display Name** | **唯一的**人类可读标签 | 必填（服务端强制）、可变、任意 unicode |

内部字段（`uuid`、`inboxId`、`delegateMention`、`metadata.*`）保持不变，但**永远不在 UI label 里以"名字"的身份出现**。

### 3.1 Handle 规则

```
handle := lowercase(input)
  where input matches /^[a-z0-9][a-z0-9_-]{0,63}$/
    and input not in RESERVED_HANDLES
    and (org_id, handle) is unique in agents table
    and (once set) never changes
```

- 字符集 `[a-z0-9_-]` —— 不允许大写、unicode、句点或其他标点
- 首字符必须 alphanumeric（`-` / `_` 开头会与 CLI flag 解析 / markdown 列表语法冲突）
- 长度 1–64，与 `MENTION_REGEX` 对齐
- 保留前缀 `__*`（既有）；追加一个小黑名单：`admin`、`system`、`null`、`undefined`、`first-tree`、`hub`、`agent`、`me`
- Org 内唯一（不变）
- 永久（不变）。重命名基础设施放在 Phase 4，基本不做

### 3.2 Display Name 规则

- **必填**。用户未填时，服务端以 `handle` 作为默认值存入（而非存 null）
- 通过 `updateAgentSchema` 可修改
- 任意 unicode，最长 200 字符
- 不唯一

### 3.3 各 Surface 的展示约定

| Surface | 是否展示 `@handle` | 是否展示 Display Name |
|---|---|---|
| Workspace agent 卡片 | 否 | 主展示 |
| Chat 列表 / 参与者 | 否 | 主展示 |
| 通知 | 否 | 主展示 |
| 聊天正文里的 mention 链接 | 主（文本是 `@handle`），tooltip 显示 display name | 通过 tooltip |
| Agent 详情页标题栏 | 副标题（小字灰色） | 主标题 |
| Delegate / mention dropdown | 副位 `(@handle)`，用于消歧 | 主展示 |
| Agent 列表表格 | 副列 `@handle` | 主列 "Display" |
| CLI `agent list` | 主键（唯一主键） | 次列 |
| URL 路径（Phase 3+） | 主（`/agents/@handle`） | — |

所有 delegate / agent 引用的渲染统一通过一个 `<AgentChip>` 组件，保证列表、详情、dropdown 共用同一份 markup。

### 3.4 本地 CLI 别名 —— 移除

把每机一份的别名收敛到服务端 handle。改动：

- 目录改为 `~/.first-tree/hub/config/agents/<handle>/agent.yaml`（以 handle 而非自由别名为 key）
- `first-tree-hub agent add <handle>` —— 去掉本地名参数；handle 在服务端解析
- `first-tree-hub agent create <handle>` —— 服务端和本地 key 永远一致
- `--agent <handle>` flag 语义明确地指向 handle
- 客户端 runtime 启动时做一次迁移：对每个本地 agent dir，用 `agentId` 查当前 server handle，如果目录名不同则重命名 dir + 对应的 `sessions/<name>.json`。幂等，冲突时仅 log 跳过

### 3.5 Mention 自动补全

作为一等特性引入到聊天输入框。在任意输入位置键入 `@`，弹出下拉菜单按 display name 和 handle 双向匹配，选中后把 `@<handle>` 字面量插入消息体。**这是让 handle 从日常输入里"退出前台"的机制**。

### 3.6 创建 UX

- 主要字段：**Display Name**（表单最上方、必填、unicode）
- 派生字段：**Handle**，带一个不可编辑的 `@` 前缀，默认从 display name slugify 生成，用户可编辑
- 用户一旦手动编辑过 handle，就断开跟随 display name 的"粘连"
- 即时 availability 校验：新增端点 `GET /api/v1/admin/agents/handles/:handle/availability`（300ms debounce）
- 报错 inline，附示例与保留字提示

### 3.7 校验与 wire format

- `createAgentSchema` —— 收紧 `name` 正则为 `^[a-z0-9][a-z0-9_-]{0,63}$`。旧数据（创建时规则更宽松）保留（grandfather），只在新建时校验
- `MENTION_REGEX` —— 保持 `{1,64}`，加首字符 alnum 约束
- API JSON 字段 `name` 与 `displayName` 不变。label 改名 "Handle" 只是 UI 层
- DB 列 `agents.name` 不变。Phase 1 零 migration。未来重命名为 `handle` 可做但不在本方案范围

---

## 4. 分阶段实施

### Phase 1 —— UI 收敛（单 PR，无 schema 改动）

**改动**

- 收紧 `createAgentSchema` 正则，与 `MENTION_REGEX` 对齐
- UI label "Name" → "Handle"：覆盖 `NewAgentDialog`、agent 列表、agent 详情、identity edit
- 所有 handle 输入与只读展示加 `@` 前缀样式
- 新增 `<AgentChip>` 组件；替换列表 delegate 列、identity profile、identity edit dropdown 的 delegate 渲染
- 创建表单：display-name-first 布局、自动 slug、粘连覆盖、实时唯一性校验
- 聊天输入框的 mention 自动补全（按 display name 和 handle 双向匹配，插入 `@handle`）

**风险：** 低。无 DB、无 API break。回滚 = revert PR

### Phase 2 —— `displayName` 必填（单 PR + migration）

**改动**

- 服务端 `createAgent` 在 `displayName` 为 null 时默认填 `name`
- DB migration：把现有 null 行回填为 `name`，然后把列改成 `NOT NULL`
- Web 端去除 `useAgentNameMap` 里的 fallback
- CLI、日志、IM bridge 自动受益（它们从此拿到的永远是非空值）

**风险：** 中。需要 schema migration + 服务端客户端协同发布。回滚需要 migration 反转。上线前先在 staging 验证数据集

### Phase 3 —— 移除本地 CLI 别名（单 PR + 本地状态迁移）

**改动**

- `first-tree-hub agent add <handle>` 去掉本地名参数
- `agent list` 用 handle 作主键；去掉别名列
- 客户端 runtime 启动时做迁移：重命名与 server handle 不一致的目录，同步重命名 `sessions/<name>.json`
- `--agent <handle>` flag 文档 + 错误文案更新
- CLI 帮助里所有 `alias` 字样清除

**风险：** 中。本地迁移必须幂等；重命名后如果两个目录会冲突，必须 log 跳过而非合并。回滚需要从备份恢复 client YAML（迁移代码里写清楚）

### Phase 4 —— Handle 重命名（可选，延后）

允许改 handle，伴以 90 天旧 handle 冷却期 + 重定向 + 变更通知。`delegateMention` 已经是 UUID 所以引用不会断。本文档不展开，除非出现明确需求

**风险：** 高。需另起设计文档

---

## 5. 验收标准

### Phase 1

- Web UI 创建 agent 要求输入 Display Name 和 Handle（带 `@` 前缀），顺序从上到下
- Display Name slugify 产生的默认 handle 合法；手动编辑 handle 后停止自动跟随
- 实时 availability 在 submit 前就能暴露碰撞
- UI 上再也看不到 "Hub ID" 或 "Name"（指 slug 语义的那个）
- `createAgentSchema` 拒绝 `-` / `_` 开头、超过 64 字符、含大写或 unicode 或句点的 handle
- `MENTION_REGEX` 与 `createAgentSchema` 正则对任何输入给出一致的通过 / 拒绝结果
- `<AgentChip>` 在列表 delegate 列、identity profile、delegate dropdown 的渲染完全一致
- 任意聊天输入框键入 `@` 弹出 mention 自动补全；选中后插入 `@handle` 字面量

### Phase 2

- `agent` 表中不存在 `display_name` 为 null 的行
- CLI `agent list` 输出中，每个 agent 的 display name 都非空
- IM bridge 外发通知中 display name 永远非空

### Phase 3

- 没有一个本地 agent 目录的名字与该 agent 当前 server handle 不同
- CLI help 里不再出现 "alias" 或 "local name" 字样
- `agent add` / `agent create` 只接受 handle（加可选 flag）

---

## 6. 待决问题

- Handle 保留字黑名单是否公开？（显示在创建表单的帮助文案里 —— 会暴露系统结构；或只在碰撞时才告知）
- Mention 自动补全是否支持对 display name 内部字符的模糊匹配？还是只做 handle 的前缀匹配？
- CLI：`first-tree-hub agent send @coder-agent` 是推荐写法，还是 `@` 可选？（建议：都接受，内部统一剥离 `@` 前缀）
- API 响应中是否除了 `name` 也暴露 `handle` 字段（前向兼容）？（建议：Phase 1 增加 `handle` 作为别名，便于下游按自己节奏迁移；保留 `name` 不删）

---

## 7. 涉及文件清单

**Shared / schema**
- `packages/shared/src/schemas/agent.ts` —— Zod create / update schema，正则收紧
- `packages/shared/src/mentions.ts` —— `MENTION_REGEX`，可选辅助函数统一
- `packages/shared/src/config/agent-config.ts` —— 本地 agent 配置（Phase 3）

**Server**
- `packages/server/src/services/agent.ts` —— `createAgent` 默认 displayName（Phase 2）；handle availability 端点
- `packages/server/src/api/admin/agents.ts` —— 新增 `GET /handles/:handle/availability`
- `packages/server/drizzle/` —— Phase 2 migration（回填 + NOT NULL）

**Web**
- `packages/web/src/components/new-agent-dialog.tsx` —— display-name-first 布局、自动 slug、实时校验
- `packages/web/src/pages/agents.tsx` —— 列头改名，使用 `<AgentChip>`
- `packages/web/src/pages/agent-detail/identity-section.tsx` —— 详情页标题样式、编辑 dropdown
- `packages/web/src/components/agent-chip.tsx` —— **新建**
- `packages/web/src/components/mention-autocomplete.tsx` —— **新建**（Phase 1）
- `packages/web/src/lib/use-agent-name-map.ts` —— 简化 / 移除 fallback（Phase 2）

**CLI**
- `packages/command/src/commands/agent.ts` —— `agent add` / `agent list` / `--agent` 调整（Phase 3）
- `packages/command/src/core/` —— 启动时的本地状态迁移（Phase 3）
