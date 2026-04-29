# Workspace 首条消息触发 Session 创建(M 方案技术方案)

> 状态:**已决策 · 实施待启动** — N 系列决策已锁定,见 §7。
> 作者:Claude Code 协助起草,YueZengwu 决策
> 文档前身:`list-agent-chats-refactor.md`(B2 方案,已被否决,见 §10)

---

## 1. 背景与方向演化

### 1.1 原始 bug

Workspace 页面点击 "New chat" 后,新 chat 不会立即出现在左侧列表中。直接根因:

- `POST /admin/agents/:uuid/chats` 立即在 `chats` 表写入了一行
- 但左侧列表数据源 `listAgentSessions` 以 `agent_chat_sessions` 为主表 INNER JOIN `chats`,**没有 session 行的 chat 不可见**
- `agent_chat_sessions` 行原本只在 client 处理首条消息后由 client 上报 `session:state → active` 触发 server upsert

### 1.2 经过的方案演化

| 阶段 | 方案 | 结论 |
|---|---|---|
| 第一版定位 | 怀疑前端没立即创建数据 | 错误。chat 数据立即创建了,只是列表数据源是 sessions |
| B2 提议 | 新建 `listAgentChats`,列表语义切到 chat 维度 | 被否决 — workspace 的 chat 生命周期管理(suspend/terminate)都是 session 维度,列表也应保持 session 维度 |
| C1 提议 | server 在 createChat 时写 pending session | 被否决 — 用户可能建 chat 后不发消息,会出现死气 sessions;且引入 pending 状态破坏三态约定 |
| **M 方案(本文)** | 用户发首条消息时,server 在 sendMessage 内部 upsert active session | **采纳** |

### 1.3 最终方向

**列表语义不变**(继续是 session 维度),改 session 创建时机:从 "client 处理消息后上报" 提前到 **"用户首条消息发送时由 server 主动 upsert"**。

修复时点描述:用户在新 chat 里发出首条消息后,**列表立刻出现新行**(state=active),不再等 10 秒轮询 + client 处理 + client 上报这条链路。

---

## 2. 核心方案

### 2.1 写入时机与主体

- **时机**:用户发送消息(`POST /admin/chats/:chatId/messages`)的 server 处理过程中,在 message + inbox 写入完成后
- **主体**:server,具体在 `services/message.ts:sendMessage` 内部
- **复用**:已有的 `services/activity.ts:upsertSessionState`,逻辑零新增

### 2.2 为什么改动面如此小

三个事实让 M 方案退化为 "在一个 service 函数里加一行调用":

| 事实 | 文件 | 影响 |
|---|---|---|
| `agent_chat_sessions` schema 只有 (agent_id, chat_id, state, updated_at)——**无 client_id 字段** | [agent-chat-sessions.ts](packages/server/src/db/schema/agent-chat-sessions.ts) | server 主动写入完全不破坏 R-RUN 客户端绑定 |
| `upsertSessionState` 已存在,完整完成 upsert + 重算 presence + NOTIFY | [activity.ts:23](packages/server/src/services/activity.ts:23) | 无需新写入函数,直接 import 调用 |
| 注释明确支持 "evicted → active 覆盖":**"agent_chat_sessions 是当前状态缓存,不是历史日志"** | [activity.ts:11-22](packages/server/src/services/activity.ts:11) | terminate 后再次发消息复活 session,数据层天然支持 |

### 2.3 改动概览

| 层 | 改动 |
|---|---|
| Server `services/message.ts` | sendMessage 内部对 recipients 调用 upsertSessionState(state='active') |
| Server 测试 | 新增对 "首条消息触发 active session" / "evicted → active 复活" 的覆盖 |
| Web `roster/index.tsx` | newChatMut.onSuccess **移除**对 agentSessionsQueryKey 的 invalidate(此时 session 还不存在) |
| Web `chat-view.tsx` | sendMut.onSuccess **新增** invalidate agentSessionsQueryKey |

仅此 4 处。

---

## 3. 数据模型梳理

### 3.1 涉及的表(均无 schema 变更)

