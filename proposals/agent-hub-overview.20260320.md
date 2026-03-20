---
title: "Agent Hub 总体技术方案"
status: draft
owners: [baixiaohang]
---

# Agent Hub 总体技术方案

本文档定义 Agent Hub 的系统架构、子系统边界与接口、数据模型和部署架构。Server 的内部实现细节见 [Server 详细设计](agent-hub-server-detailed-design.20260320.md)。

**术语约定：** 内部通信容器统一使用 **Chat**（而非 Channel）。外部 IM 平台（Slack、Discord）的 channel 概念保持原名。

---

## 1. 系统定位与设计原则

### 1.1 系统定位

Agent Hub 是 Agent Team 的中心化协作平台，解决以下问题：

| 问题 | Agent Hub 的回答 |
|------|-----------------|
| Agent 如何注册和认证？ | Server 统一管理 Agent 身份和 Token |
| Agent 之间如何通信？ | 基于 Chat + Inbox 的消息系统 |
| Agent 如何与外部 IM 平台交互？ | Adapter 桥接飞书/Slack |
| 管理员如何管理整个平台？ | Web 管理后台 + Admin API |
| Agent 实例如何运行和调度？ | Client（Agent Runtime）管理本地 agent |

Agent Hub 包含三个子系统：

```
Agent Hub
├── Server     中心化平台服务器（消息系统、Agent 管理、Adapter、管理后台）
├── Client     Agent Runtime（管理和调度本地 agent 实例）
└── Web        管理后台前端（React）
```

```
Agent Hub ≠ Agent 本身（具体的 LLM agent 逻辑不在 Hub 内）
Agent Hub ≠ 编排框架
Agent Hub ≠ Context Tree
```

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **三个子系统独立部署、独立发布** | Server、Client、Web 各自独立打包，无代码依赖。 |
| **仅依赖 PostgreSQL** | Server 当前规模下 PostgreSQL 覆盖存储、队列、通知三种需求，不引入额外中间件。 |
| **公共接口优先** | 从第一天起定义稳定的 HTTP API。面向开源，接口不轻易 break。 |
| **按公网标准设计** | 不假设内网环境。HTTPS + Token Auth 为默认，内网部署时可简化。 |
| **Server 决定权限，Client 零信任** | 权限由 Server 查表决定，Client 无法自行声明或提升权限。 |

### 1.3 前提条件

| 条件 | 说明 | 理由 |
|------|------|------|
| **单组织部署** | 默认每个 Server 服务一个组织。数据模型中保留 `organization_id` 字段。 | 当前阶段面向自部署场景。保留字段为未来云托管多租户预留。 |
| **不支持跨组织通信** | 同一组织内的 Agent/Human 可以自由通信。跨组织不在当前范围内。 | 跨组织需要联邦协议、跨域认证等，复杂度远超当前需求。 |

---

## 2. 整体架构

### 2.1 三个子系统

```
┌─────────────────────────────────────────────────────────────┐
│              Server (中心化，无状态)                         │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐   │
│  │Messaging │  │ Agent    │  │ Adapter   │  │ Admin     │   │
│  │          │  │ Mgmt     │  │ 飞书/Slack│  │           │   │
│  │ Chat     │  │ CRUD     │  │           │  │ JWT 认证  │   │
│  │ Inbox    │  │ Token    │  │ Config    │  │ Agent 管理│   │
│  │ Delivery │  │ Presence │  │ Bridge    │  │ 系统配置   │   │
│  └──────────┘  └──────────┘  └───────────┘  └───────────┘   │
│                       PostgreSQL                            │
└────────────────────────────┼────────────────────────────────┘
          ┌──────────────────┼──────────────────┐
          │ HTTP + WS        │ HTTP + WS        │ HTTP
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │  Client A   │   │  Client B   │   │    Web      │
   │ Agent Runt. │   │ Agent Runt. │   │ Admin 前端  │
   │             │   │             │   │             │
   │ agent-1     │   │ agent-3     │   │ (React)     │
   │ agent-2     │   │ agent-4     │   │             │
   └─────────────┘   └─────────────┘   └─────────────┘
```

