---
title: "Agent Hub — 剩余功能清单与实施计划"
status: draft
owners: [baixiaohang]
soft_links:
  - agent-hub-overview.20260320.md
  - agent-hub-server-detailed-design.20260320.md
  - agent-hub-web-design.20260323.md
  - agent-adapter-design.20260323.md
  - agent-hub-context-tree-sync.20260324.md
---

# Agent Hub — 剩余功能清单与实施计划

基于设计文档与当前代码的对比分析，梳理 Server 和 Web 两端尚未完成的功能。不含 Client SDK 和 Slack 对接（后续单独规划）。

---

## 1. Server 剩余功能

### 1.1 Adapter 架构重构（P0）

对应设计文档：[agent-adapter-design.20260323.md](agent-adapter-design.20260323.md)

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| S1 | 移除 adapter agent 自动创建 | 删除 `ensureAdapterAgent()`，Adapter 不再创建 `feishu-adapter-{appId}` agent | 每个 Bot 自动创建一个系统 agent |
| S2 | adapter_configs.agentId 路由生效 | 入站消息时，新会话将 `config.agentId` 指向的 agent 加入 Chat 作为参与者 | agentId 字段存在但未参与路由 |
| S3 | 出站改为消费 human agent inbox | 出站服务通过 `adapter_agent_mappings` JOIN `inbox_entries` 批量消费，替代原 adapter agent inbox | 出站消费 adapter agent 的 inbox |
| S4 | 飞书用户名解析 | 入站时调用 `GET /contact/v3/users/:open_id` 获取真实姓名，写入 agent displayName | 仅用 open_id 前 8 位 |
| S5 | 未知用户策略配置 | 新增系统配置项控制未映射飞书用户的处理策略（auto_create / reject） | 硬编码自动创建 |
| S6 | 出站多 Bot 选择 | 多 Agent 同 Chat 时，按 `msg.senderId` 查 `adapter_configs` 选择对应 Bot 发送 | 固定使用 adapter agent 绑定的唯一 Bot |
| S7 | 出站卡片标注 Agent 身份 | 单 Bot 多 Agent 退化场景下，在卡片 header 中标注发送者 agent displayName | 无标注 |

### 1.2 身份绑定（P1）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| S8 | 手动绑定 Admin API | `POST/DELETE /admin/adapter-mappings` — 管理员手动绑定/解绑飞书用户到 Agent | 无 |
| S9 | 绑定列表查询 API | `GET /admin/adapter-mappings` — 查看所有 adapter_agent_mappings | 无 |
| S10 | adapter_configs.agentId 必填 | 创建 adapter config 时 agentId 改为必填，校验 agent 存在且非 human | agentId 可选 |
| S11 | 唯一约束 | `adapter_configs` 加 `UNIQUE(agent_id, platform)` 约束 | 无约束 |

### 1.3 Admin 管理（P2）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| S12 | Admin 用户 CRUD API | `GET/POST/PATCH/DELETE /admin/users` — 创建、更新、删除管理员 | 仅 CLI init-admin + login/refresh |
| S13 | Adapter 运行状态 API | `GET /admin/adapters/status` — 返回每个 Bot 的 WebSocket 连接状态、最后活跃时间 | 无 |

### 1.4 系统优化（P3）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| S14 | 凭证热加载 NOTIFY | adapter_configs 变更时 PG NOTIFY，所有实例即时重载 Bot 连接 | 后台定时 reload |
| S15 | 系统配置热加载 | system_configs 变更时 PG NOTIFY，刷新内存缓存 | 直接查表，无缓存 |
| S16 | 消息编辑出站 | 支持编辑已发送到飞书的消息（通过 adapter_message_references 查外部 ID） | 未实现 |

---

## 2. Web 剩余功能

### 2.1 Adapter 页增强（P1）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| W1 | Agent 绑定下拉选择 | 创建/编辑 adapter config 时，agent 选择从下拉列表选取，替代手动输入文本 | 手动输入 agentId 文本 |
| W2 | Bot 连接状态展示 | 显示每个 adapter config 的 WebSocket 连接状态（online/offline/error）和最后活跃时间 | 仅 CRUD，无运行状态 |
| W3 | 凭证配置向导 | 创建 adapter config 时提供分步引导（选平台 → 填凭证 → 选 Agent → 测试连接） | 单个 JSON 输入框 |

