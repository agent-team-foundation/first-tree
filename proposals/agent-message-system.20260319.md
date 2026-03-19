---
title: "Agent Message System 需求与方案定义"
status: draft
owners: [baixiaohang]
---

# Agent Message System 需求与方案定义

## 1. 核心问题与方案概述

### 问题

Agent Team 中，Context Tree 通过所有权模型划分了域的边界 — 每个节点有 owner，写入需要 owner 审批。当一个 agent 需要与自己不拥有的域进行交互（审批、输入、决策），它需要触达 owner。现有 IM 平台（飞书、Slack）不支持 agent-to-agent 通信，也没有任务执行上下文的概念。

**一句话总结：Agent 需要跨域协作，但缺少支持 agent 间通信和任务上下文保持的基础设施。**

### 方案

构建一个 Message System，本质上是一个 **IM + 跨 Channel replyTo**。核心由三个概念组成：

- **Channel** — 通信容器（私聊、群聊、讨论串的统一抽象）
- **Message** — 通信单元（格式与语义分离）
- **Inbox** — 每个 agent/human 的消息入口

在标准 IM 的基础上，增加一个关键能力：**跨 Channel 的 replyTo 机制。** 消息的 `reply_to` 字段可以指向另一个 Channel 的 Inbox，使回复被路由到发起方 Agent 的原始对话上下文中。这让 agent 在执行任务时能请求其他 agent 协作，且任务上下文不割裂。

Agent Runtime 侧的 **Session**（任务执行上下文）负责利用这一机制完成跨 Agent 协作，但 Session 不属于 Message System 的概念。

### 与现有方案的区别

**vs 直接用飞书/Slack：** 飞书解决 human-to-human 通信。两个硬伤：bot-to-bot 不通、被平台绑定。此外飞书没有跨 Channel replyTo — 回复只能在同一个会话内。飞书/Slack 不被替代 — 它们是 Human 的界面，通过 Adapter 桥接。

**vs AutoGen/CrewAI 等编排框架：** 这些框架是同步编排 — 一个编排者在一次执行中调度多个 agent。本方案是异步协作 — 多个独立 agent 各自拥有域，通过消息协作，可能等几小时（等人类审批）。区别在于 agent 不是"被编排的 worker"，而是"拥有域的自治参与者"。

### 最小可行概念集

如果短期内不需要群组通信和对 Human 呈现对话历史，可以先只做 **Inbox + Message + Session**。Channel 后续加入。

---

## 2. 关键设计决策

### Q1：为什么不直接用飞书/Slack？

飞书/Slack 解决的是 human-to-human 通信。对 agent-to-agent 有三个硬伤：

1. **Bot-to-bot 不通。** 飞书/Slack 原生不支持 bot 给 bot 发消息。两个 agent 要协作，没有通道。
2. **没有 Session 概念。** 飞书只管投递消息，不管 agent 收到消息后怎么处理、上下文怎么衔接。Agent 收到消息后需要联系另一个 agent 再回来继续 — 飞书不支持这种跨对话编排。
3. **被平台绑定。** 通信逻辑全部建在飞书上，换 Slack 就要重写。

飞书/Slack 不会被替代 — 它们是 Human 的界面。Adapter 层桥接它们。Message System 是 agent 之间的通信骨架，飞书是 human 的前端。

### Q2：为什么需要 Channel？能不能砍掉？

如果只考虑 agent-to-agent 通信，Actor Model 只需要两个概念：Inbox、Message。没有 Channel。

Channel 的存在是因为：
- Human 需要"对话"的概念（在一个聊天窗口里持续交流）
- 群组通信需要一个容器（消息发给谁？发给 Channel 的所有成员）
- 消息历史需要一个归属（这条消息属于哪个对话）

### Q3：跨 Channel replyTo 是什么？怎么实现？

标准 IM 中，回复只能在同一个会话内。本方案增加了跨 Channel 的 replyTo：消息的 `reply_to` 字段可以指向 **(Inbox, Channel)** — 即"把回复投递到这个 Agent 的 Inbox，并标记为属于这个 Channel"。

Agent A 在 Channel_X（与 Human 的对话）中处理任务，需要向 Agent B 请求审批。Agent A 发消息给 Agent B，`reply_to = { inbox: Agent_A, channel: Channel_X }`。Agent B 回复后，回复被投递到 Agent A 的 Inbox 并标记为 Channel_X 的消息 — Agent Runtime 将其路由到 Channel_X 对应的 Session，任务上下文不割裂。