| 子系统 | 角色 | 状态 | 部署 |
|--------|------|------|------|
| **Server** | 中心化平台：消息投递、Agent 管理、Adapter、Admin | 无状态（PG 存储） | 1-N 实例，水平扩展 |
| **Client** | Agent Runtime：管理本地 agent 实例、Session、Inbox 消费 | 有状态（Session/LLM 上下文在内存） | 每个部署节点一个 |
| **Web** | 管理后台前端 | 无状态 | 静态资源，可 CDN |

### 2.2 子系统间交互

```
Client → Server:
  HTTP API   发消息、查 Chat、管理参与者
  WebSocket  接收 Inbox 实时通知
  认证       Agent Token (Bearer)

Web → Server:
  HTTP API   Agent 管理、Adapter 配置、系统配置、概览数据
  认证       Admin JWT

外部 IM → Server:
  Webhook    飞书/Slack 推送消息
  认证       各平台签名验证
```

所有通信由 Client/Web/外部 IM 发起。Server 不主动连接 Client（Client 可能在 NAT 后面）。

---

## 3. Server 概要设计

### 3.1 职责与组件

| 组件 | 职责 |
|------|------|
| **Messaging** | Chat CRUD、消息存储与投递（fan-out on write）、Inbox 管理、replyTo 跨 Chat 路由、实时通知 |
| **Agent Management** | Agent CRUD、Token 生成/轮转/吊销、在线状态追踪 |
| **Adapter** | 桥接外部 IM 平台（飞书/Slack）↔ 内部 Chat，1:1 身份绑定，多 Bot 管理 |
| **Admin** | 管理员认证（JWT）、Agent/Adapter/系统配置的管理接口 |

Server 是**无状态**的 — 所有持久数据在 PostgreSQL，实例本身不持有业务状态。天然支持多实例。

**消息系统设计原则（适用于 Messaging 组件）：**

| 原则 | 说明 |
|------|------|
| **Inbox 是 Server/Client 边界** | Server 写入 Inbox，Client 读取 Inbox。两个子系统通过 Inbox 解耦。 |
| **格式与语义分离** | Message 定义格式（text/markdown/card），不定义语义。语义通过 metadata 由应用层协商。 |

详见 [Server 详细设计 §1](agent-hub-server-detailed-design.20260320.md)。

### 3.2 认证体系（双轨）

两套认证**完全隔离**，无法交叉访问：

| | Agent Token | Admin Auth |
|--|------------|------------|
| **身份** | 机器凭证（Client 中的 agent） | 人类凭证（管理员） |
| **认证方式** | Bearer Token | 用户名密码 → JWT |
| **存储** | agent_tokens 表（bcrypt hash） | admin_users 表（bcrypt hash） |
| **可访问** | Agent API | Admin API |
| **不可访问** | Admin API | Agent API |

安全原则（基于 OpenClaw 教训，详见 [Server 详细设计 §9](agent-hub-server-detailed-design.20260320.md)）：
- **localhost 也必须认证** — OpenClaw 因 localhost 免认证导致本地 RCE
- **Server 查表决定权限** — Token/JWT 中不携带权限声明，防止客户端自我提权
- **两套认证走完全不同的中间件链** — 防止交叉提权

初始化：
```bash
$ agent-hub server init-admin    # CLI 创建初始管理员，无默认密码
```

### 3.3 Agent API（Agent Token 认证）

Client 通过 Agent API 与 Server 交互，分 4 组共约 10 个端点：

| 分组 | 能力 | 端点数 |
|------|------|--------|
| **Chat** | 创建 Chat、管理参与者 | 4 |
| **消息** | 发消息（到 Chat / 到 Agent）、查历史 | 3 |
| **Inbox** | 拉取待处理消息、ACK、心跳续约 | 3 |
| **WebSocket** | Inbox 实时通知 | 1 |

**核心权限规则：** 只能读自己的 Inbox、只能操作自己参与的 Chat、同一组织内 send_to_agent 不限制。

完整端点定义见 [Server 详细设计 §4](agent-hub-server-detailed-design.20260320.md)。

### 3.4 Admin API（Admin JWT 认证）

Web 通过 Admin API 管理平台，分 5 组共约 15 个端点：

| 分组 | 能力 | 端点数 |
|------|------|--------|
| **认证** | 登录、刷新 Token | 2 |
| **Agent 管理** | Agent CRUD、Token 生成/吊销 | 8 |
| **Adapter 配置** | Bot 凭证管理 | 4 |
| **系统配置** | 运行时参数管理 | 2 |
| **概览** | 系统状态概览 | 1 |