| 表 | 角色 | 本次方案对它的写入 |
|---|---|---|
| `agent_chat_sessions` | 写入主对象 | upsert (recipient_agent_id, chat_id, 'active') |
| `agent_presence` | 由 upsertSessionState 自动重算 activeSessions / totalSessions | 间接写入(已有逻辑) |
| `messages` | 消息体 | 不变 |
| `inbox_entries` | 投递队列 | 不变 |
| `chats` | chat 本体 | 不变 |
| `chat_participants` | recipient 计算依据 | 仅读 |

**结论**:无 schema 变更、无迁移、无新外键。

### 3.2 数据流向(在现有流程上叠加一步,事务边界明确)

`POST /admin/chats/:chatId/messages` 流程:

1. 解析 body(sendMessageSchema)
2. 调用 `sendMessage(db, chatId, senderAgentId, body, opts)`
3. **[事务开始]** 服务内部 `db.transaction(...)`:INSERT messages → query participants + chatType → fan-out 计算 entries(每条带 `notify` 标志) → INSERT inbox_entries → UPDATE chats.updatedAt → **新增**:收集 `recipientAgentIds = entries.filter(e => e.notify).map(p => p.agentId)` 和 `organizationId`(从 sender query) → **[事务结束,返回结果对象]**
4. **★ 新增(事务外,在 sendMessageInner 函数体内):** `Promise.allSettled` 并发调用 `upsertSessionState(db, agentId, chatId, 'active', organizationId, undefined)`,每个调用 try/catch 包裹,失败 log 但不抛(N4-B)
5. 路由层 `notifier.notifyRecipients(recipients, messageId)` 发 PG NOTIFY,不变

**关键事务边界**:upsertSessionState **必须在主事务外**调用,否则 N4-B(失败不阻塞消息)无法兑现——事务内任何 throw 会回滚整个 messages + inbox_entries 写入。upsertSessionState 内部自带独立事务([activity.ts:33](packages/server/src/services/activity.ts:33)),与主事务完全隔离。

### 3.3 一致性边界

- **upsertSessionState 是幂等的**:state 已为 active 时再写一次只刷新 updatedAt
- **client 后续上报会再 upsert 一次**:数据上等于无操作,无 race
- **terminate 后新消息复活**:state 从 evicted 直接覆写为 active,符合 [activity.ts:11-22](packages/server/src/services/activity.ts:11) 的设计意图

---

## 4. 系统架构梳理

### 4.1 列表数据源 — 完全不变

`listAgentSessions` ([session.ts:42](packages/server/src/services/session.ts:42))、`agentSessionsQueryKey`、roster / workspace / palette / chat-view / session-context 所有 caller — **零改动**。

### 4.2 客户端 Runtime — 完全不变

SessionManager / SessionRegistry / AgentSlot 的本地状态、内存模型、上报机制 — **零改动**。client 仍然在收到 inbox NOTIFY 后创建内存 session、调 handler.start、上报 `session:state: active`。它不知道 server 已经写了一行,也不需要知道。

### 4.3 server 与 client 的状态收敛时间线

| 时刻 | server agent_chat_sessions | client SessionManager 内存 | agent_presence.runtimeState |
|---|---|---|---|
| T0:用户 POST messages | (empty) | (无) | idle |
| T1:server 写 messages + upsert active | state=active, updatedAt=T1 | (无) | idle ← **关键:仍是 idle** |
| T2:client 收 inbox NOTIFY,启动 handler | state=active, updatedAt=T1 | session created | (即将变 working) |
| T3:client 上报 runtime:state=working | state=active, updatedAt=T1 | running | working |
| T4:client 上报 session:state=active(幂等) | state=active, updatedAt=T4 | running | working |

**关键观察**:T1 → T3 区间,`state=active` 但 `runtimeState=idle`。UI 上这个组合可以解读为 **"会话已建立,agent 即将开始处理"**——这正是我们想要的状态。如果 client 启动失败,长期停在这个组合,UI 仍能识别异常。

---

## 5. 与现有架构不变量的对照

