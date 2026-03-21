---
title: "Agent Hub Server 详细设计"
status: draft
owners: [baixiaohang]
depends_on: agent-hub-overview.20260320.md
---

# Agent Hub Server 详细设计

本文档是 [总体技术方案](agent-hub-overview.20260320.md) 的配套文档，定义 Server 的内部架构、核心业务流和各组件的实现细节。

---

## 1. Server 整体架构

### 1.1 组件架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Agent Hub Server                              │
│                                                                      │
│  ┌─────────── Messaging ────────────┐  ┌──── Agent Management ────┐  │
│  │                                  │  │                          │  │
│  │  Chat Manager    Delivery Engine │  │  Agent CRUD   Token Mgmt │  │
│  │  Inbox Store     Notifier        │  │  Presence                │  │
│  │                                  │  │                          │  │
│  └──────────────────────────────────┘  └──────────────────────────┘  │
│                                                                      │
│  ┌─────────── Adapter ──────────────┐  ┌──── Admin ───────────────┐  │
│  │                                  │  │                          │  │
│  │  ChannelAdapter (飞书/Slack)     │  │  Admin Users   JWT Auth  │  │
│  │  Config Registry                 │  │  System Config           │  │
│  │                                  │  │                          │  │
│  └──────────────────────────────────┘  └──────────────────────────┘  │
│                                                                      │
│  ┌─────────── API Layer ────────────┐  ┌──── Storage ─────────────┐  │
│  │                                  │  │                          │  │
│  │  Agent Routes     Admin Routes   │  │  Database (连接池)       │  │
│  │  Webhook Routes   WebSocket      │  │  Repositories            │  │
│  │  Auth Middleware                  │  │  Alembic Migrations      │  │
│  │                                  │  │                          │  │
│  └──────────────────────────────────┘  └──────────────────────────┘  │
│                                                                      │
│                              PostgreSQL                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 组件职责

| 组件 | 子组件 | 职责 | 实现位置 |
|------|--------|------|---------|
| **Messaging** | Chat Manager | Chat CRUD、参与者管理 | `messaging/chats.py` |
| | Delivery Engine | 消息存储、fan-out、replyTo 路由 | `messaging/delivery.py` |
| | Inbox Store | InboxEntry 写入、消费（SKIP LOCKED）、ACK | `messaging/inboxes.py` |
| | Notifier | PG LISTEN/NOTIFY → WebSocket 推送 | `messaging/notifications.py` |
| **Agent Mgmt** | Agent CRUD | 创建、查询、更新、停用 Agent | `agents/manager.py` |
| | Token Mgmt | Token 生成、轮转、吊销 | `agents/tokens.py` |
| | Presence | 在线状态追踪 | `agents/presence.py` |
| **Adapter** | ChannelAdapter | 飞书/Slack 桥接 | `adapters/feishu.py` 等 |
| | Config Registry | Bot 凭证动态管理、热加载 | `adapters/registry.py` |
| **Admin** | Admin Users | 管理员 CRUD | `admin/users.py` |
| | JWT Auth | 登录、Token 签发/刷新 | `auth/admin_auth.py` |
| | System Config | 运行时参数管理 | `admin/` (TBD) |
| **API Layer** | Routes | HTTP 路由 + WebSocket | `api/routes/` |
| | Auth Middleware | Agent Token / Admin JWT 校验 | `auth/` |
| **Storage** | Database | 连接池、事务管理 | `storage/database.py` |
| | Repositories | 数据访问层 | `storage/repositories.py` |

### 1.3 组件间关系

```
API Layer
  │
  ├── Agent Token Middleware ──► Messaging（Chat/Message/Inbox 操作）
  │                          ──► Agent Presence（WebSocket 连接追踪）
  │
  ├── Admin JWT Middleware  ──► Agent Management（CRUD/Token）
  │                         ──► Adapter Config Registry
  │                         ──► System Config
  │
  └── Webhook Handler      ──► Adapter.verify + parse
                            ──► Messaging.send_to_chat（入站消息）

Messaging
  ├── Delivery Engine ──► Inbox Store（fan-out 写入）
  ├── Delivery Engine ──► Notifier（PG NOTIFY）
  └── Inbox Store     ──► Notifier（WebSocket 推送）

Adapter（虚拟参与者）
  ├── 入站 ──► Messaging.send_to_chat
  └── 出站 ◄── 自己的 Inbox（消费 + 调用外部平台 API）

所有组件 ──► Storage（PostgreSQL）
```