实现上没有新协议 — Message 多一个字段，投递时多一条路由规则。Message System 全程只处理自己认识的概念（Inbox 和 Channel），不需要知道 Session 的存在。

### Q4：为什么 Session 要持久化，而不是每轮销毁？

如果每轮销毁 Session，下一轮只剩 thread 历史（user/assistant 消息），没有中间过程中的 tool calls 和 tool results。

**三个理由：**

1. **避免重复 tool calls。** Agent 上一轮读了 5 个文件、做了 3 次搜索。销毁后下一轮得重做，浪费 token 和时间。
2. **保留 prompt cache。** 持久 Session 的上下文前缀稳定（每轮只在尾部追加），prompt cache 命中率高。重建上下文会导致 cache 失效，每轮全量计费。
3. **空转成本可忽略。** 暂停中的 Session 只是内存中的数据结构，没有 GPU 推理。基本免费。

### Q5：消息格式为什么不绑定使用场景？

Message System 定义格式（text、markdown、card 等），不定义语义（审批、任务、查询等）。

原因：使用场景会扩展。如果消息类型和场景绑定，每加一个场景就要改协议。一张 card 可以是审批、通知、问卷 — 格式相同，含义不同。语义由发送方和接收方在应用层协商，系统只透传一个开放的 `metadata` 字段。

飞书的实践验证了这一设计 — `msg_type` 是纯格式概念，语义由开发者在 `value` 字段中自定义。

### Q6：和 multi-agent 编排框架（AutoGen、CrewAI）的区别？

核心区别在于 **ownership 和异步性**。

AutoGen/CrewAI 的模型：一个编排者在一次执行中同步调度多个 agent。编排者控制流程，agent 被调用、返回结果。单进程、同步。

本方案的模型：多个独立 agent 各自拥有域，通过异步消息协作。没有中心编排者。Agent A 发消息给 Agent B，Agent B 可能立即回复，也可能几小时后回复（等人类审批）。

Agent Team 中的 agent 不是"被编排的 worker"，而是"拥有域的自治参与者"。这决定了需要一个消息系统，而不是函数调用。

---

## 3. 核心模型

### 3.1 概念关系

Message System 有三个核心概念：**Channel、Message、Inbox**。Agent Runtime 侧的 **Session** 依赖 Message System 但不属于它。

```
                    Message System
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  ┌─────────┐  参与(M:N)  ┌───────────┐ 包含(1:N) ┌─────────┐  │
│  │  Agent  │◄───────────►│  Channel  │─────────►│ Message │  │
│  └────┬────┘             └─────┬─────┘          └─────────┘  │
│       │                        │                             │
│       │ 拥有(1:1)              │ 投递新消息到                 │
│       ▼                        │ 所有参与者的 Inbox           │
│  ┌─────────┐                   │                             │
│  │  Inbox  │◄──────────────────┘                             │
│  └────┬────┘                                                 │
│       │                                                      │
└───────┼──────────────────────────────────────────────────────┘
        │ 边界
        │                    Agent Runtime
┌───────┼──────────────────────────────────────────────────────┐
│       │ 消费 + 路由                                           │
│       ▼                                                      │
│  ┌──────────┐                                                │
│  │ Session  │  (Agent + Channel) = 1 Session                 │
│  └──────────┘                                                │
└──────────────────────────────────────────────────────────────┘
```

- **Channel** — 通信容器（私聊、群聊、讨论串的统一抽象），包含消息历史
- **Message** — 通信基本单元，格式与语义分离
- **Inbox** — Agent 的消息入口，汇聚所有 Channel 的消息
- **Session**（Agent Runtime）— Agent 的任务执行上下文。(Agent + Channel) 唯一对应一个 Session。Agent Runtime 从 Inbox 消费消息并路由到 Session

### 3.2 消息流转

以一条跨 Agent 协作的完整链路为例：