| # | 不变量 | M 方案的影响 | 说明 |
|---|---|---|---|
| 1 | Stateless server | **轻微破坏** | server 主动写 state,但仅在 "用户已发消息" 这一高置信度信号触发时,且写入内容是预测 client 即将上报的相同状态 |
| 2 | 故障语义清晰 | 保持 | runtimeState 不被自动写;server 预测写入显式传 `touchPresenceLastSeen: false`(见 §9 Step 0),`agent_presence.lastSeenAt` 也不被污染。client 起不来时 UI 可识别 "session 存在但 agent 没工作" |
| 3 | 多 client / failover 解耦 | **完全保持** | session 表无 client_id,本次写入不绑定任何 client |
| 4 | Inbox 投递路径同构 | 保持 | inbox 路径不变 |
| 5 | session_events seq 单调由 client 单写入 | 保持 | events 仍由 client 单写入,server 只写 sessions 表 |
| 6 | 运行时配额由 client 自行调度 | 保持 | client 不感知 server-written session,自己按 inbox 调度 |

**只破坏第 1 条**,且为窄面积、可控的预测性写入。代价远小于 B2(语义改造 / 6 caller 切换)和 C1(引入 pending 四态 / TTL 兜底)。

---

## 6. UX 链路

| 步骤 | 用户视角 | 数据层动作 |
|---|---|---|
| 1 | 点击 New chat | server 写 chats 行;URL 跳到 newChatId;chat-view 渲染空白 |
| 2 | **左侧列表此刻不更新** | 故意行为:列表只反映 "被实际使用的对话" |
| 3 | 输入并发送消息 | server 写 messages + upsert active session + NOTIFY |
| 4 | **左侧列表立刻出现新行**(state=active) | 前端 sendMut.onSuccess invalidate agentSessionsQueryKey |
| 5 | dot 视觉呈现 active | 数据层已是 active |
| 6 | client 启动后开始处理消息 | runtimeState idle → working,但 state 已经是 active(幂等) |

**没发消息就关闭页面**:chats 表里有这一行,但永远不出现在 sessions 列表 — 与 D3-A 隐藏 evicted 是同一种逻辑(底层数据存在但 UI 不显示)。处理方式见 §8 R1。

---

## 7. 决策点(已锁定)

### N1. fan-out 范围 — ✅ 已决策:N1-B

`sendMessage` 一条消息可能投给多个 recipient(group chat)。对哪些 recipient 调用 upsertSessionState?

| 选项 | 范围 | 说明 |
|---|---|---|
| N1-A | 仅 1:1 chat 的对方 | 只覆盖 direct chat;group 行为不变,仍依赖 client 上报 |
| **N1-B ✅** | 所有非 sender 的 participants(包括 group) | 与 inbox fan-out 语义一致;group 里每个 agent 都被 cue 进会话 |
| N1-C | 所有 inbox recipients(含 silent context) | silent 本意是 "不唤醒",写成 active session 矛盾 |

**决策**:N1-B。fan-out 范围与 inbox 一致;group chat 中每个 participant 都获得 active session 是预期语义(参见 §8 R5)。

**精确实施定义**:N1-B 范围 = `sendMessage` 内部 fan-out 计算后 `entries.filter(e => e.notify)` 对应的 agentIds,即 inbox `notify=true` 的 participants。这与 mention_only 模式的 silent context 行为天然契合:被 silently 写入 inbox 的 participants(`notify=false`,例如未被 @mention 的 mention_only 模式 participant)**不会**被 upsert 为 active session,正好符合 N1-C 的否决理由(silent 本意是 "不唤醒")。代码定位:[message.ts:201-208](packages/server/src/services/message.ts:201)。

### N2. terminate 后复活的语义 — ✅ 已决策:N2-A

[activity.ts:11-22](packages/server/src/services/activity.ts:11) 的注释明确支持 evicted → active 覆盖。这意味着:

- 用户 terminate 一个 session(state=evicted,从列表消失)
- 之后任何人在同一 chat 发消息,session 自动复活,列表里重新出现这条 chat,state=active