---

## 2. 核心业务流

### 2.1 消息发送全流程

```
Client 调用 POST /chats/{chat_id}/messages
  │
  ▼
API Layer: Agent Token 认证 → 参与者校验
  │
  ▼
Delivery Engine:
  ├── ① 存储 message（PG 事务内）
  ├── ② 查询 Chat 参与者
  ├── ③ Fan-out: 批量创建 inbox_entries（每个参与者一条）
  ├── ④ 如有 in_reply_to → 查原始消息 → 如有 reply_to → 额外投递
  ├── ⑤ 事务提交
  └── ⑥ PG NOTIFY 通知（事务外，丢失不影响正确性）
          │
          ▼
     Notifier → 所有 Server 实例收到通知
          │
          ▼
     持有目标 Agent WebSocket 的实例 → 推送给 Client
```

### 2.2 Inbox 消费全流程

```
Client 通过 WebSocket 收到通知（或定时轮询）
  │
  ▼
Client 调用 GET /inboxes/{inbox_id}/entries
  │
  ▼
Inbox Store:
  ├── SELECT ... FOR UPDATE SKIP LOCKED（取 pending 条目）
  ├── UPDATE status = 'delivered', delivered_at = NOW()
  └── 返回 entries
          │
          ▼
Client 根据 entry.chat_id 路由到 Session → 处理
  │
  ├── 长时间处理 → 定期调用 POST .../renew（心跳续约）
  │
  ▼
处理完成 → Client 调用 POST .../ack
  │
  ▼
Inbox Store: UPDATE status = 'acked', acked_at = NOW()
```

### 2.3 Adapter 入站全流程

```
飞书 webhook → POST /webhooks/feishu/{bot_id}
  │
  ▼
Adapter:
  ├── verify_webhook()（签名校验）
  ├── parse_inbound()（解析为统一 InboundEvent）
  ├── 去重（event_id，INSERT ... ON CONFLICT DO NOTHING）
  ├── 查 adapter_agent_mappings（external_user_id → agent_id）
  │   └── 未绑定？→ 触发绑定流程
  ├── 查 adapter_chat_mappings（external_channel_id → chat_id）
  │   └── 不存在？→ 自动创建 Chat + 映射
  └── Messaging.send_to_chat(chat_id, message)
          │
          ▼
     正常消息投递流程（同 2.1）
```

### 2.4 Adapter 出站全流程

```
Chat 中有新消息
  │
  ▼
Fan-out: inbox_entry 到所有参与者（含 adapter_feishu 虚拟参与者）
  │
  ▼
Adapter 消费自己的 inbox_entry
  ├── 查 adapter_chat_mappings（chat_id → external_channel_id）
  ├── 查 adapter_agent_mappings（message.sender_id → bot app_id）
  ├── 用该 Bot 的凭证调用飞书/Slack API 发送
  └── Human 在飞书看到来自对应 Bot 的消息
```

### 2.5 send_to_agent 流程

```
Client 调用 POST /agents/{agent_id}/messages
  │
  ▼
Server:
  ├── 查找 sender 和 recipient 之间是否已有 direct chat
  ├── 没有 → 自动创建 direct chat（两人为参与者）
  ├── 有 → 复用
  └── 调用 send_to_chat(chat_id, message)
```

---

## 3. 数据模型

### 3.1 完整 DDL

