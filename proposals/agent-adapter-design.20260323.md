---
title: "Agent Hub — Agent 身份与 IM Adapter 设计"
status: draft
owners: [baixiaohang]
soft_links:
  - agent-hub-overview.20260320.md
  - agent-hub-server-detailed-design.20260320.md
---

# Agent 身份与 IM Adapter 设计

本文档定义 Agent Hub 中 Agent 身份模型、Agent 与外部 IM Bot 的关系、Adapter 层架构，以及消息在内部系统与外部平台之间的流转机制。

---

## 1. 核心设计原则

| 原则 | 说明 |
|------|------|
| **Agent 是唯一身份** | 不区分"飞书 agent""Slack agent"。Agent 就是 Agent，平台只是通信渠道。 |
| **Adapter 是服务，不是 Agent** | Adapter 层负责桥接，自身不创建 Agent、不占据 Agent 列表。 |
| **Agent 创建与平台绑定解耦** | Agent 的生命周期（创建/销毁/凭证）独立于 IM 平台绑定。 |
| **1:1 Agent ↔ Bot** | 每个非人类 Agent 在每个平台上对应一个独立的 Bot，拥有独立身份和头像。 |
| **人类身份跨平台统一** | 同一个人在飞书和 Slack 上映射到同一个 Human Agent。 |

---

## 2. Agent 身份模型

### 2.1 Agent 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `human` | 人类用户 | zhangsan、john |
| `personal_assistant` | 个人助手 | xx-agent |
| `autonomous_agent` | 自主 Agent | code-reviewer、scheduler |

所有类型的 Agent 共享同一张 `agents` 表，拥有相同的通信能力（Chat、Inbox、消息收发）。

### 2.2 Agent 数据源

Agent 的创建不在 Adapter 层，而是由上层数据源驱动：

```
当前阶段:  Admin API 手动创建
未来阶段:  Context Tree 自动同步（读取 members/ 等目录）
              ↓
         agents 表（Agent Hub 核心）
              ↓
         Admin 手动绑定 IM 平台身份
```

**关键约束：Adapter 层不创建 Agent。** 当外部平台出现未知用户时，Bot 回复提示消息，告知用户尚未绑定并附带其平台用户标识（如飞书 open_id），引导用户联系管理员完成绑定。人类用户必须由管理员预先创建 Agent 并绑定平台身份后才能参与通信。

### 2.3 Agent 删除与重建

Agent 删除采用**软删除**（`status = 'deleted'`），不物理删除行，避免外键悬空和外部平台侧的不一致。

删除时的级联操作：
- 吊销所有 Token（`agent_tokens` 标记 `revoked_at`）
- 清理 Bot 凭证绑定（删除 `adapter_configs` 关联行）→ 触发 WebSocket 断连
- 清理用户映射（删除 `adapter_agent_mappings` 关联行）
- **保留** `chat_participants`、`messages` — 历史记录不动

重建同 ID 的 Agent：
- `createAgent` 检测到已有 `status = 'deleted'` 的同 ID 记录时，执行 UPDATE 覆盖（重置 type、displayName、metadata、status = 'active'）
- 已有 `status = 'active'` 或 `suspended` 的同 ID 记录仍拒绝创建（ConflictError）
- 覆盖后，历史消息的 `sender_id` 和 Chat 参与记录自动关联到重建的 Agent

前端可见性：
- 已删除的 Agent 在 API 列表和 Web 管理后台中不可见
- `messages.sender_id` 不设外键约束 — 已删除 Agent 的历史消息保留，展示时显示为"已删除"

---

## 3. Agent 与 IM Bot 的关系

### 3.1 非人类 Agent — 出站身份

每个非人类 Agent 在每个 IM 平台上绑定一个 Bot：

```
xx-agent       ←→  飞书 Bot A (cli_xxx)
                ←→  Slack Bot B (xapp_xxx)

code-reviewer   ←→  飞书 Bot C (cli_yyy)
```

绑定关系存储在 `adapter_configs` 表（更准确的语义：**Agent 的平台 Bot 凭证**）：

```
adapter_configs:
 id │ platform │ agent_id       │ credentials (encrypted)    │ status
────┼──────────┼────────────────┼────────────────────────────┼────────
  1 │ feishu   │ xx-agent      │ {app_id, app_secret}       │ active
  2 │ slack    │ xx-agent      │ {bot_token, signing_secret} │ active
  3 │ feishu   │ code-reviewer  │ {app_id, app_secret}       │ active
```

约束：`UNIQUE(agent_id, platform)` — 同一 Agent 在同一平台只能绑定一个 Bot。

### 3.2 人类 Agent — 入站身份

人类 Agent 在各平台上的外部身份通过 `adapter_agent_mappings` 表映射：