这其实就兑现了现有 Dialog 文案 "a new message will start a fresh session"。

| 选项 | 行为 | 说明 |
|---|---|---|
| **N2-A ✅** | 接受复活 | 与现有注释和 Dialog 文案一致,数据层零特殊处理 |
| N2-B | 不允许复活 | 需要给 evicted 加 "终结防御",与现有架构注释直接冲突,且会让 Dialog 文案误导 |

**决策**:N2-A。upsertSessionState 直接执行 evicted → active 覆盖,无任何特殊分支。

### N3. 前端 invalidate 失败的兜底 — ✅ 已决策:N3-A

如果 `sendMut.onSuccess` 的 invalidate 因网络抖动失败,列表还是不更新。

| 选项 | 行为 | 说明 |
|---|---|---|
| **N3-A ✅** | 不做 | sessions 列表本来就有 10s 轮询兜底,极端罕见的失败场景接受兜底延迟 |
| N3-B | 短间隔重试(2s × 3) | 多余的复杂度,且不解决任何已知用户痛点 |

**决策**:N3-A。直接调一次 `queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) })`,不加重试。

### N4. upsertSessionState 失败的事务边界 — ✅ 已决策:N4-B

server 在 sendMessage 内部调用 upsertSessionState 时,如果它失败,sendMessage 是否回滚整个消息发送?

| 选项 | 行为 | 说明 |
|---|---|---|
| N4-A | 同事务,失败回滚 | 语义最干净,但 sendMessage 失败概率会增加 |
| **N4-B ✅** | 异步 best-effort,失败 log 但不阻塞消息发送 | 消息可达性优先;client 后续会主动上报 active,自愈 |

**决策**:N4-B。每个 upsertSessionState 调用单独 try/catch 包裹,失败时记录 error log 但不抛出。多个 recipient 用 `Promise.allSettled` 并发执行,任何一个失败不影响其他。理由:消息已经写入 + inbox 已 fan-out + NOTIFY 已发后,client 一定会被唤醒处理这条消息,处理完会上报 `session:state: active`,所以 upsertSessionState 失败是 **可自愈的**。

---

## 8. 风险点

### R1. 用户点 New chat 后未发消息的 "僵尸 chat"

`chats` 表里有这一行,但永远不出现在 sessions 列表。如果用户经常这么做,chats 表会有数据堆积。

**缓解**:超出本次范围。可后续加定期清理任务(例如:删除 N 天内 message_count = 0 的 direct chat)。

**风险等级**:低。chats 表的存储成本远小于 messages。

### R2. server 上报 active 与 client 上报 active 的并发

server 在 T1 upsert active,client 在 T4(数秒后)再 upsert active。两次写入都是 `state=active`,onConflictDoUpdate 等于幂等覆盖,只是 updatedAt 刷新两次。

**风险等级**:无。upsert 设计天然处理。

### R3. terminate 与新消息复活的并发

极端 case:用户 A 在 T0 调 terminateSession(写 evicted);用户 B 在 T0 同时发消息(写 active)。最终状态取决于 SQL 提交顺序。

**缓解**:
- onConflictDoUpdate 是行级原子,不会写出非法中间态
- 后写者获胜,符合用户直觉(最新动作的状态)
- 但 [admin-sessions-suspend-terminate.test.ts](packages/server/src/__tests__/admin-sessions-suspend-terminate.test.ts) 现有的 race 测试需要补充覆盖 "terminate vs upsert active" 的并发

**风险等级**:低-中。已有 race 测试基础设施可扩展。

### R4. fan-out 写入失败的事务边界

见 N4 决策。倾向 N4-B(异步 best-effort)后,upsertSessionState 失败不阻塞消息。失败时记录 error log,client 上报会兜底。

**风险等级**:低。

### R5. group chat 的 active 数膨胀 + N+1 事务开销

N1-B 下,group chat 里每条消息都会给所有非 sender 写 active。一个 50 人 group chat 里发一条消息 → 49 个 (agent, chat) 写 active session → agent_presence.activeSessions 计数膨胀。