```sql
-- ========================================
-- 平台核心表
-- ========================================

CREATE TABLE agents (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT 'default',
    type            TEXT NOT NULL,           -- "human" | "personal_assistant" | "autonomous_agent"
    display_name    TEXT,
    inbox_id        TEXT UNIQUE NOT NULL,
    status          TEXT DEFAULT 'active',   -- "active" | "suspended"
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_tokens (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,              -- bcrypt hash
    name         TEXT,                       -- 可选标签（如 "production"、"dev"）
    expires_at   TIMESTAMPTZ,               -- 过期时间（NULL = 不过期）
    revoked_at   TIMESTAMPTZ,               -- 吊销时间（NULL = 有效）
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE agent_presence (
    agent_id     TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'offline',  -- "online" | "offline"
    instance_id  TEXT,                              -- 持有 WebSocket 的 server 实例 ID
    connected_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE admin_users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,          -- bcrypt hash
    role          TEXT NOT NULL DEFAULT 'admin',  -- "super_admin" | "admin"
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE server_instances (
    instance_id    TEXT PRIMARY KEY,
    last_heartbeat TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE system_configs (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- 消息系统表
-- ========================================

CREATE TABLE chats (
    id                TEXT PRIMARY KEY,
    organization_id   TEXT NOT NULL DEFAULT 'default',
    type              TEXT NOT NULL DEFAULT 'direct',  -- "direct" | "group" | "thread"
    topic             TEXT,
    lifecycle_policy  TEXT DEFAULT 'persistent',
    parent_chat_id    TEXT REFERENCES chats(id),
    metadata          JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_participants (
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    agent_id   TEXT NOT NULL REFERENCES agents(id),
    role       TEXT DEFAULT 'member',
    mode       TEXT DEFAULT 'full',     -- "full" | "mention_only"（消费端行为，不影响投递）
    joined_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, agent_id)
);

CREATE TABLE messages (
    id           TEXT PRIMARY KEY,       -- UUID v7
    chat_id      TEXT REFERENCES chats(id),
    sender_id    TEXT NOT NULL REFERENCES agents(id),
    format       TEXT NOT NULL,          -- "text" | "markdown" | "card" | "reference" | "file"
    content      JSONB NOT NULL,
    metadata     JSONB DEFAULT '{}',
    reply_to     JSONB,                  -- 跨 Chat 回复路由：{inbox, chat}
    in_reply_to  TEXT REFERENCES messages(id),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inbox_entries (
    id           BIGSERIAL PRIMARY KEY,
    inbox_id     TEXT NOT NULL,
    message_id   TEXT NOT NULL REFERENCES messages(id),
    chat_id      TEXT,                   -- 路由标签（可能 ≠ message.chat_id）
    status       TEXT DEFAULT 'pending', -- "pending" | "delivered" | "acked" | "failed"
    retry_count  INT DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    acked_at     TIMESTAMPTZ,
    CONSTRAINT uq_inbox_delivery UNIQUE (inbox_id, message_id, chat_id)
);

-- ========================================
-- Adapter 表
-- ========================================

CREATE TABLE adapter_configs (
    id          SERIAL PRIMARY KEY,
    platform    TEXT NOT NULL,            -- "feishu" | "slack"
    agent_id    TEXT REFERENCES agents(id),
    credentials JSONB NOT NULL,           -- 加密存储
    status      TEXT DEFAULT 'active',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE adapter_chat_mappings (
    id                  SERIAL PRIMARY KEY,
    platform            TEXT NOT NULL,
    external_channel_id TEXT NOT NULL,
    chat_id             TEXT NOT NULL REFERENCES chats(id),
    thread_id           TEXT,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (platform, external_channel_id, COALESCE(thread_id, ''))
);

CREATE TABLE adapter_agent_mappings (
    id                SERIAL PRIMARY KEY,
    platform          TEXT NOT NULL,
    external_user_id  TEXT NOT NULL,
    agent_id          TEXT NOT NULL REFERENCES agents(id),
    bound_via         TEXT,               -- "code" | "reverse_token" | "oauth" | "manual"
    display_name      TEXT,
    metadata          JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (platform, external_user_id)
);

CREATE TABLE adapter_message_references (
    id                  SERIAL PRIMARY KEY,
    message_id          TEXT NOT NULL REFERENCES messages(id),
    platform            TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    external_channel_id TEXT NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (message_id, platform)
);
```

### 3.2 索引

```sql
-- 平台核心
CREATE INDEX idx_agents_org ON agents (organization_id);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens (agent_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_agent_tokens_hash ON agent_tokens (token_hash) WHERE revoked_at IS NULL;

-- 消息系统
CREATE INDEX idx_inbox_pending ON inbox_entries (inbox_id, created_at) WHERE status = 'pending';
CREATE INDEX idx_messages_chat_time ON messages (chat_id, created_at);
CREATE INDEX idx_messages_in_reply_to ON messages (in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX idx_participants_agent ON chat_participants (agent_id);
```