```
adapter_agent_mappings:
 platform │ external_user_id         │ agent_id   │ bound_via
──────────┼──────────────────────────┼────────────┼──────────
 feishu   │ ou_96274fa8fd92ee01...   │ zhangsan   │ manual
 slack    │ U_ABC123                 │ zhangsan   │ code
 feishu   │ ou_1234abcd5678ef...     │ john       │ auto
```

同一个人在不同平台的账号映射到同一个 Human Agent，所有对话历史归于统一身份。

### 3.3 对称关系总结

```
非人类 Agent:
  adapter_configs          → Agent 在平台上的 Bot 凭证（出站身份）
  一个 Agent 可绑多个平台（每平台最多一个 Bot）

人类 Agent:
  adapter_agent_mappings   → 平台用户到 Agent 的映射（入站身份）
  一个 Agent 可绑多个平台（每平台一个外部 ID）
```

---

## 4. Adapter 架构

### 4.1 Adapter 层定位

```
┌─────────────────────────────┐
│  Agent 数据源                │  ← Context Tree / Admin API
│  (创建、同步、凭证)          │
├─────────────────────────────┤
│  Agent Hub 核心              │  ← agents, chats, inbox, messages
│  (身份、通信、投递)          │
├─────────────────────────────┤
│  Adapter 层                  │  ← 本文档关注范围
│  (平台绑定、消息桥接)        │
└─────────────────────────────┘
```

Adapter 层是纯服务组件，职责：
1. 管理 Bot WebSocket/Webhook 连接
2. 入站：解析外部消息 → 映射身份 → 写入内部消息系统
3. 出站：消费内部消息 → 格式转换 → 调用平台 API 发送

**Adapter 不创建 Agent、不生成 Token、不参与 Chat。**

### 4.2 数据模型

四张 adapter 表，职责清晰：

| 表 | 用途 | 关键字段 |
|----|------|---------|
| `adapter_configs` | Bot 凭证（出站身份） | platform, agent_id, credentials (encrypted) |
| `adapter_agent_mappings` | 用户映射（入站身份） | platform, external_user_id, agent_id |
| `adapter_chat_mappings` | Channel → Chat 映射（路由） | platform, external_channel_id, chat_id |
| `adapter_message_references` | 消息 ID 对照（编辑/引用） | message_id, external_message_id |

### 4.3 与旧设计的对比

| | 旧设计 | 新设计 |
|---|--------|--------|
| Adapter Agent | 每个 Bot 自动创建 `feishu-adapter-{appId}` | **不创建**，Adapter 是服务不是 Agent |
| 出站机制 | 消费 adapter agent 的 inbox | 消费 human agent 的 inbox |
| Human Agent | 自动创建 `feishu-user-{openId}` | 查映射表，不存在则 Bot 回复提示绑定 |
| agents 列表 | 混杂系统 agent | **只有真实 Agent** |
| adapter_configs.agentId | 存在但未使用 | **核心路由字段** |

---

## 5. 消息流

### 5.1 入站（外部平台 → Agent Hub）

以飞书为例：

```
飞书用户张三发消息给 Bot A
        │
        ↓
  1. Feishu WSClient 收到 im.message.receive_v1 事件
        │
        ↓
  2. 去重（processed_events 表，event_id 唯一）
        │
        ↓
  3. 身份解析
     查 adapter_agent_mappings(feishu, ou_xxx)
     → 找到 → agent_id = zhangsan
     → 没找到 → Bot 回复："您尚未绑定，请联系管理员。您的用户标识：ou_xxx"
     →           消息不写入内部系统，流程终止
        │
        ↓
  4. Chat 解析
     查 adapter_chat_mappings(feishu, chat_id, thread_id)
     → 找到 → 复用已有 Chat
     → 没找到 → 创建新 Chat
       参与者 = [zhangsan, xx-agent]
       (xx-agent 来自 adapter_configs 中绑定该 Bot 的 agent_id)
        │
        ↓
  5. 写入消息
     sendMessage(chatId, senderId=zhangsan, ...)
     → fan-out → xx-agent 的 inbox 收到消息
        │
        ↓
  6. 存储消息引用
     adapter_message_references(messageId ↔ external_message_id)
```

### 5.2 出站（Agent Hub → 外部平台）

```
xx-agent 在 Chat 中发送消息
        │
        ↓
  1. fan-out → zhangsan 的 inbox 收到消息
        │
        ↓
  2. Adapter 出站服务消费 human agent 的 inbox
     SELECT ie.* FROM inbox_entries ie
     JOIN agents a ON ie.inbox_id = a.inbox_id
     JOIN adapter_agent_mappings aam ON a.id = aam.agent_id
     WHERE aam.platform = 'feishu' AND ie.status = 'pending'
     FOR UPDATE SKIP LOCKED
        │
        ↓
  3. 跳过不需要发送的消息
     - metadata.source = 'feishu' → 入站消息，已在飞书侧，跳过
        │
        ↓
  4. 确定发送 Bot
     查 adapter_chat_mappings → 找到外部 channel
     查 adapter_configs → 找到对应 Bot 凭证
        │
        ↓
  5. 格式转换 + 发送
     text → msg_type: text
     markdown → msg_type: interactive (card)
     card → msg_type: interactive
        │
        ↓
  6. ACK inbox entry + 存储消息引用
```