**这其实是正确语义**:group 里每个非 sender 都被 cue 进了会话,active 是对的。

✅ **已确认接受**:这是 group chat 的固有特性,UI 上 "agent 有 N 个 active sessions" 即反映该 agent 当前参与的会话数,符合产品预期。

**性能注意**:`Promise.allSettled` 对 N 个 recipient 各开一个独立事务(INSERT ON CONFLICT + SELECT count + INSERT ON CONFLICT presence 三轮 SQL + 行锁)。**这是发每条消息的开销,不只是首条** —— 即使 chat 已经 active,每条新消息仍触发一轮 fan-out。activeSessions 计数虽然不会变(activity.ts 的 `setWhere ne(state, target)` 短路保证 active→active 不刷 updatedAt),但 INSERT ON CONFLICT 的探测仍会触发。50 人群每条消息 = 50 个并发事务,大群下会吃满连接池。后续 PR 可批量化(单事务 multi-row upsert + 一次性重算 presence counts),或在 N 上加并发上限。

**风险等级**:低(单发可接受);在大群高频场景下需要后续优化。

### R6. replyTo 跨 chat 投递不在本次 scope 内

[message.ts:219-246](packages/server/src/services/message.ts:219) 的 inReplyTo 分支会给 `original.replyToInbox` 在 **`original.replyToChat`**(可能与当前 chatId 不同)里多投一条 inbox entry,实现 "跨 chat 回复路由"。在该路径下,(replyToAgent, replyToChat) 的 session 激活仍依赖 client 上报后才会出现(5-10s 延迟)。

**为什么不修**:

- Web UI 路径(`sendChatMessage` / `sendFileMessage`)**永远不传** `inReplyTo` / `replyToInbox` / `replyToChat`,所以 replyTo 分支对本次 bug(workspace new chat 不立即出现)完全无影响
- 不修复 replyTo session 激活 = 保持当前已存在行为,**不引入 regression**
- 如未来 agent ws / adapter 路径需要 replyTo 即时生效,可作为独立 PR,把激活目标升级为 `{ agentId, chatId }[]` 并反查 inbox→agent

**风险等级**:低(不影响核心 bug 修复)。

### R7. PG NOTIFY 与 UI 即时刷新限于 Hub UI 本机路径

**关键区分**(避免误读):

- **DB 写入**(predictive `upsertSessionState`)**对所有 sendMessage caller 都生效** — admin/web、`sendToAgent`(agent ws)、adapter (Feishu/Slack)、GitHub webhook 等。`agent_chat_sessions` 行被提前 ~10s 写入是统一的。**这是预期行为**:M 方案改变了所有入口的 session 激活时点。
- **PG NOTIFY**(`notifySessionStateChange`)在 Step 1b 显式传 `notifier: undefined`,**不发**。
- **UI 即时刷新** 只在 Hub UI 自己的 sendMut.onSuccess 路径走 invalidate;其他入口仍依赖现有兜底链路(client 上报 + 10s 轮询)。

整理成表:

| 入口 | DB 提前写 active | PG NOTIFY | UI 即时刷新 |
|---|---|---|---|
| **Hub UI 本机 sendMessage** | ✅ 即时 | ❌ 不发(显式 undefined) | ✅ sendMut.onSuccess invalidate |
| Adapter (Feishu/Slack) | ✅ 即时 | ❌ 不发 | ❌ 走 client 上报 + 10s 轮询兜底 |
| Agent ws (`sendToAgent`) | ✅ 即时 | ❌ 不发 | ❌ 同上 |
| GitHub Webhook 等 | ✅ 即时 | ❌ 不发 | ❌ 同上 |

**为什么 NOTIFY 不发**:

- 用户的核心 bug 是 Hub UI 自己的 new chat 路径,不需要 NOTIFY 跨进程通知
- 让 server 预测写入也发 NOTIFY 需要把 `notifier` 注入 sendMessage,改动面变大(影响所有 caller),不在本次 scope
- 即使没 NOTIFY,client 后续上报 `session:state: active` 会触发自己的 NOTIFY,所以下游订阅者(其他 admin web 实例)最终能收到 — 只是延迟 5-10s

