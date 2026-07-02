---
title: "提案:Agent 在 computer / runtime provider 间的受控迁移"
soft_links:
  - docs/development/http-path-conventions.md
  - docs/development/agent-workspace-state.md
  - docs/cli-reference.md
---

# 提案:Agent 在 computer / runtime provider 间的受控迁移

**日期:** 2026-07-02
**状态:** 提案阶段
**范围:** `packages/server`(schema / service / API / WS)、`packages/shared`(schema)、`packages/client` + `apps/cli`(运行时与命令)、`packages/web`(管理入口)、相关文档与测试。

---

## TL;DR

今天 `agents.client_id` 是一次性(NULL → ID)且不可变的持久 pin——想换机器只能"删除重建 agent",丢掉 agent 的 UUID、名字、聊天历史与 inbox 地址。本提案引入**受控迁移**:一个显式的 `POST /api/v1/agents/:uuid/migrate` 操作,在一个事务里把 placement(`agents.client_id` + `agents.runtime_provider`)切到新的 computer / provider,并通过强制下线 + placement fence 保证**同一时间只有一个 active placement**。

核心取舍已由需求锁定:**接受丢失源 client 本地数据**(provider 会话、workspace 工作区、未提交改动)。服务端数据(agent 身份、聊天、消息、inbox、server 管理的 agent config、Context Tree)全部保留,在目标机器上按现有 `agent:pinned` 自动物化流程重新落地。

不引入新的常驻状态层:placement 的唯一事实来源仍是 `agents.client_id` + `agents.runtime_provider`;迁移只是给这两列一条受控的变更路径,外加一个用于 fence 的 `agents.placement_id`。

---

## 1. 背景与现状

### 1.1 现状盘点(实现基线)

| 机制 | 现状 |
|------|------|
| 持久 pin | `agents.client_id`,一次性 NULL → ID(WS 首绑竞争 claim 或 PATCH),之后不可变;service 层显式拒绝 ID → 另一 ID 和 ID → NULL(`packages/server/src/services/agent.ts`,`agent-client-immutable.test.ts` 钉死该行为) |
| provider | `agents.runtime_provider` NOT NULL,创建时设定;`agent:bind` 帧的 `runtimeType` 不匹配即拒绝(`runtime_provider_mismatch`) |
| 运行时绑定 | WS `agent:bind` 每次执行 Rule R-RUN:manager → user 归属、membership active、provider 匹配、`agents.client_id === 连接的 clientId`;从 DB 重读,不缓存 |
| 在线状态 | `agent_presence`(ephemeral,`client_id` 断连/清理时清空;`agents.client_id` 永不因断连清空) |
| 目标机自动落地 | `agent:pinned` 帧(创建带 clientId / PATCH 首绑 / `client:register` 时 backfill)→ CLI 自动写 `config/agents/<name>/agent.yaml` 并启动 slot |
| 源机残留识别 | `GET /me/pinned-agents` + `first-tree agent prune` 已能把"归你但 pin 在别的 client"的本地 alias 报告为 `pinned-elsewhere` |
| Inbox | 按 `agents.inbox_id` 入队,与 client 无关;投递要求 pin 所属 client 上有活跃 bind;bind 时有 stuck-`delivered` 恢复 |
| 例外路径 | 成员离开/移除时托管 agent 转给 fallback admin 且 `clientId: null`(生命周期兜底,非迁移) |

### 1.2 为什么现在放开

"不可变 pin"最初换来的是简单性:不用处理双活、不用处理迁移期间的路由竞争、不用定义本地数据归属。代价是运维死角:

- 换电脑 / 机器报废:agent 只能删除重建,UUID、聊天上下文、inbox 全部作废;
- `retireClient` 在有 agent pin 时直接拒绝("no reassign in this milestone"),退役一台机器要求先删光上面的 agent;
- provider 切换(如 claude-code → codex)同样只能重建。

需求方已明确接受"丢本地数据",这消解了不可变设计里最难的部分(workspace/会话迁移)。剩下的是把"换 pin"做成一个原子、可审计、无双活窗口的受控操作。

---

## 2. 目标 / 非目标