---

## 4. API 定义

### 4.1 Agent API（Agent Token 认证）

**Chat：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chats` | POST | 创建 Chat |
| `/chats/{chat_id}` | GET | 获取 Chat 信息 |
| `/chats/{chat_id}/participants` | POST | 添加参与者 |
| `/chats/{chat_id}/participants/{agent_id}` | DELETE | 移除参与者 |

**消息：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chats/{chat_id}/messages` | POST | 发送消息到 Chat |
| `/chats/{chat_id}/messages` | GET | 查询 Chat 历史 |
| `/agents/{agent_id}/messages` | POST | 发消息给 Agent（自动建 Chat） |

**Inbox：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/inboxes/{inbox_id}/entries` | GET | 拉取待处理消息 |
| `/inboxes/{inbox_id}/entries/{entry_id}/ack` | POST | 确认消费 |
| `/inboxes/{inbox_id}/entries/{entry_id}/renew` | POST | 心跳续约 |

**WebSocket：**

| 端点 | 说明 |
|------|------|
| `WS /ws/inbox/{inbox_id}` | 新消息推送 |

**权限规则：**

| 操作 | 规则 |
|------|------|
| 读 Inbox | 只能读自己的 Inbox |
| 发消息到 Chat | 只能发到自己参与的 Chat |
| 发消息给 Agent | 同一组织内不限制，自动创建 direct chat |
| 查 Chat 历史 | 只能查自己参与的 Chat |
| 创建 Chat | 允许，创建者自动成为参与者 |

### 4.2 Admin API（Admin JWT 认证）

**认证：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/auth/login` | POST | 登录（返回 access_token + refresh_token） |
| `/admin/auth/refresh` | POST | 刷新 access_token |

**Agent 管理：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/agents` | GET | 列出所有 Agent（含在线状态） |
| `/admin/agents` | POST | 创建 Agent |
| `/admin/agents/{agent_id}` | GET | 获取详情 |
| `/admin/agents/{agent_id}` | PATCH | 更新 |
| `/admin/agents/{agent_id}` | DELETE | 停用 |
| `/admin/agents/{agent_id}/tokens` | POST | 生成 Token（明文仅返回一次） |
| `/admin/agents/{agent_id}/tokens` | GET | 列出 Token |
| `/admin/agents/{agent_id}/tokens/{token_id}` | DELETE | 吊销 Token |

**Adapter 配置：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/adapters` | GET | 列出 Adapter 配置 |
| `/admin/adapters` | POST | 添加 Adapter（Bot 凭证） |
| `/admin/adapters/{id}` | PATCH | 更新 |
| `/admin/adapters/{id}` | DELETE | 删除 |

**系统配置：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/system/config` | GET | 获取系统配置 |
| `/admin/system/config` | PATCH | 更新系统配置 |

**概览：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/overview` | GET | 系统概览（Agent 数、在线数、活跃 Chat 数） |

### 4.3 Webhook

| 端点 | 方法 | 说明 |
|------|------|------|
| `/webhooks/feishu/{bot_id}` | POST | 飞书 webhook 入口 |
| `/webhooks/slack` | POST | Slack webhook 入口 |

---

## 5. 消息投递引擎

### 5.1 仅依赖 PostgreSQL

PostgreSQL 同时覆盖三种需求：

| 需求 | PostgreSQL 能力 | 替代方案（暂不引入） |
|------|----------------|-------------------|
| 消息存储 | 表 + JSONB | — |
| 投递队列 | inbox_entries + SKIP LOCKED | Redis Streams / NATS |
| 实时通知 | LISTEN/NOTIFY | Redis Pub/Sub |

日消息量千~万级下，PostgreSQL 队列吞吐（3 万+ msg/s）远超需求。**一个依赖 = 更低的部署门槛。**

### 5.2 fan-out on write

消息发到 Chat 时，**立即为每个参与者创建 InboxEntry**。

**优点：**
- 消费简单快速 — 每个 Agent 只查自己的 inbox_entries
- 每个 Agent 独立的投递状态
- replyTo 路由标签可以不同于 message.chat_id
- 写入在一个事务内，一致性有保证

**缺点与应对：**