### 2.2 身份绑定管理页（P1）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| W4 | 绑定列表页 | 新增 `/bindings` 页面，展示所有 adapter_agent_mappings（平台、外部 ID、绑定的 Agent、绑定方式） | 无 |
| W5 | 手动绑定操作 | 管理员可手动创建绑定（选平台 → 输入外部用户 ID → 选择 Agent） | 无 |
| W6 | 解绑操作 | 管理员可解除已有绑定 | 无 |

### 2.3 Admin 用户管理页（P2）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| W7 | 管理员列表页 | 新增 `/admin-users` 页面，展示管理员账户列表 | 无 |
| W8 | 管理员 CRUD | 创建、编辑角色、重置密码、删除管理员 | 无 |

### 2.4 Agent 页增强（P2）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| W9 | Agent 详情增强 | Agent 详情页显示关联的 adapter 绑定（Bot 和用户映射）、参与的 Chat 数量 | 仅基础信息 |
| W10 | Agent 类型筛选 | Agent 列表支持按类型（human/assistant/autonomous）过滤 | 无筛选 |

### 2.5 运维页面（P3）

| # | 功能 | 说明 | 当前状态 |
|---|------|------|---------|
| W11 | Chat 浏览页 | 新增 `/chats` 页面，查看 Chat 列表和消息历史（只读，运维审计用途） | 无 |
| W12 | Agent 详情增强 — 最近消息 | Agent 详情页展示该 Agent 最近的消息记录 | 无 |

---

## 3. 实施计划

### 第一批：Adapter 架构重构

目标：实现新的 Adapter 模型，消除冗余系统 agent，飞书体验闭环。

| 任务 | 对应编号 | 预估改动 |
|------|---------|---------|
| 移除 adapter agent + agentId 路由生效 | S1, S2 | adapter-manager.ts ~100 LOC |
| 出站改为消费 human inbox | S3 | adapter-manager.ts ~80 LOC |
| 飞书用户名解析 | S4 | adapter-manager.ts ~30 LOC |
| 出站多 Bot 选择 | S6 | adapter-manager.ts ~20 LOC |
| adapter_configs.agentId 必填 + 唯一约束 | S10, S11 | schema + migration |
| Web: Agent 绑定下拉选择 | W1 | adapters.tsx ~50 LOC |

### 第二批：身份绑定

目标：管理员可手动管理飞书用户到 Agent 的映射关系。

| 任务 | 对应编号 |
|------|---------|
| 手动绑定 Admin API | S8, S9 |
| 未知用户策略配置 | S5 |
| Web: 绑定管理页 | W4, W5, W6 |
| 出站卡片标注 Agent 身份 | S7 |

### 第三批：管理能力

目标：补全管理后台。

| 任务 | 对应编号 |
|------|---------|
| Admin 用户 CRUD | S12, W7, W8 |
| Adapter 运行状态 | S13, W2 |
| Agent 页增强 | W9, W10 |
| 凭证配置向导 | W3 |

### 第四批：优化与运维

目标：提升运维能力和系统可靠性。

| 任务 | 对应编号 |
|------|---------|
| 热加载优化 | S14, S15 |
| Chat 浏览 + 消息审计 | W11, W12 |
| 消息编辑出站 | S16 |

---

## 4. 范围说明

以下内容**不在本清单范围内**，后续单独规划：

| 内容 | 原因 |
|------|------|
| Client SDK 扩展 | 独立发布周期 |
| Slack adapter | 平台扩展，待飞书稳定后开展 |
| 跨组织通信 | 当前阶段不需要 |

> **注意：** Context Tree 驱动 Agent 同步已有独立设计文档，见 [agent-hub-context-tree-sync.20260324.md](agent-hub-context-tree-sync.20260324.md)，计划在 v0.2 实施。