```
Human 在飞书说："更新 /backend/api.md 的文档"

  ①  飞书 Adapter 转为 Message → 投递到 Channel_X (Human↔Agent A)
  ②  Channel_X 新消息 → 投递到 Agent A 的 Inbox
  ③  Inbox：Channel_X 无活跃 Session → 创建 Session #1
  ④  Session #1 处理：
      ├── 加载 Context Tree → 发现 owner 是 Agent B
      ├── 向 Agent B 发送审批请求，携带 replyTo = (Agent_A_Inbox, Channel_X)
      └── 回复 Human："已发起审批，等待回复"

  ⑤  Agent B Inbox 收到 → 创建 Session #2 → 审批 → 回复 "Approved"
  ⑥  回复通过 replyTo 投递到 Agent A 的 Inbox，标记为 Channel_X
      → Agent Runtime 路由到 Channel_X 的 Session #1
  ⑦  Session #1 继续处理 → 更新文档 → 回复 Human："已完成"
  ⑧  Session #1 暂停（paused），保留完整上下文

Human 接着说："那个返回格式也改一下"

  ⑨  Inbox：Channel_X 有活跃 Session #1 → 路由到 Session #1
  ⑩  Session #1 有完整上下文，理解"那个"→ 继续处理
```

**关键点：**

- **步骤 ⑥** replyTo = (Inbox, Channel) 让回复路由到发起方的原始 Channel 上下文，任务不割裂
- **步骤 ⑨** 体现 Session 持久化的价值 — 同一 Session 跨轮次保持上下文，对话连续

### 3.3 两种通信模式

上述流转中包含了两种通信模式：

**对话式（Conversational）：** Human 和 Agent A 在 Channel 中的持续交互（步骤 ①-④、⑧-⑩）。消息通过 Channel → Inbox → Session 路由。Session 持久存活，提供对话连续性。

**事务式（Request-Response）：** Session #1 向 Agent B 发请求（步骤 ④-⑥）。借鉴 Actor Model 的 Ask 模式 — 发送时携带 `replyTo = (Inbox, Channel)`，回复被路由到发起方 Agent 的原始 Channel 上下文。用于 agent 执行任务过程中需要其他 agent 协作的场景。

两者统一建立在 Channel + Message 基础之上。区别在于回复的路由方式：对话式走正常 Channel 投递，事务式通过 replyTo 跨 Channel 路由。Message System 在两种模式中只处理自己认识的概念（Channel、Message、Inbox）。

### 3.4 Session 生命周期

```
Channel 中新消息到达 Inbox
          │
          ▼
  该 Channel 有活跃 Session？
    ├── 是 → 路由到该 Session（唤醒，继续处理）
    └── 否 → 创建新 Session
                │
                ▼
          Session 处理消息
          (LLM 推理、tool calls、跨 Agent replyTo 请求...)
                │
                ▼
          回复发出 → Session 暂停（paused）
          [完整上下文保留在内存中]
                │
          下一条消息到达 → 唤醒，继续
                │
          长时间无活动 → 序列化到持久存储（释放内存）
                │
          再次收到消息 → 反序列化，恢复完整上下文
```

Session 不主动销毁。闲置 Session 序列化到磁盘，存储成本可忽略。长期不活跃后恢复时，可对旧上下文做摘要压缩（compaction），再加载最新的 Context Tree 信息。

---

## 4. 系统设计

### 4.1 系统架构

Message System 和 Agent Runtime 是两个独立的系统，通过 Inbox 解耦：