| 缺点 | 应对策略 |
|------|---------|
| 写入放大（N 参与者 = N 行） | 批量插入，PG 批量写入非常快 |
| inbox_entries 表增长快 | 定期清理 acked 的 entries |
| 大群极端场景 | Agent Team 下罕见，大多 2-3 人 direct chat |

**mention_only 不影响 fan-out。** 所有参与者都收到 inbox_entry。mention_only 是消费端行为。

### 5.3 PG LISTEN/NOTIFY

**原理：** PostgreSQL 内置的发布/订阅，走数据库连接。

```sql
-- 订阅者：
LISTEN inbox_notifications;

-- 发布者（写完 inbox_entry 后）：
NOTIFY inbox_notifications, 'inbox_agent_a:msg_123';
```

**多实例广播：** 所有 LISTEN 同一 channel 的连接都会收到通知。持有目标 Agent WebSocket 的实例负责推送，其他实例忽略。

**连接模型：** 每个 Server 实例 1 条专用 LISTEN 连接，监听共享 channel `inbox_notifications`。

**特性：** at-most-once（连接断开时丢失），由轮询兜底覆盖。

### 5.4 SKIP LOCKED

把 inbox_entries 表变成并发安全的队列：

```sql
SELECT * FROM inbox_entries WHERE inbox_id = $1 AND status = 'pending'
  ORDER BY created_at LIMIT 10
  FOR UPDATE SKIP LOCKED;
```

被锁行被跳过，多个消费者互不阻塞。

### 5.5 replyTo 机制

Agent B 回复时设置 `in_reply_to = 原始消息ID`，Delivery Engine 自动查找原始消息的 `reply_to` 字段，创建额外 InboxEntry（路由标签 = reply_to.chat）。对 Agent B 完全透明。

**投递引擎伪代码：**

```python
async def send_to_chat(chat_id: str, message: MessageCreate) -> Message:
    async with db.transaction():
        msg = await message_repo.create(chat_id=chat_id, **message.dict())
        participants = await chat_repo.get_participants(chat_id)

        # 批量 fan-out
        entries = [(p.inbox_id, msg.id, chat_id) for p in participants]
        await inbox_repo.bulk_create_entries(entries)

        # replyTo 路由
        if message.in_reply_to:
            original = await message_repo.get(message.in_reply_to)
            if original and original.reply_to:
                await inbox_repo.create_entry(
                    inbox_id=original.reply_to["inbox"],
                    message_id=msg.id,
                    chat_id=original.reply_to["chat"],
                )

    await notifier.notify_inboxes(target_inbox_ids, msg.id)
    return msg
```

### 5.6 可靠性：at-least-once + 消费者幂等

| 环节 | Server 保证 | Client 责任 |
|------|------------|-----------|
| 消息写入 | PostgreSQL 事务，持久化 | — |
| Fan-out | 同一事务内批量写入；唯一约束防重复 | — |
| 通知 | best-effort（PG NOTIFY + 轮询兜底） | — |
| 消费 | 未 ACK 的消息始终可被拉取 | 处理完再 ACK |
| 重复投递 | 超时重置可能导致重复 | Client 自行去重 |

### 5.7 ACK 协议

```
① get_pending_entries() → status = 'delivered'
② Client Session 处理（LLM 推理、tool calls...）
③ ack_entry() → status = 'acked'

崩溃在 ②③ 之间：
  → 停在 'delivered' → 超时重置为 'pending' → 重新消费
```

### 5.8 心跳续约

长时间处理时，Client 定期调用 `renew_entry(entry_id)`：
- 更新 `delivered_at = NOW()`
- 延长超时窗口，防止不必要的重置

### 5.9 超时重置

```sql
-- 每分钟运行
UPDATE inbox_entries SET status = 'pending', retry_count = retry_count + 1
WHERE status = 'delivered'
  AND delivered_at < NOW() - INTERVAL '5 minutes'
  AND retry_count < 3;

UPDATE inbox_entries SET status = 'failed'
WHERE status = 'delivered'
  AND delivered_at < NOW() - INTERVAL '5 minutes'
  AND retry_count >= 3;
```

超时时间和最大重试次数通过 system_configs 可调。

### 5.10 故障恢复