### 5.3 多 Agent 同 Chat 场景

当一个 Chat 中有多个 Agent（如 xx-agent + code-reviewer）且绑定不同 Bot：

```
Chat Z: [zhangsan, xx-agent, code-reviewer]
  ├── 飞书映射: external_channel = oc_xxx (飞书群)
  │
  ├── xx-agent 发消息 → zhangsan inbox → 用 Bot A 发到飞书
  └── code-reviewer 发消息 → zhangsan inbox → 用 Bot B 发到飞书
```

出站 Bot 选择逻辑：查 `adapter_configs` 找 `msg.sender_id` 对应的 Bot。如果发送者没有绑定 Bot（罕见情况），使用 Chat 创建时关联的默认 Bot。

飞书侧效果：不同 Agent 的消息显示为不同 Bot 的名字和头像 — **真正的 1:1 身份区分**。

---

## 6. 飞书 Bot 约束

### 6.1 Bot 创建方式

飞书开放平台**不提供创建应用的 API**。所有 IM 平台（飞书、Slack、Discord）均要求在开发者控制台手动创建应用。

管理员操作流程：
1. 在飞书开发者后台创建自建应用，获取 app_id + app_secret
2. 在 Agent Hub Admin 后台创建 adapter_config，填入凭证并绑定 Agent
3. 系统自动启动 WebSocket 连接

### 6.2 未绑定 Bot 的 Agent

当前阶段严格执行 **1:1 Agent ↔ Bot**：每个需要在飞书侧通信的非人类 Agent 必须绑定自己的 Bot（adapter_config）。未绑定 Bot 的 Agent 发送的消息不会出站到飞书，系统记录 warning 日志。

这是预期行为，不是 bug — 如果一个 Agent 没有飞书 Bot，它本身就不参与飞书侧的通信。管理员应为每个需要在飞书活跃的 Agent 创建独立的飞书应用并绑定。

> **未来增强**：当 Bot 数量有限时，可实现"共享 Bot"退化方案 — 多个 Agent 共用一个 Bot，出站时通过消息卡片 header 标注发送者 Agent 名称以区分身份。当前不实现。

### 6.3 未知用户提示

未绑定用户发消息时，Bot 直接回复提示消息：

```
用户发消息 → 查 adapter_agent_mappings → 未找到
  → Bot 回复：
    "您尚未绑定 Agent Hub 账号，无法参与对话。
     请联系管理员完成绑定。
     您的用户标识：ou_96274fa8fd92ee01..."
  → 消息不写入内部系统，流程终止
```

管理员收到用户标识后，在 Web 后台将该 open_id 绑定到对应的 Human Agent。

---

## 7. 绑定流程

### 7.1 非人类 Agent — Bot 凭证绑定

由管理员在 Admin 后台操作：

```
Admin 选择 Agent → 选择平台 → 填入 Bot 凭证 → 保存
                                                  ↓
                                        adapter_configs 写入
                                                  ↓
                                        自动启动 WebSocket 连接
```

### 7.2 人类 Agent — 外部用户映射

绑定方式：

| 方式 | 流程 | 适用场景 |
|------|------|---------|
| **手动绑定** | Admin 在 Web 后台填入外部用户 ID + 选择 Agent | 当前阶段唯一方式 |
| **验证码自助** | 用户发消息 → Bot 返回绑定码 → 用户在 Web 输入 → 自动绑定 | 未来增强，当前不实现 |

当前阶段流程：管理员创建 Human Agent → 用户尝试发消息 → Bot 回复用户标识 → 用户转发给管理员 → 管理员在 Web 后台绑定。

---

## 8. 未来演进

### 8.1 Context Tree 驱动 Agent 创建

Agent Hub 读取 Context Tree 指定目录（如 `members/`）自动同步 Agent 列表：

```
Context Tree                    Agent Hub
members/                        agents 表
├── zhangsan/  ──同步──→        zhangsan (human)
├── john/      ──同步──→        john (human)
├── xx-agent/ ──同步──→        xx-agent (personal_assistant)
└── reviewer/  ──同步──→        reviewer (autonomous_agent)
```

- Token 自动生成并写回 Context Tree
- Agent 增删改由 Context Tree 驱动，Agent Hub 被动同步
- Adapter 绑定仍通过 Admin 后台手动操作

### 8.2 分层独立演进

```
Agent 数据源层   可替换：Admin API → Context Tree → 外部 IdP
Agent Hub 核心   不变：agents, chats, inbox, messages
Adapter 层      可扩展：Feishu → Slack → Discord → ...
```

每层独立演进，互不影响。新增平台只需实现 Adapter，不动核心；切换 Agent 数据源只动最上层，Adapter 不变。