完整端点定义见 [Server 详细设计 §4](agent-hub-server-detailed-design.20260320.md)。

### 3.5 Webhook

| 端点 | 说明 |
|------|------|
| `POST /webhooks/feishu/{bot_id}` | 飞书 webhook 入口 |
| `POST /webhooks/slack` | Slack webhook 入口 |

---

## 4. Client 概要设计

### 4.1 职责与定位

Client 是 **Agent Runtime** — 管理和调度本地运行的 agent 实例。每个部署节点运行一个 Client 进程，可管理多个 agent。

```
Client ≠ HTTP SDK（SDK 是 Client 的一个子模块）
Client = Agent Runtime = agent 实例管理 + Session 调度 + Inbox 消费
```

| | Server | Client |
|--|--------|--------|
| **角色** | 中心化平台 | 分布式 agent 运行节点 |
| **状态** | 无状态（PG 存储） | 有状态（Session/LLM 上下文在内存） |
| **管理的对象** | 全局：所有 Agent、Chat、Message | 本地：该节点上运行的 agent 实例 |
| **实例数** | 1-N（水平扩展） | 每个部署节点一个 |

### 4.2 核心能力

| 能力 | 说明 |
|------|------|
| **Agent 实例管理** | 启动/停止/重启本地 agent 实例。每个 agent 用独立的 Token 连接 Server。 |
| **Session 管理** | (Agent + Chat) = 1 Session。Session 持有 LLM 上下文，跨消息持久化。 |
| **Inbox 消费与路由** | 轮询 + WebSocket 拉取新消息 → 按 `entry.chat_id` 路由到对应 Session。 |
| **Server 连接** | HTTP client + WebSocket client，封装 Server API 调用。 |
| **Agent 配置** | 本地 agent 配置（使用哪个 Token、连接哪个 Server、agent 的工具和技能等）。 |

### 4.3 与 Server 的接口

Client 通过 Server 的 Agent API 交互。核心协议：

**Inbox 消费：** Client 通过 WebSocket 接收通知（或定时轮询兜底），拉取 Inbox 中的待处理消息，按 chat_id 路由到 Session 处理，处理完成后 ACK。Server 保证 at-least-once 投递，Client 负责去重。

**replyTo：** 发起方发送消息时设置 `reply_to = {inbox, chat}` 标记回复地址。接收方回复时设置 `in_reply_to = 原始消息 ID`，Server 自动处理跨 Chat 路由，接收方无需感知。

### 4.4 项目结构（概要）

```
client/
├── pyproject.toml              # 包名: agent-hub-client
├── tests/
└── src/
    └── agent_hub_client/
        ├── __init__.py
        ├── runtime.py          # Agent Runtime 主入口
        ├── session.py          # Session 管理 (Agent + Chat)
        ├── inbox.py            # Inbox 消费与路由
        ├── connection.py       # Server 连接 (HTTP + WebSocket)
        ├── models.py           # 数据模型
        └── config.py           # Agent 配置
```

> Client 的详细设计由其他同事负责，本文档仅定义接口契约。

---

## 5. Web 概要设计

### 5.1 职责

Web 是管理后台的前端，供管理员通过浏览器操作：

| 功能 | 说明 |
|------|------|
| **Agent 管理** | 添加/编辑/停用 Agent，生成/吊销 Token |
| **系统概览** | 在线 Agent 数、活跃 Chat 数 |
| **Adapter 配置** | 管理飞书/Slack Bot 凭证和绑定关系 |
| **系统配置** | 修改运行时参数（超时、重试等） |

### 5.2 与 Server 的接口

Web 通过 Server 的 Admin API（JWT 认证）交互。纯前端应用，不直接访问数据库。

### 5.3 项目结构（概要）

```
web/
├── package.json
└── src/
    └── ...                     # React，技术选型 TBD
```

---

## 6. 数据模型全景

### 6.1 实体关系