| 故障 | 恢复 |
|------|------|
| PostgreSQL 宕机 | PG 主从切换 |
| Server 实例宕机 | Client 重连其他实例；消息在 PG 中不丢 |
| Client 宕机 | 消息在 inbox_entries 积压；恢复后继续消费 |
| Adapter 异常 | 外部平台重试 webhook；Adapter 恢复后消费积压 |
| 消费超时 | 后台任务重置 delivered → pending |

---

## 6. replyTo 完整场景走读

**场景：** Human 让 Agent A 更新文档，Agent A 需要 Agent B 审批。

```
Chat #1: Human ↔ Agent A（日常对话）
Chat #2: Agent A ↔ Agent B（通过 send_to_agent 自动创建）
```

**步骤 1：Human 在 Chat #1 说"更新文档"**

```
messages:      id=M1, chat_id=chat_1, sender=human, content="更新文档"
inbox_entries: id=1, inbox_id=inbox_a, message_id=M1, chat_id=chat_1, status=pending
```

**步骤 2：Agent A 向 Agent B 发审批请求（带 replyTo）**

```
messages:      id=M2, chat_id=chat_2, sender=agent_a, content="请审批"
               reply_to={inbox: inbox_a, chat: chat_1}
inbox_entries: id=2, inbox_id=inbox_b, message_id=M2, chat_id=chat_2, status=pending
```

**步骤 3：Agent B 回复"Approved"（in_reply_to=M2）**

Delivery Engine：
1. 存储 M3（chat_id=chat_2, in_reply_to=M2）
2. 正常 fan-out Chat #2 参与者
3. 检查 in_reply_to=M2 → M2.reply_to={inbox_a, chat_1} → 额外投递

```
messages:      id=M3, chat_id=chat_2, sender=agent_b, content="Approved", in_reply_to=M2

inbox_entries:
  id=3, inbox_id=inbox_a, message_id=M3, chat_id=chat_2  ← 正常投递
  id=4, inbox_id=inbox_a, message_id=M3, chat_id=chat_1  ← replyTo 投递
```

**Agent A 的 Inbox 两条 entry（同一消息 M3，不同路由）：**

| entry | chat_id (路由) | 路由到 |
|-------|---------------|--------|
| #3 | chat_2 | Chat #2 Session（与 Agent B 的对话） |
| #4 | **chat_1** | Chat #1 Session（与 Human 的原始任务） |

M3 本身存储在 Chat #2。Chat #1 历史中没有 M3。Agent A 通过 entry #4 在 Chat #1 Session 收到审批结果，继续任务并告诉 Human。

**设计理由：**
- 消息归属唯一 — 每条 message 有且只有一个 chat_id
- replyTo 是路由，不是存储 — InboxEntry.chat_id 是路由标签
- Agent A 负责转述 — 不需要 Server 自动搬运消息

---

## 7. Adapter 架构

### 7.1 1:1 绑定模型

```
内部身份                飞书身份
Human X    ←1:1→    飞书账号 X（ou_xxx）
Agent A    ←1:1→    飞书 Bot A（app_id_a）
Agent B    ←1:1→    飞书 Bot B（app_id_b）
```

**通信路径：**

| 场景 | 通信方式 | 飞书参与？ |
|------|---------|----------|
| Agent ↔ Agent | 内部 Chat | ❌ |
| Agent → Human | 内部 Chat + Adapter 出站 | ✅ |
| Human → Agent | 飞书 + Adapter 入站 | ✅ |
| Human ↔ Human | 飞书原生 | Server 不参与 |

### 7.2 Adapter 接口

```python
class ChannelAdapter(ABC):
    def platform_id(self) -> str: ...
    def capabilities(self) -> dict: ...

    # 入站
    async def verify_webhook(self, request) -> bool: ...
    async def parse_inbound(self, payload) -> InboundEvent | None: ...

    # 出站
    async def send_outbound(self, external_channel_id, message, thread_id=None) -> dict: ...
    async def edit_outbound(self, external_channel_id, message_id, content) -> dict: ...

    # 身份
    async def resolve_user(self, external_user_id) -> ChannelUser: ...
```

### 7.3 多 Bot 管理

一个 FeishuAdapter 实例管理多个 Bot 凭证（从 adapter_configs 表加载）：