### 目标

1. **单一 active placement 不变量**:任意时刻,一个 agent 至多在一个 (client, provider) 组合上可绑定、可收 inbox 推送;迁移过程中不存在两端同时有效的窗口(fence 保证,见 §7/§10)。
2. 支持三种迁移形态,统一走同一个 API:
   - 换机器,provider 不变(A/claude-code → B/claude-code);
   - 换 provider,机器不变(A/claude-code → A/codex);
   - 两者同时换。
3. 服务端数据零丢失:agent 行、聊天、消息、inbox 队列、`agent_configs`、resource bindings 全部不动。
4. 目标机零手工操作:复用 `agent:pinned` 自动物化;目标 client 离线也能迁(上线 `client:register` 时 backfill)。
5. 受控:仅 agent 的 R-RUN owner(manager 对应的 user)可发起;working 中默认拒绝;留审计痕迹。
6. 解锁 `retireClient`:退役机器的推荐路径变为"先迁移再退役"。

### 非目标

- **不迁移本地数据**:provider 会话 transcript、workspace 工作区(含未提交改动)、`data/sessions/<name>.json` 一律不搬。这是需求给定的简化,v1 不做任何"导出/导入"。
- 不支持 human agent(无 runtime,`client_id` 恒为 NULL)。
- 不支持跨 user 迁移(目标 client 必须归 manager 的 user 所有,否则 R-RUN 永远拒绝;换人仍走 `logout --purge` + 重建)。
- 不做自动迁移 / 故障转移(client 掉线不触发任何自动 re-pin);迁移永远是显式操作。
- 不改 inbox 数据面协议。

---

## 3. 核心概念:Placement

**Placement := (`agents.client_id`, `agents.runtime_provider`)**,外加一个身份戳 `agents.placement_id`。

- `client_id` / `runtime_provider` 仍是唯一事实来源,R-RUN 与 provider 校验逻辑**不变**——迁移后旧 client 的 `agent:bind` 自然收到 `wrong_client`,无需新增校验分支。
- `placement_id`(新列,uuid 文本):每次 placement 建立或变更时重新生成。它解决两个纯靠 (client_id, provider) 二元组解决不了的问题:
  1. **A → B → A 回迁**:client_id 又变回 A,client A 上残留的旧 session registry / workspace 状态没有任何本地信号可以发现自己已过期;
  2. **迁移瞬间的 fence**:正在飞行的旧 bind / 旧帧需要一个单调变化的标识来判定过期。

`agent:bound` 响应与 `agent:pinned` 帧都携带 `placementId`;client 把它写进本地会话 registry,发现不一致就丢弃本地会话映射、全部会话从头开始(与"接受丢本地数据"一致)。

---

## 4. 数据模型变更

### 4.1 `agents` 表

```ts
// packages/server/src/db/schema/agents.ts
{
  // 语义变更:仍然 NULL → ID 首绑;但 ID → 另一 ID 允许经由
  // migrateAgent() 服务(且仅此路径)。PATCH 保持一次性语义不变。
  clientId: text("client_id").references(() => clients.id, { onDelete: "restrict" }),
  runtimeProvider: text("runtime_provider").notNull().default("claude-code"),
  // 新增:placement 身份戳。首绑(claim 或 PATCH)与每次 migrate 时重新生成。
  // 已有存量行由 migration 回填(随机 uuid)。
  placementId: text("placement_id").notNull(),
}
```

### 4.2 新表 `agent_placement_events`(审计,append-only)