```
┌────────────────────────────────────────────────────────────┐
│                        外部平台层                            │
│   飞书  │  Slack  │  Discord  │  GitHub                     │
│         └────┬────┘           │                             │
│              ▼                ▼                              │
│       ┌────────────────────────────┐                        │
│       │      Adapter Layer         │                        │
│       │   (平台消息 ↔ Channel)     │                        │
│       └─────────────┬──────────────┘                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
┌─────────────────────┼──────────────────────────────────────┐
│          Message System                                     │
│                     ▼                                       │
│          ┌──────────────────┐     ┌──────────────────────┐ │
│          │    Channels      │     │   Channel History     │ │
│          │  (通信容器管理)   │     │   (消息存储与查询)    │ │
│          └────────┬─────────┘     └──────────────────────┘ │
│                   │ 投递(push)                               │
│                   ▼                                         │
│          ┌──────────────────┐                               │
│          │  Agent Inboxes   │◄── 消息写入端                  │
│          └────────┬─────────┘                               │
└───────────────────┼─────────────────────────────────────────┘
                    │ 边界：Inbox
┌───────────────────┼─────────────────────────────────────────┐
│          Agent Runtime                                      │
│                   ▼                                         │
│          ┌──────────────────┐    ◄── 消息读取端              │
│          │  Inbox 消费与路由 │                               │
│          │  (去重、分发)     │                               │
│          └────────┬─────────┘                               │
│                   ▼                                         │
│          ┌──────────────────┐    ┌────────────────────────┐ │
│          │    Sessions      │───►│    Context Tree        │ │
│          │  (LLM 推理、     │    │  (加载上下文/写回结果)  │ │
│          │   tool calls)    │    └────────────────────────┘ │
│          └──────────────────┘                               │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 与外部平台的集成

Human 使用飞书、Slack、Discord 等现有平台。Adapter Layer 负责双向桥接：

- **入站：** 飞书 DM 消息 → 转为 Channel 中的 Message；Slack channel 消息 → 转为对应 Channel 中的 Message
- **出站：** Agent 在 Channel 中的回复 → 转为飞书 DM 消息；通知 → 转为 Slack 消息或 GitHub comment

一个外部平台的 DM/channel 对应 Message System 中的一个 Channel。从 Human 的角度，他们在飞书里和 Agent 聊天（IM 体验）。从系统角度，这是 Channel 中的消息流。

---

## 5. 能力边界与外部依赖

### 5.1 Message System 的职责范围

**Message System 负责：**

| 职责 | 说明 |
|------|------|
| Channel 管理 | 创建、配置、添加/移除参与者 |
| Message 投递（push） | 发送消息 → 送达所有参与者的 Inbox |
| Message 存储与查询（pull） | 持久化 Channel 消息历史，提供查询 API |
| Adapter 集成 | 桥接外部平台（飞书、Slack、Discord、GitHub） |

**Message System 不负责：**

| 不在范围内 | 由谁负责 |
|-----------|---------|
| Agent 生命周期（启动、停止、部署） | Agent Runtime |
| Session 管理（创建、路由、暂停、恢复） | Agent Runtime |
| 消息处理（LLM 推理、tool calls） | Agent Runtime |
| Context Tree 操作（加载上下文、写回结果） | Agent Runtime / Context Tree |
| Workflow 执行 | Workflow System |

**边界：** Message System 负责把消息写入 Inbox。Agent Runtime 负责从 Inbox 读取并处理。Inbox 是两个系统之间的接口。

### 5.2 对 Agent Runtime 的关键依赖

Message System 能正常工作，需要 Agent Runtime 提供以下能力。这些不是 Message System 的设计，但是系统整体运转的前提。

**Inbox 消费与 Session 路由**

Agent Runtime 从 Inbox 读取消息后，需要判断路由到哪个 Session。路由依据是消息关联的 Channel（正常投递）或 replyTo 中指定的 Channel（跨 Channel 回复）：
- 该 Channel 是否已有活跃 Session → 路由到现有 Session
- 该 Channel 无活跃 Session → 创建新 Session

由于 (Agent + Channel) 唯一确定一个 Session，路由逻辑简单明确。

推荐设计：Inbox 消费作为 Agent Runtime 的常驻轻量进程，保证"always online"的消息接收能力。

**Session 管理与持久化**

Agent Runtime 负责 Session 的完整生命周期：创建、运行、暂停、序列化、反序列化、上下文压缩（compaction）。

推荐设计：
- Session 在轮次之间保持存活（paused），保留完整 LLM 上下文（含 tool calls/results），利于 prompt cache
- 长时间无活动后序列化到持久存储，新消息到达时反序列化恢复
- Session 不主动销毁，上下文过大时做 compaction 而非丢弃

**消息去重（幂等）**

Message System 保证 at-least-once 投递（ACK-RETRY 机制）。Agent Runtime 需要在 Inbox 消费层基于 Message ID 去重，实现有效的 exactly-once 语义。

推荐设计：Inbox 维护已处理 Message ID 的集合，重复消息直接丢弃。

**Channel 历史拉取**

群组场景中，agent 可能不实时处理每条消息（节省 token），但被 @mention 时需要获取对话上下文。此时 Agent Runtime 需要调用 Message System 的 Channel History API 拉取近期消息。

推荐设计：Agent Runtime 提供两种群组参与模式供配置：
- **@mention 模式：** 仅在被 @ 时创建 Session，Session 启动时通过 pull 拉取 Channel 历史作为上下文
- **全量模式：** 每条消息都推送到 Inbox，由 Agent Runtime 决定是否处理

### 5.3 与 Context Tree 的关系

Message System 和 Context Tree **没有直接耦合**。

Session 加载 Context Tree 上下文、写回处理结果 — 这些都是 Agent Runtime（Session）与 Context Tree 之间的交互，不经过 Message System。

唯一的间接关联：写回 Context Tree 需要 owner 审批，而审批请求通过 Message System 传递。但这是 Agent Runtime 发起的消息行为，不是 Message System 主动与 Context Tree 交互。

### 5.4 与 Workflow 的关系

Message System 和 Workflow 是组合关系，互不包含：

- **Workflow → Message System：** Workflow 执行完一个步骤后，可通过 Message System 发送通知或触发下一个 agent 的任务
- **Message System → Workflow：** Agent 处理消息后（如审批通过），可调用 Workflow 触发后续自动化流程（如部署）

Message System 提供消息投递能力，Workflow 是调用方。

---

## 6. 使用场景

以下场景验证核心模型的覆盖能力。

### 6.1 跨域审批

Agent A 需要修改 `/backend/auth.md`，owner 是 Agent B。Agent A 的 Session 向 Agent B 发送审批请求，`replyTo = (Agent_A_Inbox, Channel_X)`。Agent B 审批后，回复通过 replyTo 路由到 Agent A 的 Channel_X 上下文，Session 继续执行。

**覆盖要素：** Session 跨 Channel 操作、replyTo 机制。

### 6.2 任务委派

Human 在飞书对 Agent 说"更新 API 文档"。Adapter 转为 Message → Channel → Inbox → Session 处理。

**覆盖要素：** 外部平台集成（Adapter）、Channel 作为通信容器、Session 创建与执行。

### 6.3 决策升级

Agent 遇到无法判断的问题，在 Channel 中向 Human 呈现选项。Human 回复选择。同一个 Session 接收回复，继续处理。

**覆盖要素：** Session 持久化（对话连续性）、结构化消息（card 格式呈现选项）。

### 6.4 信息查询

Agent A 向 `/backend/` 的 owner 发消息询问 API 约定。Owner 回复。Agent A 将信息写回 Context Tree。

**覆盖要素：** 事务式通信（replyTo）、Agent Runtime 处理结果写回 Context Tree。

### 6.5 群组协作

多个 agent + human 在同一 Channel 讨论。配置为 @mention 模式的 agent 被 @ 时拉取 Channel 历史再处理；配置为全量模式的 agent 对每条消息做轻量判断后决定是否响应。

**覆盖要素：** Channel 作为群组容器、Channel History API（pull）、两种群组参与模式。

### 6.6 事件驱动通知

PR 合并 → Workflow 触发 → 通过 Message System 发送通知到相关 Channel → 对应 agent 的 Inbox 接收处理。

**覆盖要素：** Workflow 作为 Message System 的调用方。

---

## 7. 待讨论的开放问题

### 7.1 Metadata 通用字段约定

`metadata` 是开放的，但完全自由可能导致碎片化。可沉淀推荐（非强制）的通用字段：`intent`（意图）、`related_nodes`（关联节点）、`urgency`（紧急度）、`requires_response`（是否期望回复）。应在实践中逐步沉淀。

### 7.2 Adapter 集成方案

建议每平台一个 Adapter（飞书卡片 vs Slack Block Kit 差异大），共享统一的内部 Message 格式。

---

## 附录 A：用户类型与需求矩阵

### A.1 三种用户类型

**Human（人类成员）：** 设定方向、做判断决策、授予权限。不是常驻在线，使用现有平台（飞书/Slack），是最终权威。

**Personal Agent Assistant（个人代理 agent）：** 代表特定 human 行事。持有委托权限，是 human 的消息代理 — 在权限范围内代处理、超出权限时转发给 human。

**Autonomous Agent（自治 agent）：** 独立拥有域、持续运行、对团队负责。Always online，有 Inbox，可 spawn 实例处理消息，拥有 Context Tree 节点。

### A.2 需求矩阵

| 场景 | Human | Personal Assistant | Autonomous Agent |
|------|-------|--------------------|------------------|
| 跨域审批 | 接收审批请求，批准/拒绝 | 代 human 预审或转发 | 发起请求 / 作为 owner 审批 |
| 任务委派 | 在现有平台上发起 | 接收并转派 | 接收任务，spawn 执行 |
| 决策升级 | 做最终判断 | 过滤/汇总后呈现 | 发起升级 |
| 信息查询 | 回答 agent 的问题 | 代答简单问题 | 发起查询 / 回答查询 |
| 群组协作 | 在群里正常聊天 | 代 human 参与 | 自主判断是否回应 |
| 事件通知 | 在现有平台收到通知 | 过滤噪音，只转发重要的 | 收到事件后自动处理 |

---

## 附录 B：业界实践对比

### B.1 飞书

格式优先的消息模型。`msg_type` 定义内容格式（text、post、interactive 等），没有语义字段。语义通过卡片的 `value` 字段由开发者自定义。**启示：** 格式与语义分离。

### B.2 Discord

Guild → Category → Channel → Thread → Message。Thread 在 API 中复用 Channel 数据模型。DM 也是 Channel。Bot-to-bot 技术上可行但非原生支持。**启示：** Thread = 轻量 Channel 的统一模型。

### B.3 Matrix

万物皆 Room。1:1 和群聊在协议层完全相同。所有数据是 Event。去中心化联邦，Application Service 可桥接外部平台。**启示：** 统一通信容器抽象，Bridge/Adapter 模式。

### B.4 Actor Model (Erlang/Akka)

Actor 是计算基本单元，每个 Actor 有 Mailbox。Per-Session Child Actor 模式：收到复杂请求时 spawn 子 Actor 处理多步交互。Ask 模式：发送时携带 replyTo，回复直接返回发起方。**启示：** Inbox + Per-Session Child + replyTo 的执行模型。

### B.5 综合对比

| 维度 | 飞书 | Discord | Matrix | Actor Model | 本方案 |
|------|------|---------|--------|-------------|--------|
| 基本通信单元 | 消息 | 消息 | Event | 消息 | Message |
| 通信容器 | 会话 | Channel | Room | Mailbox | Channel + Inbox |
| 1:1 vs 群组 | 不同类型 | 不同 type | 统一 | N/A | 统一（Channel） |
| Thread | 回复引用 | 轻量 Channel | Event 关系 | N/A | 子 Channel |
| 消息语义 | 开发者定义 | 开发者定义 | Event type | 自由定义 | 应用层定义（metadata） |
| 执行模型 | N/A | Bot handler | N/A | Actor + Mailbox | Session + Inbox |
| 跨域协作 | N/A | 无原生支持 | Room 互通 | Ask 模式 | replyTo 机制 |
| 外部集成 | 开放 API | Webhook | Bridge/AS | N/A | Adapter Layer |

---

## 附录 C：类型定义

### C.1 Message

```
Message = {
  id:         string    唯一标识
  channel_id: string    所属 Channel
  sender:     string    发送者身份
  format:     string    内容格式（text / markdown / card / reference / file）
  content:    object    消息内容（结构取决于 format）
  metadata:   object    可选的开放键值对（发送方自定义，系统透传）
  reply_to: {           可选，跨 Channel 回复路由
    inbox:    string    目标 Agent 的 Inbox ID
    channel:  string    目标 Channel ID（用于 Agent Runtime 路由到正确 Session）
  }
  timestamp:  datetime  发送时间
}
```

### C.2 Channel

```
Channel = {
  id:             string    唯一标识
  participants:   string[]  参与者列表（agent 和/或 human 的 ID）
  metadata: {
    topic:            string?   主题描述
    related_nodes:    string[]  关联的 Context Tree 节点路径
    lifecycle_policy: string    生命周期策略（persistent / task-scoped / auto-archive）
    parent_channel:   string?   父 Channel ID（如果是 thread/子讨论）
  }
}
```

| Channel 类型 | 参与者 | 生命周期 |
|-------------|--------|----------|
| Human 和 Agent 的日常对话 | 2 人 | persistent |
| 群组讨论 | N 人 | persistent |
| Agent 间的任务请求 | 2 个 agent | task-scoped |
| 某话题的深入讨论 | N 人 | auto-archive（从父 Channel 创建） |

### C.3 Session（Agent Runtime 概念）

Session 不属于 Message System，但作为关键的配套概念列出供参考。

```
Session = {
  agent:            string    所属 Agent ID
  channel:          string    关联的 Channel ID（(Agent + Channel) 唯一确定一个 Session）
  state:            object    完整 LLM 上下文（消息 + tool calls + tool results + 推理）
  status:           string    active / paused / serialized
}
```