```python
class FeishuAdapter(ChannelAdapter):
    def __init__(self, bots: list[FeishuBotConfig]):
        self._bots_by_app_id = {b.app_id: b for b in bots}
        self._bots_by_agent = {}

    # 入站：根据 webhook 路径中的 bot_id 选择凭证
    # POST /webhooks/feishu/{bot_id}

    # 出站：根据 message.sender_id 查映射找到对应 Bot
    async def send_outbound(self, external_channel_id, message, **kwargs):
        bot = self._get_bot_for_agent(message.sender_id)
        token = await bot.get_access_token()
```

### 7.4 群聊支持

```
内部 Chat #5: Human X, Human Y, Agent A, Agent B
飞书群聊:     飞书用户 X, 飞书用户 Y, Bot A, Bot B
```

**入站去重：** N 个 Bot 在群里 → 一条消息触发 N 次 webhook。用 event_id 去重：

```sql
INSERT INTO processed_events (event_id, platform) VALUES ($1, 'feishu')
ON CONFLICT DO NOTHING RETURNING event_id;
```

**出站 Bot 选择：** Agent A 的消息用 Bot A 发，Agent B 用 Bot B。

### 7.5 出站格式选择

检测消息内容是否包含 Markdown。支持 Markdown 的平台发送卡片，否则纯文本。Agent 无需关心平台差异。

### 7.6 身份绑定

| 方式 | 流程 |
|------|------|
| **验证码（IM → Web）** | Human 在飞书给 Bot 发消息 → Bot 返回验证码 → Human 在 Web 输入 → 绑定 |
| **反向令牌（Web → IM）** | Human 在 Web 点击关联 → 生成令牌 → 在飞书发给 Bot → 绑定 |
| **手动绑定** | Admin 通过 API 直接创建映射 |

### 7.7 配置动态管理

Bot 凭证存 `adapter_configs` 表，Admin API 增删改。

**凭证加密：** credentials JSONB 在应用层使用对称加密（Fernet / AES-256-GCM），密钥通过环境变量注入。

**热加载：** Admin 修改配置 → PG NOTIFY `adapter_config_changed` → 所有实例收到 → Adapter 重新加载，无需重启。

---

## 8. Agent 生命周期管理

### 8.1 Agent CRUD

```python
# POST /admin/agents
{
    "id": "agent_reviewer",          # 可自定义，默认 UUID
    "type": "autonomous_agent",
    "display_name": "Code Reviewer"
}
# → 自动生成 inbox_id = "inbox_agent_reviewer"
```

**状态：** `active`（正常） / `suspended`（暂停，API 请求被拒）。

停用 = suspended + 吊销所有 Token。

### 8.2 Token 管理

**生成：**

```python
# POST /admin/agents/{agent_id}/tokens
{ "name": "production" }
# → 返回 { "token_id": "tok_xxx", "token": "aghub_xxxxx..." }
# 明文仅返回一次
```

Token 格式：`aghub_` 前缀 + 随机字符串。SHA-256 hash 存入 agent_tokens。

> **为什么用 SHA-256 而不是 bcrypt？** API token 是高熵随机串（64 hex chars = 256 bits），不需要慢哈希抵抗暴力破解。SHA-256 支持直接按 hash 查询（O(1) 索引命中），是 GitHub PAT、Stripe API Key 等业界标准做法。bcrypt 仅用于 admin 密码（低熵，需要慢哈希）。

**轮转：** 生成新 Token → 两个同时有效（窗口期）→ Client 切换 → 吊销旧 Token。

**认证：**
```python
async def authenticate_agent(token: str) -> Agent:
    # sha256(token) → 查 agent_tokens（未吊销 + 未过期）
    # 更新 last_used_at
    # 返回关联的 Agent（需 status = 'active'）
```

### 8.3 Agent 在线状态

存 `agent_presence` 表，基于 WebSocket 连接追踪：

```
WebSocket 连接 → UPSERT status='online', instance_id=当前实例, connected_at=NOW()
WebSocket 断开 → UPDATE status='offline', last_seen_at=NOW()
```

**实例崩溃兜底：**

Server 实例通过 `server_instances` 表注册心跳。定时任务检查超时实例，批量清理 presence：