```ts
export const agentPlacementEvents = pgTable("agent_placement_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.uuid, { onDelete: "cascade" }),
  placementId: text("placement_id").notNull(),
  fromClientId: text("from_client_id"),          // NULL = 首绑
  toClientId: text("to_client_id").notNull(),
  fromProvider: text("from_provider"),
  toProvider: text("to_provider").notNull(),
  initiatedByUserId: text("initiated_by_user_id").notNull(),
  forced: boolean("forced").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

用途:支持排查("这个 agent 什么时候从哪台机器迁走的")、Web 端展示迁移历史。首绑也写一行(fromClientId NULL),让 placement 历史完整。

### 4.3 不变的部分

- `agent_presence`:结构不变。迁移时按现有 `unbindAgent(db, agentId, { expectedClientId })` 清空。
- `inbox_entries` / `messages` / `agent_chat_sessions`:结构不变;迁移事务里把该 agent 所有 `agent_chat_sessions.runtime_state` 重置为 `idle`(runtimeStateAt 置 NULL),避免旧机器上 `working` 的残影卡在组合状态里。
- `clients`:不变。迁移不动 client 行;`retireClient` 的拒绝逻辑保留,但错误信息改为提示"先 migrate"。

### 4.4 shared schema

```ts
// packages/shared/src/schemas/agent.ts
export const migrateAgentRequestSchema = z.object({
  targetClientId: z.string().min(1).max(100),
  /** 省略 = 保持当前 provider */
  runtimeProvider: runtimeProviderSchema.optional(),
  /**
   * 双重含义,与 createAgent 的 force 对齐:
   * 1) 跳过目标 client 的 capability 检查(离线/未探测的机器);
   * 2) 允许在有 working 会话时强行迁移(丢弃飞行中的 turn)。
   */
  force: z.boolean().optional(),
});

// agentSchema / agentPinnedMessageSchema 增加 placementId 字段
// (pinned 帧:旧 client 解析时未知字段被忽略,wire 兼容)
```

---

## 5. API 设计

### 5.1 `POST /api/v1/agents/:uuid/migrate`(Class C,新增)

沿用 per-agent 路由类的鉴权基线(`requireAgentAccess(request, db, "manage")`),再加一条迁移特有的前置:**目标 client 必须归 agent manager 对应的 user 所有**(`clients.user_id === manager.userId`)。org admin 即便有 manage 权限,也不能把别人的 agent 迁到别人的机器上——那会造出一个 R-RUN 永远拒绝的死 placement。admin 需要先走已有的 manager 重指派,再由新 manager 迁移。

请求体:`migrateAgentRequestSchema`。响应:序列化后的 agent(含新 `clientId` / `runtimeProvider` / `placementId`)。

错误映射:

| 条件 | 响应 |
|------|------|
| agent 是 human / 已删除 | 400 / 404 |
| agent suspended | 400(先 reactivate;suspend 状态下迁移没有意义,`agent:pinned` 对 suspended agent 也不会启动 slot) |
| 目标 client 不存在 / 不归 manager 的 user | 400 |
| 目标 == 当前 (client, provider),无变化 | 400(幂等噪音直接拒绝,防误操作) |
| 目标 client capability 显示 provider 不可用 | 400,`force: true` 可跳过(复用 `assertClientSupportsRuntimeProvider` 的三态语义) |
| 存在 `runtime_state = working` 的会话且未 `force` | 409,提示等待或 force |

### 5.2 PATCH `/api/v1/agents/:uuid` 不变

`clientId` 保持一次性 NULL → ID。理由:PATCH 是通用更新面,迁移是带副作用(强制下线、会话重置、审计)的操作,混进 PATCH 会让"改个 displayName 顺手把 agent 迁走"成为可能。service 层的 immutable 报错信息更新为指向 migrate 端点。

### 5.3 CLI

```
first-tree agent migrate <name-or-uuid> --to-client <clientId> [--provider <p>] [--force] [--yes]
```

- 业务逻辑放 `apps/cli/src/core/agent-migrate.ts`,命令层薄封装(仓库惯例);
- 交互式确认必须复述数据丢失边界(§9 的清单),`--yes` 跳过;
- `first-tree computers`(已有 `/me/clients`)辅助用户找 targetClientId。

### 5.4 Web

Agent 详情页(admin/manager 视角)加 "Migrate" 操作:选择目标 computer(来自该 manager user 的 clients 列表)+ provider 下拉,展示与 CLI 相同的数据丢失警告。v1 可以只做 CLI,Web 作为紧随的增量。

---

## 6. 服务端迁移流程

`migrateAgent(db, agentId, { targetClientId, runtimeProvider, force, initiatedByUserId })`,`packages/server/src/services/agent.ts`:

```
1. 读 agent 行 + manager → user;校验 §5.1 全部前置。
2. 未 force 时:查 agent_chat_sessions 是否有 runtime_state = 'working' 的行,有则 409。
3. 事务:
   a. UPDATE agents
        SET client_id = :target,
            runtime_provider = COALESCE(:provider, runtime_provider),
            placement_id = :newPlacementId,
            updated_at = now()
        WHERE uuid = :agentId
          AND client_id = :expectedOldClientId      -- 乐观锁:并发迁移只赢一个
          AND placement_id = :expectedOldPlacementId
      (0 行受影响 → 409 Conflict,让调用方重读重试)
   b. UPDATE agent_chat_sessions SET runtime_state = 'idle', runtime_state_at = NULL
        WHERE agent_id = :agentId
   c. presence: unbindAgent(tx, agentId)   -- 清 ephemeral client_id / runtime 字段
   d. INSERT agent_placement_events (...)