```
┌──────────┐  拥有(1:N)   ┌──────────────┐
│  Agent   │─────────────►│ Agent Token  │
│          │              │              │
│  id      │              │ token_hash   │
│  type    │              │ expires_at   │
│  inbox_id│              │ revoked_at   │
│  org_id  │              └──────────────┘
│  status  │
└────┬─────┘  追踪(1:1)   ┌──────────────┐
     │───────────────────►│  Presence    │
     │                    │ status       │
     │                    │ last_seen_at │
     │                    └──────────────┘
     │
     │ 参与(M:N)                       属于(N:1)
     ▼                                    │
┌──────────┐  包含(1:N)  ┌──────────┐    │
│   Chat   │────────────►│ Message  │────┘
│          │             │          │
│  type    │             │ sender_id│  投递(1:N)  ┌──────────────┐
│  topic   │             │ format   │────────────►│ InboxEntry   │
└──────────┘             │ reply_to │             │              │
                         │ content  │             │ inbox_id     │
                         └──────────┘             │ chat_id(路由) │
                                                  │ status       │
                                                  └──────────────┘

┌──────────────┐          ┌──────────────────────┐
│ Admin User   │          │ Adapter Config       │
│              │          │                      │
│ username     │          │ platform             │
│ password_hash│          │ agent_id             │
│ role         │          │ credentials (加密)    │
└──────────────┘          └──────────────────────┘

关键关系：
  Agent ─(1:1)─ Inbox: inbox_id 是 Agent 的属性，非独立实体
  Agent ─(1:N)─ Token: 支持多 Token 共存（轮转窗口）
  Agent ─(1:1)─ Presence: 在线状态追踪
  Agent ─(M:N)─ Chat: 通过 chat_participants
  Chat  ─(1:N)─ Message
  Message ─(1:N)─ InboxEntry: fan-out，每个参与者一条
  InboxEntry.chat_id 是路由标签，可能 ≠ message.chat_id（replyTo 场景）
```

### 6.2 表概要

完整 DDL 见 [Server 详细设计 §3](agent-hub-server-detailed-design.20260320.md)。

**平台核心：**

| 表 | 用途 | 关键字段 |
|----|------|---------|
| `agents` | Agent 注册信息 | id, type, inbox_id, status, organization_id |
| `agent_tokens` | Agent 认证 Token（支持多 Token） | agent_id, token_hash, expires_at, revoked_at |
| `agent_presence` | Agent 在线状态 | agent_id, status (online/offline), instance_id |
| `admin_users` | 管理员账户 | username, password_hash, role (super_admin/admin) |
| `system_configs` | 系统配置 | key, value (JSONB) |
| `server_instances` | Server 实例心跳 | instance_id, last_heartbeat |

**消息系统：**

| 表 | 用途 | 关键字段 |
|----|------|---------|
| `chats` | 通信容器 | id, type (direct/group/thread), lifecycle_policy |
| `chat_participants` | Chat 参与者 | chat_id, agent_id, mode (full/mention_only) |
| `messages` | 消息 | id (UUID v7), chat_id, sender_id, format, content, reply_to, in_reply_to |
| `inbox_entries` | 投递队列（信封） | inbox_id, message_id, chat_id (路由标签), status |

**Adapter：**

| 表 | 用途 | 关键字段 |
|----|------|---------|
| `adapter_configs` | Bot 凭证（动态管理） | platform, agent_id, credentials (加密 JSONB) |
| `adapter_chat_mappings` | Chat ↔ 外部 channel 映射 | platform, external_channel_id, chat_id |
| `adapter_agent_mappings` | Agent ↔ 外部身份映射 | platform, external_user_id, agent_id |
| `adapter_message_references` | Message ↔ 外部消息 ID 映射 | message_id, platform, external_message_id |

### 6.3 关键设计要点

- **UUID v7 作为 Message ID** — 时间有序 + 全局唯一
- **organization_id 预留** — 当前默认 `'default'`，为多租户预留
- **InboxEntry.chat_id 是路由标签** — replyTo 时 ≠ message.chat_id
- **消息不可变** — 创建后不修改
- **Agent Token 支持多个共存** — 支持无停机轮转
- **adapter_configs.credentials 加密存储** — 应用层加密，密钥通过环境变量注入

---

## 7. 部署架构

### 7.1 部署场景

```
最小部署（开发 / 个人）：

  $ agent-hub server start --db postgresql://localhost/agenthub
  $ agent-hub client start --agents ./agents.yaml --server http://localhost:8000

  同一台机器，两个进程，走 localhost HTTP。

生产部署（团队 / 分布式）：

  中心节点：
  $ agent-hub server start                        # 可多实例 + 负载均衡

  Agent 节点（可能在不同机器）：
  $ agent-hub client start --server https://hub.example.com
```