```sql
UPDATE agent_presence SET status = 'offline'
WHERE instance_id IN (
    SELECT instance_id FROM server_instances
    WHERE last_heartbeat < NOW() - INTERVAL '60 seconds'
);
```

---

## 9. Admin 认证

### 9.1 安全设计原则（OpenClaw 教训）

OpenClaw（32.5 万 star 开源 AI 助手）有 288 个安全通告。核心教训：

| 问题模式 | OpenClaw 的坑 | Agent Hub 的规避 |
|---------|--------------|----------------|
| 隐式信任 | localhost 免认证 → 本地 RCE | localhost 也必须认证 |
| 客户端声明权限 | 连接自行声明 admin scope | Server 查表决定权限 |
| 认证共享 | 共享认证连接可提权 | 两套认证完全隔离 |
| 审批绕过 | exec allowlist 多种绕过 | 权限检查在 Server 端 |
| 渠道授权绕过 | IM 集成的 sender 验证绕过 | Adapter 严格验证 sender |

### 9.2 Admin 用户管理

**初始化：**
```bash
$ agent-hub server init-admin
  Username: admin
  Password: ********
  → 创建 super_admin
```

**角色：**

| 角色 | 权限 |
|------|------|
| `super_admin` | 全部权限，包括管理其他 Admin |
| `admin` | Agent 管理、Adapter 配置、系统配置 |

### 9.3 JWT 认证流程

```
登录：POST /admin/auth/login { username, password }
  → bcrypt 校验
  → 签发 access_token（30 分钟）+ refresh_token（7 天）

请求：Authorization: Bearer <access_token>
  → 验证 JWT 签名 + 过期时间
  → 从 payload 取 admin_id → 查表获取当前 role

刷新：POST /admin/auth/refresh { refresh_token }
  → 验证 → 签发新 access_token
```

**JWT payload 只携带 admin_id，不携带 role。** 每次请求查表，确保 role 变更即时生效。

---

## 10. 系统配置管理

存储：`system_configs` 表（key-value JSONB）。

可配置参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `inbox_timeout_seconds` | 300 | 投递超时 |
| `max_retry_count` | 3 | 最大重试次数 |
| `polling_interval_seconds` | 5 | 轮询间隔 |
| `presence_cleanup_seconds` | 60 | 在线状态清理周期 |

**加载与更新：** 启动时从 PG 加载，Admin 修改后 PG NOTIFY 通知所有实例刷新内存缓存。

---

## 附录：完整协作时序图

```
Human        飞书        Adapter      Server       Client A     Client B
  │           │            │            │          (Agent A)    (Agent B)
  │  发消息   │            │            │            │             │
  │──────────►│            │            │            │             │
  │           │  webhook   │            │            │             │
  │           │───────────►│            │            │             │
  │           │            │  send_to   │            │             │
  │           │            │  _chat()   │            │             │
  │           │            │───────────►│            │             │
  │           │            │            │            │             │
  │           │            │            │  inbox + notify          │
  │           │            │            │───────────►│             │
  │           │            │            │            │             │
  │           │            │            │  consume   │             │
  │           │            │            │◄───────────│             │
  │           │            │            │            │             │
  │           │            │            │            │ 需要 Agent B 审批
  │           │            │  send_to_agent          │             │
  │           │            │  (reply_to=chat_1)      │             │
  │           │            │            │◄───────────│             │
  │           │            │            │            │             │
  │           │            │            │  inbox + notify          │
  │           │            │            │────────────────────────►│
  │           │            │            │            │   consume   │
  │           │            │            │◄────────────────────────│
  │           │            │            │            │  审批通过    │
  │           │            │  send_to_chat           │             │
  │           │            │  (in_reply_to=M2)       │             │
  │           │            │            │◄────────────────────────│
  │           │            │            │  replyTo 投递            │
  │           │            │            │───────────►│             │
  │           │            │            │            │ Session 继续
  │           │            │            │            │ 完成任务     │
  │           │            │  send_to   │            │             │
  │           │            │  _chat()   │            │             │
  │           │            │            │◄───────────│             │
  │           │  outbound  │            │            │             │
  │           │  (Bot A)   │            │            │             │
  │           │◄───────────│            │            │             │
  │  回复     │            │            │            │             │
  │◄──────────│            │            │            │             │
```