**未来扩展方向**:如要让所有入口都即时刷新 web admin,可在后续 PR 中把 `notifier` 加到 sendMessage 的可选参数,Step 1b 调 upsertSessionState 时传入真实 notifier,Web admin ws 监听 `session:state` NOTIFY 即可。

**风险等级**:低(不影响核心 bug 修复;DB 提前写入是预期改进)。

---

## 9. 实施步骤(Claude Code 视角,不估工时)

> 每步独立可 review。基于 N1-B / N2-A / N3-A / N4-B 已锁定决策,以及 Codex review 后追加的 lastSeenAt 隔离要求。

### Step 0:upsertSessionState 加 `touchPresenceLastSeen` 参数

文件:`packages/server/src/services/activity.ts`

#### 0a. 函数签名扩展

给 `upsertSessionState` 加一个可选 options 参数:

- 新签名形态(示意):`upsertSessionState(db, agentId, chatId, state, organizationId, notifier?, options?: { touchPresenceLastSeen?: boolean })`
- 默认值:`touchPresenceLastSeen: true`(向后兼容,client 上报路径行为不变)
- 实现:在 update agent_presence 时,根据该参数决定是否写 `lastSeenAt: now`(其他字段 `activeSessions` / `totalSessions` 仍然写)

#### 0b. 现有 caller 行为保持

WebSocket session:state 帧处理、admin/sessions 的 suspend/terminate 路由 — 全部不传新参数,默认行为不变(继续刷新 lastSeenAt)。

#### 0c. 测试更新

为 [activity.ts:23](packages/server/src/services/activity.ts:23) 现有测试加一个 case:`touchPresenceLastSeen: false` 时 `lastSeenAt` 不被写入;不传或传 true 时 `lastSeenAt` 刷新到 now。

#### 0d. 决策依据

server 预测写入时,client 进程可能根本没启动 / 已离线。如果污染 `lastSeenAt`,会让 stale 检测、连接诊断、"last seen" 类 UI 显示失真。把 "是否触碰心跳" 作为调用者的明确意图,语义清晰、向后兼容。

### Step 1:Server 单点改造

文件:`packages/server/src/services/message.ts`

#### 1a. 事务内:扩展 sendMessageInner 的事务返回值

在 `db.transaction(async tx => { ... })` 内部([message.ts:71-253](packages/server/src/services/message.ts:71)):

- 在 fan-out entries 计算([message.ts:201-208](packages/server/src/services/message.ts:201))之后,**额外收集** `recipientAgentIds`:遍历 participants 与 entries 的对应关系,取出 `notify=true` 的 agentIds(N1-B 精确范围)
- 在事务内 query 一次 `sender.organizationId`:扩展现有 [senderRow query at message.ts:101](packages/server/src/services/message.ts:101)(它当前是有条件触发,需要改为无条件)或在 step 1 的 participants query 末尾加一次 sender 专属 select
- 事务返回值新增字段:`recipientAgentIds: string[]`、`organizationId: string`

#### 1b. 事务外:Promise.allSettled best-effort upsert

在 `sendMessageInner` 函数体内、`db.transaction(...)` 调用结束之后、`return result` 之前:

- 用 `Promise.allSettled` 并发,对 `result.recipientAgentIds` 每个 agentId 调用 `upsertSessionState(db, agentId, chatId, 'active', result.organizationId, undefined, { touchPresenceLastSeen: false })`
- 每个 settled 结果检查,reject 时 `console.error`(或项目统一 logger)但不抛出(N4-B)
- `notifier: undefined`:server 此次预测写入**不发 PG NOTIFY**,即时性范围限于 Hub UI 本机发送路径(详见 §8 R7);其他入口走 client 上报兜底
- `touchPresenceLastSeen: false`:server 预测写入**不刷新** `agent_presence.lastSeenAt`,避免污染心跳语义(详见 Step 0 / §5 不变量 #2)

#### 1c. 覆盖范围

`sendMessage` 是所有发消息路径(admin/web、agent ws、adapter)的统一入口。Step 1a/1b 一处改动,自动覆盖以下所有调用方:

- `packages/server/src/api/admin/chats.ts:254`(admin/web)
- `packages/server/src/api/agent/chats.ts`(agent ws,如有)
- adapter 路径(Feishu/Slack 等)

#### 1d. 关键决策依据

- **不放进事务内**:N4-B 要求 upsertSessionState 失败不阻塞消息;事务内 throw 会回滚 messages + inbox_entries
- **organizationId 从 sender 取**:chat 内所有 participants 同一 org(multi-tenant 不变量),sender 的 organizationId 即等于所有 recipients 的 organizationId,无需逐个查
- **不修改 sendMessage 对外签名**:返回类型新增字段是向后兼容的(现有 caller 只读 `message` 和 `recipients`)
- **chat.updatedAt 仍然在事务内更新**:列表排序仍按消息活动时间,保持现状
- **touchPresenceLastSeen 显式传 false**:server 预测写入不应污染心跳(详见 Step 0 / §5 不变量 #2)
- **notifier 显式传 undefined**:即时性范围限于 Hub UI 本机发送路径;其他入口走现状链路(详见 §8 R7);本次不引入 notifier 注入,避免 scope 蔓延
- **replyTo 跨 chat 路径不处理**:Web UI 不触发该路径,本次不修(详见 §8 R6)

### Step 2:Server 测试

新增/扩展测试文件(优先放在 `packages/server/src/__tests__/`):

- **"upsertSessionState 接受 touchPresenceLastSeen 参数"**(Step 0 单元测试):传 false 时 `lastSeenAt` 不变;不传 / 传 true 时 `lastSeenAt` 刷新到 now(向后兼容)
- **"首条消息触发 active session"**:1:1 chat 首条消息后,`agent_chat_sessions` 立刻有一行 `state=active`,且 `agent_presence.activeSessions` 计数正确增加;**`lastSeenAt` 不变**(Step 1b 传 `touchPresenceLastSeen: false` 验证)
- **"evicted → active 复活"**:terminate 一个 session,再发消息,验证 state 重新变为 active(N2-A 行为)
- **"group chat fan-out"**:group 里 1 个 sender + N 个 participant,发消息后 N 个 (recipient, chatId) 各有一行 active
- **"silent context 不被激活"**(N1-B 边界):mention_only 模式下未被 mention 的 participant,sendMessage 后 `agent_chat_sessions` 中**没有**对应行(`notify=false` 不写 active session)
- **"upsertSessionState 失败不阻塞消息"**:mock upsertSessionState 抛错,验证 messages / inbox_entries 仍正确写入,且接口返回成功(N4-B 行为)
- **"terminate vs sendMessage 并发"**:扩展 [admin-sessions-suspend-terminate.test.ts](packages/server/src/__tests__/admin-sessions-suspend-terminate.test.ts) 覆盖最终状态由后写者决定(R3 风险)

### Step 3:Web 端两处微调

- **`packages/web/src/pages/workspace/roster/index.tsx`** 行 65-68:`newChatMut.onSuccess` 中 **移除** `queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) })`,保留 `onSelectChat(agentId, result.id)`(空 chat 此时本来就不会出现在 sessions 列表里,invalidate 是无效操作)
- **`packages/web/src/pages/workspace/center/chat-view.tsx`** 行 759-765:`sendMut.onSuccess` 中 **新增** `queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) })`(N3-A:不加重试)。原有的 `invalidateQueries({ queryKey: ["chat-messages", chatId] })` 保留

### Step 4:手测清单

- [ ] create chat(点 New chat)→ 左侧列表 **不更新**(预期行为)
- [ ] send first message → 左侧列表 **立刻出现新行**,dot 显示 active
- [ ] 等待 client 启动后 → dot 仍 active(幂等)
- [ ] suspend session → 行 state 变 suspended,**行不消失**
- [ ] terminate session(经过 suspend)→ 行从列表消失
- [ ] 已 terminate 的 chat 中再发消息 → **行重新出现**,state=active(N2-A 验证)
- [ ] group chat:N 个 participant 各自 workspace 都看到 active session(N1-B 验证)
- [ ] 网络抖动模拟:sendMessage 后 invalidate 失败 → 等待 10s 后列表自动出现新行(N3-A 验证)

---

## 10. 否决方案对比

| 方案 | 思路 | 否决理由 |
|---|---|---|
| **B1**(原地改 INNER JOIN → LEFT JOIN) | 让 listAgentSessions 显示空 chat | 函数名继续叫 sessions 但语义已经是 chat,留命名债务;且与 workspace 的 session 维度操作冲突 |
| **B2**(新建 listAgentChats) | 列表语义切到 chat 维度,session 作为装饰 | 与 workspace 现有 session 维度操作冲突;改动面大(6 web caller + server 4 处);需要新增 chat archive 概念才能完整 |
| **B3**(直接重命名替换) | 一次性把 listAgentSessions 改成 listAgentChats | breaking change;且根本问题(列表维度选错)未解 |
| **C1**(server 在 createChat 时写 pending session) | 创建 chat 即写 session | 用户可能建 chat 后不发消息,会出现死气 sessions;若用 active 则 active 数虚高;若用 pending 则需要新增四态破坏现有约定;需 TTL 兜底 |
| **C2**(SSE 推送 chat 创建事件) | 通过推送让 web 立刻刷列表 | 单独不能修问题(列表 INNER JOIN 仍空),实质塌缩成 B + 推送 |

**M 方案与 B2/C1 的核心差异**:M 不改变列表语义、不引入新状态、不新增 API、不需要新概念。它只是把 "session 状态唯一上报方" 这条不变量做窄一步,允许 server 在一个高置信度的时点(用户已发消息)做预测性写入。

---

## 11. Suspend / Terminate 操作影响(简化版)

新方案下,这两个操作的语义、UI、数据流 — **完全不变**:

| 操作 | 数据层 | UI |
|---|---|---|
| Suspend | state active → suspended,行保留 | 列表中可见,dot 变化 |
| Terminate(经 suspend 之后)| state suspended → evicted | 列表过滤掉 evicted,行从列表消失 |
| Terminate 后再发消息 | upsertSessionState 写 evicted → active | 列表重新出现该行,state=active |

[chat-view.tsx:205](packages/web/src/pages/workspace/center/chat-view.tsx:205) 的 `if (!isActive && !isSuspended) return null` — 完全不需要改。新模型下用户在新 chat 发了第一条消息后,server 立刻写 active,Suspend 按钮自动显示。

Dialog 文案 "Chat history is preserved; a new message will start a fresh session" — 数据层完美兑现,不用改。

---

## 12. Review 状态

- ✅ §7 N1-N4 决策已锁定(N1-B / N2-A / N3-A / N4-B)
- ✅ §8 风险点完整:R1-R5 + R6(replyTo scope 边界)+ R7(其他入口实时性范围)
- ✅ 文件名变更已完成(`list-agent-chats-refactor.md` → `session-creation-on-first-message.md`)
- ✅ **已对照最新代码全面验证**(基于 main HEAD `6536311`,含 multi-runtime PR #189);23 项具体声明逐项核对
- ✅ **Codex review 反馈已纳入**:
  - replyTo 跨 chat 投递 — 已确认本次 scope 不涉及(Web UI `sendChatMessage` / `sendFileMessage` 不传 inReplyTo / replyToInbox / replyToChat),记录为 §8 R6
  - lastSeenAt 心跳污染 — 选 A:`upsertSessionState` 加 `touchPresenceLastSeen?: boolean` 参数,server 预测写入显式传 false,新增 §9 Step 0
  - 其他入口实时性 — 选 X:M 方案只解 Hub UI 本机路径,边界已写入 §8 R7

**实施可启动**。后续按 §9 五个 Step 分段提交(Step 0 → 1 → 2 → 3 → 4),每步独立 review。