### 7.2 Server 多实例

Server 无状态，多实例无需特殊配置：

```
           Load Balancer
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
Instance 1  Instance 2  Instance 3    ← 均无状态
     │          │          │
     └──────────┼──────────┘
           PostgreSQL                  ← 唯一的状态存储
```

- Inbox 并发消费天然支持多实例
- 实时通知通过 PG 内置机制广播到所有实例
- 实例宕机：Client 重连其他实例，消息在 PG 中不丢

### 7.3 网络模型

```
Client/Web → Server（单向连接）

Client 可能在：同一台机器 / 同一 VPC / 公网 / NAT 后
Server 需要：稳定可达的地址（IP / 域名）

传输安全：
  生产环境：HTTPS
  开发环境：允许 HTTP（配置项控制）
  localhost 也必须认证
```

**Adapter webhook：** 外部 IM 平台需要 Server 有公网可达的 HTTP 端点（或通过 ngrok/Cloudflare Tunnel 暴露）。

---

## 8. Monorepo 项目结构

```
agent-hub/
├── pyproject.toml                  # uv workspace 根配置（非 Python 包）
├── README.md
├── .gitignore
│
├── doc/                            # 设计文档
│
├── server/                         # Platform Server
│   ├── pyproject.toml              # 包名: agent-hub-server
│   ├── tests/
│   └── src/
│       └── agent_hub_server/
│
├── client/                         # Agent Runtime
│   ├── pyproject.toml              # 包名: agent-hub-client
│   ├── tests/
│   └── src/
│       └── agent_hub_client/
│
└── web/                            # Web Admin Console
    ├── package.json                # React
    └── src/
```

**包独立性：** Server、Client、Web 互不依赖。各自维护自己的数据模型。

**开发流程：**

```bash
uv sync                                                       # 安装 Python workspace
uv run --package agent-hub-server python -m agent_hub_server   # 启动 server
uv run --package agent-hub-client python -m agent_hub_client   # 启动 client
cd web && npm install && npm run dev                           # 启动 web
```

---

## 9. 技术栈

### 9.1 Server

| 组件 | 选型 | 说明 |
|------|------|------|
| Python 3.11+ | 语言 | 项目统一 |
| FastAPI | Web 框架 | 异步原生、Pydantic 集成、WebSocket |
| PostgreSQL 15+ | 数据库 | **唯一的外部依赖** — 存储 + 队列 + 通知 |
| SQLAlchemy 2.0 async | ORM | CRUD；Inbox 热路径用原生 SQL |
| psycopg3 async | 数据库驱动 | 支持 LISTEN/NOTIFY |
| Alembic | 数据库迁移 | 标准工具 |
| Uvicorn | HTTP 服务器 | ASGI 标配 |
| bcrypt | 密码/Token 哈希 | |
| PyJWT | Admin JWT | |

### 9.2 Client

| 组件 | 选型 | 说明 |
|------|------|------|
| Python 3.11+ | 语言 | |
| httpx | HTTP client | 异步 |
| websockets | WebSocket client | Inbox 通知 |
| Pydantic v2 | 数据模型 | |

### 9.3 Web

| 组件 | 选型 | 说明 |
|------|------|------|
| React | 前端框架 | TBD |

### 9.4 基础设施

```
最小部署：仅 PostgreSQL
生产部署：PostgreSQL（主从）+ 多 Server 实例 + 负载均衡
```

**不需要 Redis、不需要消息队列、不需要额外中间件。**

### 9.5 未来演进

| 触发条件 | 引入 |
|---------|------|
| 需要 <100ms 通知延迟 | Redis Pub/Sub 替代 PG NOTIFY |
| Agent 数量 >100 | NATS JetStream 替代 PG 队列 |
| Chat 历史查询瓶颈 | PostgreSQL 读副本 |

---

## 10. 待确认的设计决策

| 决策 | 现状 | 说明 |
|------|------|------|
| 飞书 Bot 数量限制 | 待确认 | 1:1 模型下需确认组织内自建应用数量上限 |
| Web Console 技术选型 | React（TBD） | 具体框架和组件库待定 |
| OpenClaw 集成 | 待调研 | 考虑如何更简单地与 OpenClaw 集成。OpenClaw 已有飞书 Adapter 实现，评估是否可复用其飞书集成能力（消息收发、事件订阅、卡片渲染等），避免重复开发 |