4. 事务提交后(不回滚业务副作用):
   a. 源端下线:forceDisconnect(agentId, "migrated")
      + 跨实例广播(见 §10.2)。
   b. 目标端通知:notifyClientAgentPinned(agent)   -- 复用现有 agent:pinned 推送;
      目标 client 离线则静默,靠 client:register 时的 pinned backfill 补投。
```

**Inbox 语义(零改动,自然正确):**

- `pending` 行:与 client 无关,目标机 bind 后照常投递;
- `delivered` 未 ack 行:推给了旧 client 但旧 runtime 已被杀,现有的 bind 时 stuck-`delivered` 恢复逻辑(`packages/server/src/services/inbox.ts`)会在目标机首次 bind 时重置重投——at-least-once 语义闭环;
- 已 `acked` 但旧 runtime 没跑完的 turn:随本地数据一起丢(force 迁移的明示代价;非 force 路径被第 2 步的 working 检查挡住大部分)。

---

## 7. 客户端行为

### 7.1 源 client(可能在线,可能离线)

- 在线:收到 `agent:force_disconnect { reason: "migrated" }`。`ClientRuntime` 已有该帧的处理管线(`agent:unbound` 事件),扩展 reason 映射:`migrated` → slot 停止、本地状态标记 `migrated-away`(不删任何本地文件——删除永远是操作员显式动作)。随后若 slot 因崩溃/重启尝试 re-bind,R-RUN 返回 `wrong_client`,现有拒绝处理已经会停 slot。
- 离线:什么都不发生。下次 daemon 启动时 bind 被 `wrong_client` 拒绝;`first-tree agent prune` / `doctor` 已把这种 alias 归类为 `pinned-elsewhere`,提示操作员清理。**旧版本 CLI 无需升级也安全**——这是复用 R-RUN 每次重校验的直接收益。
- 本地残留(workspace、sessions 文件)由 `agent prune` 按现有语义清理。

### 7.2 目标 client

- 新 alias:`agent:pinned` 处理器现有逻辑直接生效(写 `agent.yaml`、启 slot)。帧里已带 `runtimeProvider`,yaml 的 `runtime` 字段写对。
- **已存在同 agentId 的 alias(回迁 / 换 provider 场景)——需要两处增强:**
  1. `handleAgentPinned` 目前对已存在的 agent 直接 return。改为:比对本地 `agent.yaml` 的 `runtime` 与帧中 `runtimeProvider`,不一致则改写 yaml 并重启 slot(provider 原地切换就落在这条路径:server 推 `agent:pinned` 给同一台机器)。
  2. **placement fence 消费**:`agent:bound` 响应带回 `placementId`;`SessionManager` 的 registry 文件(`data/sessions/<name>.json`)顶层记录上次见到的 `placementId`,不一致 → 清空 chat → session 映射,所有会话按新会话冷启动。workspace 目录保留复用(Context Tree / 源 repo 会被现有 workspace 准备逻辑重新对齐)。
- 目标机上的 workspace 冷启动完全走现有首启路径:clone Context Tree、按 `agent_configs` 拉 server 管理的运行时配置、装 skills——不需要任何迁移专用逻辑。

### 7.3 provider 原地切换(client 不变)

同一 API,`targetClientId` = 当前 client。流程完全一致:bind 因 `runtime_provider_mismatch`/force_disconnect 断开,`agent:pinned` 触发 yaml 改写 + slot 以新 handler 重启,placementId 变化把旧 provider 的 session 映射作废。

---

## 8. 数据丢失边界(用户可见的明示契约)

| 数据 | 迁移后 | 说明 |
|------|--------|------|
| agent 身份(UUID、name、displayName、inbox_id、头像) | 保留 | 服务端行不动 |
| 聊天、消息、参与关系 | 保留 | 服务端 |
| inbox 待投递消息 | 保留并在新机投递 | §6 |
| server 管理的 agent config(model、env、repos、skills) | 保留,新机自动拉取落地 | `agent_configs` |
| Context Tree | 保留(git 重新 clone) | |
| provider 会话 transcript(claude-code / codex 本地会话) | **丢失** | 所有 chat 的会话冷启动,agent 失去会话内记忆 |
| workspace 工作区(含源 repo **未提交/未 push 的改动**) | **丢失**(留在源机,不搬) | CLI 确认文案必须点名这一条 |
| `data/sessions/<name>.json` 会话映射 | 作废 | placementId fence |
| 飞行中的 turn(force 迁移时) | **丢失** | 非 force 被 working 检查挡住 |

---

## 9. 并发、故障与多实例

### 9.1 竞态清单

| 竞态 | 防线 |
|------|------|
| 两个 migrate 并发 | §6.3a 的乐观锁 UPDATE(WHERE 带旧 client_id + 旧 placement_id),只赢一个 |
| migrate 与首绑 claim 并发 | claim 是 `WHERE client_id IS NULL`,migrate 要求 `client_id = 旧值`;两者互斥,各自原子 |
| 旧 client 在 migrate 提交后 re-bind | bind 每次从 DB 重读 → `wrong_client`,现有机制 |
| 旧 client 已 bind、migrate 后继续发帧 | 主防线:提交后立即 forceDisconnect(本实例)+ 跨实例广播(§9.2)。残余窗口内旧帧只污染 presence/会话状态,而这两者都已在事务里重置,且 `session:state` 等帧带 `expectedClientId` 语义的写入以 in-memory 绑定为准——广播到达后即断流。不追求逐帧查 DB(成本不值) |
| 目标 client 恰好持有同 agent 的旧 alias 且 daemon 在跑 | `agent:pinned` 增强路径(§7.2)+ placementId fence,启动即冷启动 |
| migrate 事务提交后、通知发出前 server 崩溃 | DB 已是新 placement:旧 client 下次任何 bind 被拒;目标 client 下次 `client:register` 收到 pinned backfill。通知只是加速,不承载正确性 |

### 9.2 多实例下线广播

`forceDisconnect` 是实例内存操作;源 client 的 WS 可能挂在另一个 server 实例上。沿用"PostgreSQL 是唯一通知后端"的架构规则:复用现有 pg NOTIFY notifier 基础设施,新增一个 `agent_placement` 频道,payload `{ agentId, placementId }`;每个实例订阅,收到后若本实例 `connectionManager` 里有该 agent 的绑定则执行 `forceDisconnect(agentId, "migrated")`。这与 inbox 唤醒同构,不引入新组件。(现有 `/disconnect`、suspend 端点存在同样的单实例盲区,本频道顺带修复它们——同一 handler,reason 参数化。)

### 9.3 目标 client 离线

允许。迁移即时生效(DB 层),agent 表现为 offline,`agent test` 端点如实报告;目标机上线注册时 pinned backfill 自动落地。CLI 在目标 client `status: disconnected` 时提示但不阻止。

---

## 10. 权限与安全

- 发起者:通过 `requireAgentAccess(manage)` 的调用方(manager 本人或 org admin),**且**目标 client 归 manager 的 user 所有(§5.1)。
- 不新增 JWT scope / 路由类:Class C 现有约定覆盖;`http-path-conventions.md` 增补该端点条目。
- 审计:`agent_placement_events` + 服务端结构化日志(initiatedBy、from/to、forced)。
- 不引入任何跨 user 数据流:迁移不触碰凭据,`agent_configs` 加密负载(AES-256-GCM)读取路径不变。

---

## 11. 兼容性

| 组件 | 旧版本行为 |
|------|-----------|
| 旧 CLI(源机) | 不认识 `reason: "migrated"` → 当作普通 force_disconnect;re-bind 收 `wrong_client` 停止。安全 |
| 旧 CLI(目标机) | `agent:pinned` 多出的 `placementId` 字段被忽略;新 alias 正常落地。已存在 alias + provider 变化的场景需要新 CLI(旧 CLI 会以旧 provider bind → `runtime_provider_mismatch` 拒绝,状态可见、无损坏,升级 CLI 即恢复) |
| `agent-client-immutable.test.ts` | 更新:PATCH 不可变语义保留,新增"migrate 服务是唯一变更路径"的断言 |
| 文档 | `AGENTS.md` 架构规则句、`docs/cli-reference.md`、`docs/onboarding-guide.md`("permanently bound"措辞)、`docs/development/agent-workspace-state.md`(placementId 落盘)、`retireClient` 报错文案 |

Drizzle migration:`agents.placement_id` 加列 + 存量回填(生成 uuid),`agent_placement_events` 建表。均由 `drizzle-kit generate` 产出。

---

## 12. 实施拆分

按依赖顺序,每步可独立 PR、独立测试:

1. **Shared + Schema**:`migrateAgentRequestSchema`、`agentSchema`/`agentPinnedMessageSchema` 加 `placementId`;Drizzle 加列/建表 + migration;首绑路径(WS claim、PATCH、createAgent)生成 `placement_id` 并写首条 placement event。
2. **Server service + API**:`migrateAgent` 服务(事务 + 乐观锁 + 会话重置)、`POST /agents/:uuid/migrate` 路由、`agent_placement` NOTIFY 频道与各实例订阅、`agent:bound` 响应携带 `placementId`。
3. **Client + CLI**:`agent:pinned` 已存在 alias 的 provider 改写/重启路径、session registry 的 placementId fence、`reason: "migrated"` 处理、`first-tree agent migrate` 命令(core + command + 确认文案)。
4. **Web + 文档收尾**:Web 迁移入口、全部文档更新、`retireClient` 文案、旧测试更新。

风险最高的是第 2 步的竞态正确性和第 3 步的 pinned-handler 改造(它同时服务首绑与迁移两个场景);第 1 步的回填 migration 是唯一动存量数据的地方,但只是加列填随机值,无语义风险。

---

## 13. 测试计划

- **Server 单测**:migrate 服务全部前置校验矩阵;乐观锁并发(两个 migrate、migrate vs 首绑 claim);会话 runtime_state 重置;placement event 写入;force 语义(capability 跳过、working 跳过)。
- **WS 集成**:旧 client bind → migrate → 旧 client 收 force_disconnect、re-bind 收 `wrong_client`;目标 client 收 `agent:pinned`;bind 后 stuck-`delivered` inbox 恢复到新机;`agent:bound` 携带新 placementId。
- **CLI 单测**:pinned handler 的三分支(新 alias / 同 alias 同 provider / 同 alias 换 provider);session registry fence(placementId 变化清空映射);prune 对迁走 alias 的 `pinned-elsewhere` 归类(已有测试,验证不回归)。
- **端到端手测脚本**:A→B、B→A 回迁(验证 fence)、A 原地换 provider、目标离线迁移 + 上线 backfill。

---

## 14. 未决问题

1. **迁移频控**:是否需要限制迁移频率(如冷却时间)防止误操作抖动?v1 倾向不做,靠确认交互兜底。
2. **suspended agent**:v1 拒绝迁移 suspended agent(§5.1)。若运维反馈"想把挂起的 agent 挪到新机再启用"是高频诉求,可放开为"允许迁移但不推 pinned,reactivate 时再推"。
3. **源机自动清理**:是否在源 CLI 收到 `migrated` 时主动提示一条 `agent prune` 建议?倾向做(纯提示,不自动删)。
