---
title: "提案:Agent 在 computer / runtime provider 间的受控迁移(零 DB 变更)"
soft_links:
  - docs/development/http-path-conventions.md
  - docs/development/agent-workspace-state.md
  - docs/cli-reference.md
---

# 提案:Agent 在 computer / runtime provider 间的受控迁移

**日期:** 2026-07-02
**状态:** 提案阶段(修订 v3:操作入口仅 Web/API,CLI 不新增命令;v2:去掉 placement_id / 审计表,零 DB 变更)
**范围:** `packages/server`(service / API / WS,无 schema 变更)、`packages/shared`(仅请求 DTO)、`packages/client` + `apps/cli`(仅被动运行时行为,无新命令)、`packages/web`(唯一操作入口)、相关文档与测试。

---

## TL;DR

今天 `agents.client_id` 是一次性(NULL → ID)且不可变的持久 pin——想换机器只能"删除重建 agent",丢掉 agent 的 UUID、名字、聊天历史与 inbox 地址。本提案引入**受控迁移**:一个显式的 `POST /api/v1/agents/:uuid/migrate` 操作,在一个事务里用 CAS(compare-and-swap)把 placement——即 **`agents.client_id` + `agents.runtime_provider`,不引入任何新概念、新列、新表**——切到目标 computer / provider,并通过强制下线 + R-RUN 每次 bind 重校验保证**同一时间只有一个 active placement**。

核心取舍已由需求锁定:**接受丢失源 client 本地数据**(provider 会话、workspace 工作区、未提交改动)。服务端数据(agent 身份、聊天、消息、inbox、server 管理的 agent config、Context Tree)全部保留,在目标机器上按现有 `agent:pinned` 自动物化流程重新落地。

**零 DB 变更**:不加列、不建表、无 Drizzle migration。迁移只是对现有列的一次受控 UPDATE;审计靠服务端结构化日志;客户端的会话失效(fence)完全由现有 wire 信号驱动。

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

需求方已明确接受"丢本地数据",这消解了不可变设计里最难的部分(workspace/会话迁移)。剩下的是把"换 pin"做成一个原子、无双活窗口的受控操作。

---

## 2. 目标 / 非目标

### 目标

1. **单一 active placement 不变量**:任意时刻,一个 agent 至多在一个 (client, provider) 组合上可绑定、可收 inbox 推送;迁移过程中不存在两端同时有效的窗口(见 §6/§9)。
2. 支持三种迁移形态,统一走同一个 API:
   - 换机器,provider 不变(A/claude-code → B/claude-code);
   - 换 provider,机器不变(A/claude-code → A/codex);
   - 两者同时换。
3. **零 DB 变更**:不新增列/表/迁移;placement 的唯一事实来源就是现有的 `agents.client_id` + `agents.runtime_provider`。
4. 服务端数据零丢失:agent 行、聊天、消息、inbox 队列、`agent_configs`、resource bindings 全部不动。
5. 目标机零手工操作:复用 `agent:pinned` 自动物化;目标 client 离线也能迁(上线 `client:register` 时 backfill)。
6. 受控:仅 agent 的 R-RUN owner(manager 对应的 user)可发起;working 中默认拒绝;服务端结构化日志留痕。
7. 解锁 `retireClient`:退役机器的推荐路径变为"先迁移再退役"。

### 非目标

- **不迁移本地数据**:provider 会话 transcript、workspace 工作区(含未提交改动)、`data/sessions/<name>.json` 一律不搬。这是需求给定的简化,v1 不做任何"导出/导入"。
- 不支持 human agent(无 runtime,`client_id` 恒为 NULL)。
- 不支持跨 user 迁移(目标 client 必须归 manager 的 user 所有,否则 R-RUN 永远拒绝;换人仍走 `logout --purge` + 重建)。
- 不做自动迁移 / 故障转移(client 掉线不触发任何自动 re-pin);迁移永远是显式操作。
- 不改 inbox 数据面协议;不改 `agent:bind` / `agent:pinned` / `agent:bound` 的帧结构(唯一 wire 增量是 `agent:force_disconnect` 的新 reason 值 `"migrated"`,旧客户端天然容忍未知 reason)。

---

## 3. 数据层:零变更,只有一次受控 UPDATE

**Placement := (`agents.client_id`, `agents.runtime_provider`)。** 不引入 placement_id、不引入 epoch、不建审计表。

迁移在数据层只做三件事,全部是现有表上的 UPDATE:

1. **CAS 更新 agents 行**(见 §6),这是"受控变更路径"的全部;
2. 重置该 agent 全部 `agent_chat_sessions.runtime_state = 'idle'`(`runtime_state_at` 置 NULL),清掉旧机器 `working` 残影;
3. 按现有 `presenceService.unbindAgent` 清 `agent_presence` 的 ephemeral 字段。

其余全部不动:

- `clients` 表不动;`retireClient` 的拒绝逻辑保留,错误信息改为提示"先 migrate"。
- `inbox_entries` / `messages` 不动(语义见 §6 末尾)。
- R-RUN 与 provider 校验逻辑**一行不改**——迁移提交后,旧 client 的 `agent:bind` 自然收到 `wrong_client`,不需要新增校验分支。

**审计**:不建表。migrate 端点开启 `otelRecordBody`(与 PATCH 同款),并打一条结构化日志(agentId、from/to clientId、from/to provider、initiatedByUserId、forced)。这满足"排查某次迁移"的需要;如果将来需要面向产品的迁移历史,再单独立项。

### shared schema(仅新增请求 DTO)

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
```

`agentSchema` / `agentPinnedMessageSchema` 均不变。

---

## 4. API 设计

### 4.1 `POST /api/v1/agents/:uuid/migrate`(Class C,新增)

沿用 per-agent 路由类的鉴权基线(`requireAgentAccess(request, db, "manage")`),再加一条迁移特有的前置:**目标 client 必须归 agent manager 对应的 user 所有**(`clients.user_id === manager.userId`)。org admin 即便有 manage 权限,也不能把别人的 agent 迁到别人的机器上——那会造出一个 R-RUN 永远拒绝的死 placement。admin 需要先走已有的 manager 重指派,再由新 manager 迁移。

请求体:`migrateAgentRequestSchema`。响应:序列化后的 agent(含新 `clientId` / `runtimeProvider`)。

错误映射:

| 条件 | 响应 |
|------|------|
| agent 是 human / 已删除 | 400 / 404 |
| agent 从未首绑(`client_id` 为 NULL) | 400(首绑走现有 PATCH / WS claim 路径;migrate 只服务已有 placement,同时保证 §5 CAS 与首绑 claim 的互斥前提) |
| agent suspended | 400(先 reactivate;suspend 状态下迁移没有意义,`agent:pinned` 对 suspended agent 也不会启动 slot) |
| 目标 client 不存在 / 不归 manager 的 user | 400 |
| 目标 == 当前 (client, provider),无变化 | 400(幂等噪音直接拒绝,防误操作;该前置同时是 §6 CAS 可靠性的前提) |
| 目标 client capability 显示 provider 不可用 | 400,`force: true` 可跳过(复用 `assertClientSupportsRuntimeProvider` 的三态语义) |
| 存在 `runtime_state = working` 的会话且未 `force` | 409,提示等待或 force |
| CAS 失败(并发迁移撞车) | 409,调用方重读重试 |

### 4.2 PATCH `/api/v1/agents/:uuid` 不变

`clientId` 保持一次性 NULL → ID。理由:PATCH 是通用更新面,迁移是带副作用(强制下线、会话重置)的操作,混进 PATCH 会让"改个 displayName 顺手把 agent 迁走"成为可能。service 层的 immutable 报错信息更新为指向 migrate 端点。

### 4.3 操作入口:仅 Web(不新增 CLI 命令)

迁移的唯一操作面是 Admin API + Web。**CLI 不新增任何命令**——agent 生命周期管理(create / suspend / delete)本来就以 Admin API + Web 为主面,迁移与之同类;CLI 侧全部改动都是**被动的运行时行为**(§6 的 fence、pinned handler 增强、`prune`/`doctor` 既有通道),不引入新的用户命令面。

Web 入口:Agent 详情页(manager / admin 视角)加 "Migrate" 操作:

- 目标 computer 选择器,数据来自该 agent manager user 的 clients 列表(admin 视角下也只列 manager 的机器,与 §4.1 的鉴权前置一致,选不出会被 400 的目标);
- provider 下拉(默认保持当前);
- 目标 client 离线时提示但不阻止(§8.3);
- 确认对话框完整复述数据丢失边界(§7 的清单),**点名"未提交/未 push 改动会丢"**;
- 409-working 时提示等待或勾选 force 重试。

脚本化/自动化场景直接调 `POST /api/v1/agents/:uuid/migrate`,不为此包装命令。

---

## 5. 服务端迁移流程

`migrateAgent(db, agentId, { targetClientId, runtimeProvider, force, initiatedByUserId })`,`packages/server/src/services/agent.ts`:

```
1. 读 agent 行 + manager → user;校验 §4.1 全部前置(含"无变化则 400")。
2. 未 force 时:查 agent_chat_sessions 是否有 runtime_state = 'working' 的行,有则 409。
3. 事务:
   a. UPDATE agents
        SET client_id = :target,
            runtime_provider = :targetProvider,
            updated_at = now()
        WHERE uuid = :agentId
          AND client_id = :expectedOldClientId          -- CAS 乐观锁
          AND runtime_provider = :expectedOldProvider   -- 并发迁移只赢一个
      (0 行受影响 → 409 Conflict,让调用方重读重试)
   b. UPDATE agent_chat_sessions SET runtime_state = 'idle', runtime_state_at = NULL
        WHERE agent_id = :agentId
   c. presence: unbindAgent(tx, agentId)   -- 清 ephemeral client_id / runtime 字段
4. 事务提交后(不回滚业务副作用):
   a. 源端下线:forceDisconnect(agentId, "migrated")
      + 跨实例广播(见 §9.2)。
   b. 目标端通知:notifyClientAgentPinned(agent)   -- 复用现有 agent:pinned 推送;
      目标 client 离线则静默,靠 client:register 时的 pinned backfill 补投。
   c. 结构化审计日志(§3)。
```

**CAS 为什么够**(不需要 epoch 列):§4.1 已拒绝"无变化"请求,所以每次成功迁移必然改变 (client_id, runtime_provider) 二元组至少一个分量。两个并发迁移读到同一旧值,先提交者改掉旧值,后提交者的 WHERE 落空 → 409。与首绑 claim 也互斥:claim 是 `WHERE client_id IS NULL`,migrate 要求 `client_id = 旧值`,两者不可能同时命中同一行。

**Inbox 语义(零改动,自然正确):**

- `pending` 行:与 client 无关,目标机 bind 后照常投递;
- `delivered` 未 ack 行:推给了旧 client 但旧 runtime 已被杀,现有的 bind 时 stuck-`delivered` 恢复逻辑(`packages/server/src/services/inbox.ts`)会在目标机首次 bind 时重置重投——at-least-once 语义闭环;
- 已 `acked` 但旧 runtime 没跑完的 turn:随本地数据一起丢(force 迁移的明示代价;非 force 路径被第 2 步的 working 检查挡住大部分)。

---

## 6. 客户端行为与本地会话 fence

本地需要失效的只有一样东西:`data/sessions/<name>.json` 里 chat → provider session 的映射(指向本机的旧 transcript)。fence 不依赖任何新的服务端状态,由三个现有信号驱动,按覆盖面从大到小:

**F1 — 在线源机**:收到 `agent:force_disconnect { reason: "migrated" }` → 停 slot、**立即作废该 agent 的本地会话映射**、状态标记 `migrated-away`(不删任何本地文件——删除永远是操作员显式动作)。旧 CLI 不认识该 reason,退化为普通 force_disconnect(安全,见 F2)。

**F2 — 离线源机,daemon 之后有启动**:任何一次 `agent:bind` 收到 `wrong_client` 拒绝,即 R-RUN 判定"本机不是该 agent 的 placement" → 作废本地会话映射(现有拒绝处理已停 slot,只需追加这一步)。`agent prune` / `doctor` 按现有 `pinned-elsewhere` 语义提示清理残留。

**F3 — 回迁兜底(A→B→A,A 全程没跑过 daemon)**:F1/F2 都没机会触发,A 重新成为 placement 后本地旧映射看似有效。兜底:slot 绑定成功后已经调用 `sdk.register()`(`GET /api/v1/agent/me`,返回完整 agent 行,**现有接口,无 wire 变更**);client 在会话 registry 顶层记录上次成功绑定时看到的 `agent.updatedAt`,不一致 → 作废映射后再更新记录。migrate 必然 bump `updated_at`,所以任何"离开又回来"都会被捕获。误伤面:无关 PATCH(如改 displayName)也 bump `updated_at`,会造成一次不必要的会话冷启动——方向安全(冷启动 = 丢会话记忆,契约内),且 agent 属性编辑是低频操作。若实测误伤成为痛点,再收窄(见 §13 未决问题 3)。

### 6.1 目标 client

- 新 alias:`agent:pinned` 处理器现有逻辑直接生效(写 `agent.yaml`、启 slot)。帧里已带 `runtimeProvider`,yaml 的 `runtime` 字段写对。
- **已存在同 agentId 的 alias(回迁 / 换 provider 场景)——`handleAgentPinned` 需要两点增强**:
  1. 目前对已存在的 agent 只在 `suspended-skipped` 状态下重启,其余直接 return。必须扩展为:`failed`(迁走后 bind 被 `wrong_client` 拒绝的终态)与 `idle`(被 `force_disconnect(migrated)` 停掉的状态)也触发重启——否则 **A→B→A 回迁时源机 daemon 若一直在跑,agent 不会自动复活,只能重启 daemon**(现状已核实,`apps/cli/src/core/client-runtime.ts` 的 `handleAgentPinned`)。
  2. 比对本地 `agent.yaml` 的 `runtime` 与帧中 `runtimeProvider`,不一致则改写 yaml 后再重启 slot(provider 原地切换就落在这条路径:server 推 `agent:pinned` 给同一台机器)。
- 目标机上的 workspace 冷启动完全走现有首启路径:clone Context Tree、按 `agent_configs` 拉 server 管理的运行时配置、装 skills——不需要任何迁移专用逻辑。workspace 目录若已存在(回迁)则保留复用,会话映射由 F1–F3 作废。

### 6.2 provider 原地切换(client 不变)

同一 API,`targetClientId` = 当前 client。流程完全一致:源即目标,先收 `force_disconnect(migrated)`(F1 作废会话),再收 `agent:pinned` 触发 yaml 改写 + slot 以新 handler 重启。

### 6.3 源机残留目录:不强制清理(已核实无依赖)

迁移后源机的 `config/agents/<name>/`、`data/workspaces/<name>/`、`data/sessions/<name>.json` **保留原地,不自动删除**。已逐路径核实残留是惰性的、没有代码逻辑依赖清理才能正确工作:

- daemon 启动照常加载残留 alias,bind 被 `wrong_client` 拒绝 → slot 进 `failed` 态,一条 "connection failed" 日志;不崩溃、不影响同机其他 agent、不消费 inbox;
- 目录 watcher(`scanForNewAgents`)对已加载条目按 name/agentId 去重,不会反复重加;
- `wrong_client` 在错误分类里是 transient(有意为之,覆盖"agent 稍后才 pin 到本机"的场景,不改):每次 WS 重连会重试 bind,指数退避封顶约 5 分钟,debug 级日志。代价是无意义的低频 bind 流量,直到操作员清理;
- `doctor` / `agent prune` 已把残留归类为 `pinned-elsewhere`,是既有的清理通道。

两条纪律(写进 CLI 提示与文档,不写自动化):

1. 清理必须走 `agent remove` / `agent prune`(三件套一起删)。**手动只删 config alias 是危险的**:残留的 `data/sessions/<name>.json` 会被日后复用同名的新 agent 吸入旧会话映射(F1–F3 之外唯一已知的会话污染路径,靠工具纪律封死)。
2. F1 的边界:`force_disconnect` 只对当前 bound 的 agent 生效;源机 slot 已死(`failed`)时它是 no-op,会话作废由 F2/F3 兜底——分层设计已覆盖,无需额外处理。

---

## 7. 数据丢失边界(用户可见的明示契约)

| 数据 | 迁移后 | 说明 |
|------|--------|------|
| agent 身份(UUID、name、displayName、inbox_id、头像) | 保留 | 服务端行不动 |
| 聊天、消息、参与关系 | 保留 | 服务端 |
| inbox 待投递消息 | 保留并在新机投递 | §5 |
| server 管理的 agent config(model、env、repos、skills) | 保留,新机自动拉取落地 | `agent_configs` |
| Context Tree | 保留(git 重新 clone) | |
| provider 会话 transcript(claude-code / codex 本地会话) | **丢失** | 所有 chat 的会话冷启动,agent 失去会话内记忆 |
| workspace 工作区(含源 repo **未提交/未 push 的改动**) | **丢失**(留在源机,不搬) | Web 确认对话框必须点名这一条 |
| `data/sessions/<name>.json` 会话映射 | 作废 | §6 fence |
| 飞行中的 turn(force 迁移时) | **丢失** | 非 force 被 working 检查挡住 |

---

## 8. 并发、故障与多实例

### 8.1 竞态清单

| 竞态 | 防线 |
|------|------|
| 两个 migrate 并发 | §5.3a 的 CAS UPDATE(WHERE 带旧 client_id + 旧 provider),只赢一个;"无变化则 400"保证新旧二元组必不同 |
| migrate 与首绑 claim 并发 | claim 是 `WHERE client_id IS NULL`,migrate 要求 `client_id = 旧值`;互斥,各自原子 |
| 旧 client 在 migrate 提交后 re-bind | bind 每次从 DB 重读 → `wrong_client`,现有机制,同时触发 F2 会话作废 |
| 旧 client 已 bind、migrate 后继续发帧 | 主防线:提交后立即 forceDisconnect(本实例)+ 跨实例广播(§8.2)。残余窗口内旧帧只污染 presence/会话状态,而这两者都已在事务里重置;广播到达后即断流。不追求逐帧查 DB(成本不值) |
| 目标 client 恰好持有同 agent 的旧 alias 且 daemon 在跑 | `agent:pinned` 增强路径(§6.1,含 `failed`/`idle` 态重启)+ F1–F3 会话作废 |
| migrate 事务提交后、通知发出前 server 崩溃 | DB 已是新 placement:旧 client 下次任何 bind 被拒(F2 兜底会话作废);目标 client 下次 `client:register` 收到 pinned backfill。通知只是加速,不承载正确性 |
| A→B→A 回迁且 A 全程离线 | F3(`updatedAt` 快照)兜底 |

### 8.2 多实例下线广播

`forceDisconnect` 是实例内存操作;源 client 的 WS 可能挂在另一个 server 实例上。沿用"PostgreSQL 是唯一通知后端"的架构规则:复用现有 pg NOTIFY notifier 基础设施,新增一个 `agent_placement` 频道,payload `{ agentId }`;每个实例订阅,收到后若本实例 `connectionManager` 里有该 agent 的绑定则执行 `forceDisconnect(agentId, "migrated")`。这与 inbox 唤醒同构,不引入新组件,也不需要任何持久化。(现有 `/disconnect`、suspend 端点存在同样的单实例盲区,本频道顺带修复它们——同一 handler,reason 参数化。)

### 8.3 目标 client 离线

允许。迁移即时生效(DB 层),agent 表现为 offline,`agent test` 端点如实报告;目标机上线注册时 pinned backfill 自动落地。Web 在目标 client `status: disconnected` 时提示但不阻止。

---

## 9. 权限与安全

- 发起者:通过 `requireAgentAccess(manage)` 的调用方(manager 本人或 org admin),**且**目标 client 归 manager 的 user 所有(§4.1)。
- 不新增 JWT scope / 路由类:Class C 现有约定覆盖;`http-path-conventions.md` 增补该端点条目。
- 留痕:结构化日志 + `otelRecordBody`(§3),无新表。
- 不引入任何跨 user 数据流:迁移不触碰凭据,`agent_configs` 加密负载(AES-256-GCM)读取路径不变。

---

## 10. 兼容性

| 组件 | 旧版本行为 |
|------|-----------|
| 旧 CLI(源机) | 不认识 `reason: "migrated"` → 当作普通 force_disconnect;re-bind 收 `wrong_client` 停止(F1 的会话作废退化到 F2/F3,不影响安全性) |
| 旧 CLI(目标机) | 新 alias 正常落地(`agent:pinned` 帧未变)。已存在 alias + provider 变化的场景需要新 CLI(旧 CLI 会以旧 provider bind → `runtime_provider_mismatch` 拒绝,状态可见、无损坏,升级 CLI 即恢复) |
| DB | 无 migration,可随任意版本回滚;回滚 server 后唯一残留是已迁移 agent 的新 pin(合法数据) |
| `agent-client-immutable.test.ts` | 更新:PATCH 不可变语义保留,新增"migrate 服务是唯一变更路径"的断言 |
| 文档 | `AGENTS.md` 架构规则句、`docs/cli-reference.md`、`docs/onboarding-guide.md`("permanently bound"措辞)、`docs/development/agent-workspace-state.md`(会话 registry 的 `updatedAt` 快照落盘)、`retireClient` 报错文案 |

---

## 11. 实施拆分

按依赖顺序,每步可独立 PR、独立测试:

1. **Shared + Server**:`migrateAgentRequestSchema`;`migrateAgent` 服务(CAS 事务 + 会话重置 + 前置校验)、`POST /agents/:uuid/migrate` 路由、`agent_placement` NOTIFY 频道与各实例订阅(顺带接入 `/disconnect` / suspend)。
2. **Client 运行时(全部被动,无新命令)**:F1(`reason: "migrated"` 处理 + 会话作废)、F2(`wrong_client` 触发作废)、F3(registry 记录 `updatedAt` 快照)、`handleAgentPinned` 的 provider 改写/`failed`/`idle` 态重启路径、daemon 收到 `migrated` 后的 `agent prune` 提示(§13-4 若采纳)。
3. **Web + 文档收尾**:Web 迁移入口(§4.3)、全部文档更新、`retireClient` 文案、旧测试更新。

风险最高的是第 1 步的竞态正确性和第 2 步的 pinned-handler 改造(它同时服务首绑与迁移两个场景)。没有任何一步动 DB 结构。

---

## 12. 测试计划(全量 use case)

按被测层分组;每条给出前置、动作、期望。标注 **[回归]** 的是现有行为的钉死用例,防止迁移改动破坏既有语义。

### A. migrate API 前置校验(server 单测,`agent-migrate.test.ts`)

| # | 场景 | 期望 |
|---|------|------|
| A1 | manager 本人迁移自己的 agent 到自己的另一台 client | 200,响应含新 clientId/runtimeProvider |
| A2 | org admin 迁移他人 agent,目标 client 归该 agent manager 的 user | 200 |
| A3 | org admin 迁移他人 agent,目标 client 归 **admin 自己**(非 manager)的 user | 400(防死 placement) |
| A4 | 普通 member 迁移他人的 agent(无 manage 权限) | 403 |
| A5 | agent 为 human 类型 | 400 |
| A6 | agent 已删除(status=deleted / uuid 不存在) | 404 |
| A7 | agent suspended | 400,文案提示先 reactivate |
| A8 | 目标 clientId 不存在 | 400 |
| A9 | 目标 client 的 `user_id` 为 NULL(legacy 行) | 400 |
| A10 | 目标 == 当前 (client, provider),完全无变化 | 400 |
| A11 | 仅换 provider(targetClientId == 当前 client,provider 不同) | 200 |
| A12 | 仅换 client(provider 省略 = 保持当前) | 200 |
| A13 | 同时换 client + provider | 200 |
| A14 | 目标 client capability 报告 provider `missing`/`error`,未 force | 400,文案与 createAgent 的 capability 报错一致 |
| A15 | 同 A14 但 `force: true` | 200 |
| A16 | 目标 client capability 为空(从未探测),未 force | 200(三态语义:unknown 放行)**[回归]** 与 `assertClientSupportsRuntimeProvider` 现有语义一致 |
| A17 | 存在 `runtime_state = 'working'` 的会话,未 force | 409 |
| A18 | 同 A17 但 `force: true` | 200 |
| A19 | agent 的 `client_id` 为 NULL(从未首绑) | 400(首绑走 PATCH/claim,migrate 只服务已有 placement;防止绕过首绑语义) |
| A20 | 请求体非法(未知 provider 值、缺 targetClientId) | 400(Zod) |

### B. 事务、CAS 与并发(server 单测)

| # | 场景 | 期望 |
|---|------|------|
| B1 | 两个并发 migrate,同旧值、不同目标 | 恰好一个 200;另一个 409;终态 = 赢者的目标 |
| B2 | 两个并发 migrate,同旧值、同目标 | 一个 200 一个 409(后者 CAS 落空);终态正确且只有一条审计日志成功路径 |
| B3 | migrate 与 WS 首绑 claim 并发(agent `client_id` 为 NULL) | migrate 被 A19 拒绝;claim 正常——两路径互斥 |
| B4 | migrate 提交后,携带旧值的第二次 migrate 请求 | 409(CAS WHERE 落空) |
| B5 | 事务内三个写(agents CAS、agent_chat_sessions 重置、presence 清空)原子性:CAS 落空时 | 会话/presence 均不被改动(整个事务回滚) |
| B6 | migrate 成功后 `agent_chat_sessions` 全部行 `runtime_state='idle'`、`runtime_state_at IS NULL` | 断言逐行 |
| B7 | migrate 成功后 `agent_presence` ephemeral 字段清空(status offline、client_id NULL、runtime 字段 reset) | 断言 |
| B8 | migrate 成功后 `agents.updated_at` 必然变化(F3 依赖) | 断言新旧不等 |

### C. PATCH 不可变语义(现有测试更新)**[回归]**

| # | 场景 | 期望 |
|---|------|------|
| C1 | PATCH `clientId` NULL → ID(首绑) | 200,推 `agent:pinned`(现有行为不变) |
| C2 | PATCH `clientId` ID → 另一 ID | 400,报错文案指向 migrate 端点(更新 `agent-client-immutable.test.ts`) |
| C3 | PATCH `clientId` ID → NULL | 400(不变) |
| C4 | migrate 服务是 `client_id` ID → ID 的唯一变更路径 | 断言(替换原"没有 move/re-bind 路径"的断言) |

### D. WS 集成:源/目标 在线×离线 四象限(server WS 集成测试)

| # | 源机 | 目标机 | 期望 |
|---|------|--------|------|
| D1 | 在线且 agent 已 bind | 在线 | 源收 `agent:force_disconnect {reason:"migrated"}`;目标收 `agent:pinned`(含正确 runtimeProvider);源随后 re-bind 收 `wrong_client` |
| D2 | 在线且 agent 已 bind | 离线 | 源同 D1;agent 进 offline;目标之后 `client:register` 时收到 pinned backfill,bind 成功 |
| D3 | 离线 | 在线 | 无 force_disconnect 可发(no-op,不报错);目标立即收 `agent:pinned`;源之后上线 bind 收 `wrong_client` |
| D4 | 离线 | 离线 | migrate 仍 200(DB 生效);双方之后各自上线:源被拒、目标 backfill 落地 |
| D5 | 源在线但该 agent 未 bind(slot 早已 failed) | 任意 | force_disconnect 对未 bound agent 是 no-op,migrate 正常完成 |
| D6 | migrate 后源机整个 daemon 重启 | — | 启动时 bind 收 `wrong_client`,slot `failed`,同机其他 agent 正常启动 **[回归]** |
| D7 | `agent test` 端点在 migrate 后、目标未上线时 | — | 如实报告 offline + 新 client 信息 |

### E. Inbox 连续性(server WS 集成测试)

| # | 场景 | 期望 |
|---|------|------|
| E1 | migrate 前有 `pending` 的 inbox 行 | 目标机 bind 后照常收到 `inbox:deliver` |
| E2 | 旧 client 收到 `inbox:deliver` 但未 ack 即被 migrate 踢下线(stuck `delivered`) | 目标机首次 bind 时恢复逻辑重置重投;消息不丢 |
| E3 | migrate 后向该 agent 发新消息(目标未上线) | 入队 pending;目标上线 bind 后投递 |
| E4 | 残余窗口:旧 client 在 force_disconnect 到达前发出 ack | ack 幂等处理,不破坏 inbox 状态机(at-least-once 语义)**[回归]** |
| E5 | 旧 client 在残余窗口发 `session:state`/`runtime:state` 帧 | 不使 agent 出现"双活"可见状态;广播到达后断流(允许短暂污染,B6/B7 的重置保证终态干净) |

### F. 客户端会话 fence(client/CLI 单测)

| # | 场景 | 期望 |
|---|------|------|
| F1-1 | 在线源机收 `force_disconnect(reason:"migrated")` | slot 停止;该 agent 本地会话映射立即作废;本地文件(workspace/config)不删 |
| F1-2 | 收 `force_disconnect` 但 reason 为其他值(`server_forced`/`agent_suspended`) | 不作废会话映射 **[回归]**(挂起/断连不该丢会话) |
| F2-1 | bind 收 `wrong_client` 拒绝 | 会话映射作废;slot 停止(现有行为)+ 作废是新增 |
| F2-2 | bind 收 `not_owned`/`runtime_provider_mismatch` 等其他拒绝 | **不**作废(只有 `wrong_client` 语义是"本机不是 placement") |
| F3-1 | 绑定成功后 registry 记录的 `updatedAt` 与 `sdk.register()` 返回不一致 | 先作废映射再更新记录,会话冷启动 |
| F3-2 | `updatedAt` 一致 | 映射保留,会话正常恢复 **[回归]** |
| F3-3 | registry 无 `updatedAt` 字段(旧版本文件升级) | 视为一致放行 + 补写字段(升级兼容,不误伤存量) |
| F4 | F1/F2 触发作废时 registry 文件写失败(磁盘/权限) | 不崩溃;日志告警;下次 F3 兜底 |

### G. `handleAgentPinned` 分支矩阵(CLI 单测)

现有分支 × 新增分支的全交叉:

| # | 本地状态 | pinned 帧内容 | 期望 |
|---|----------|--------------|------|
| G1 | 无该 agentId 的 alias | 新 agent | 写 `agent.yaml` + 启 slot **[回归]** |
| G2 | 无 alias 且本地名被**另一个** agent 占用 | 同名新 agent | `pickLocalName` 取后缀名,不覆盖已有目录 **[回归]** |
| G3 | 已有 alias,state=`running`,provider 相同 | 重复 pinned(如 backfill) | no-op **[回归]** |
| G4 | 已有 alias,state=`suspended-skipped` | reactivate 推送 | 重启 slot **[回归]** |
| G5 | 已有 alias,state=`failed`(迁走后被拒的终态) | 回迁 pinned | **重启 slot**(新增,A→B→A daemon 不重启场景) |
| G6 | 已有 alias,state=`idle`(被 migrated 踢停) | 原地换 provider 的 pinned | 改写 yaml `runtime` + 重启 slot(新增) |
| G7 | 已有 alias,provider 与帧不一致,state=`running` | 原地换 provider | 停旧 handler → 改写 yaml → 以新 handler 重启(新增) |
| G8 | agentsDir 未设置 / 写 yaml 失败 | 任意 | 告警不崩溃 **[回归]** |

### H. 源机残留惰性(CLI 单测)**[回归钉死]**

| # | 场景 | 期望 |
|---|------|------|
| H1 | daemon 启动含一个迁走的 alias + 一个健康 agent | 健康 agent 正常;迁走者一条 "connection failed";daemon 不退出 |
| H2 | WS 重连时迁走 alias 的 rebind | 退避重试、debug 级日志,不影响健康 agent |
| H3 | watcher 触发 rescan | 迁走 alias 不被重复添加 |
| H4 | `agent prune` | 迁走 alias 归类 `pinned-elsewhere`,删除时三件套一起删 |
| H5 | `doctor` | 报告 `pinned-elsewhere`,命令正常完成 |
| H6 | 新 agent 复用已被 prune 清理的名字 | 全新 workspace/session,无旧数据吸入 |

### I. 回迁与多跳(集成 / 端到端)

| # | 场景 | 期望 |
|---|------|------|
| I1 | A→B→A,A 的 daemon 全程在跑 | A 收两次信号(migrated 踢停 → 回迁 pinned);G5 路径复活;F1 已作废会话,冷启动 |
| I2 | A→B→A,A 全程离线,期间从未跑 daemon | A 上线后 bind 成功;F3(`updatedAt`)捕获变更,会话作废 |
| I3 | A→B→A,A 在 B 阶段跑过 daemon(bind 被拒过) | F2 已作废;回迁后 G5 复活,冷启动 |
| I4 | A→B→C 连续两跳 | 每跳独立正确;B 残留惰性(H 组);C 正常落地 |
| I5 | 快速连续两次 migrate(第二次在源机还没收到第一次通知时发起) | 第二次携带新读到的旧值 → 200;或携带过期值 → 409;终态唯一 |

### J. 多实例(server 集成,双实例拓扑)

| # | 场景 | 期望 |
|---|------|------|
| J1 | 源 client WS 挂在实例 2,migrate 请求打到实例 1 | 实例 2 经 `agent_placement` NOTIFY 收到广播并 force_disconnect |
| J2 | migrate 提交后、NOTIFY 消费前实例 2 崩溃重启 | 源 client 重连任一实例,bind 被拒(F2)——通知丢失不破坏不变量 |
| J3 | `/disconnect`、suspend 走同一广播频道(顺带修复项) | 跨实例生效,reason 正确 |

### K. 版本兼容(集成)

| # | 场景 | 期望 |
|---|------|------|
| K1 | 旧 CLI 源机收 `reason:"migrated"` | 当作普通 force_disconnect 停 slot;re-bind 被拒;无崩溃(F1 作废退化到 F2/F3) |
| K2 | 旧 CLI 目标机收新 agent 的 `agent:pinned` | 正常落地(帧结构未变) |
| K3 | 旧 CLI 目标机,已有 alias + provider 变化 | 以旧 provider bind → `runtime_provider_mismatch` 永久跳过 + 一条 warn;状态可见、无损坏;升级 CLI 后恢复 |
| K4 | server 回滚到无 migrate 版本 | 已迁移 agent 的新 pin 是合法数据,R-RUN 正常;无 schema 依赖 |

### L. Web 迁移入口(web 单测 / 组件测试)

| # | 场景 | 期望 |
|---|------|------|
| L1 | 目标 computer 选择器数据源 | 只列该 agent manager user 的 clients(不含其他成员的机器,与 §4.1 鉴权一致) |
| L2 | 确认对话框文案 | 完整复述 §7 数据丢失清单,**点名"未提交/未 push 改动会丢"** |
| L3 | 目标 client `status: disconnected` | 提示但不阻止提交 |
| L4 | 服务端各错误码(400/403/404/409) | 映射为可读文案;409-working 提示等待或勾选 force 重试 |
| L5 | 无变化提交(目标 == 当前) | 前端预校验禁用提交按钮(后端 400 兜底) |
| L6 | 迁移成功 | 详情页立即反映新 placement(client + provider),presence 显示 offline 直至目标机 bind |

### M. 周边非回归 **[回归]**

| # | 场景 | 期望 |
|---|------|------|
| M1 | `retireClient` 在有 agent pin 时 | 仍拒绝,文案改为提示先 migrate |
| M2 | migrate 全部 agent 后 retireClient | 成功 |
| M3 | 成员离开的 agent 转移路径(`clientId: null` + fallback manager) | 不受影响;转移后 agent 可被新 manager 用 PATCH 首绑(非 migrate,A19) |
| M4 | `GET /me/pinned-agents` | migrate 后反映新 clientId |
| M5 | Web agent 详情 / computers 列表 | 显示新 placement;无缓存串台 |

### 端到端手测脚本(发布前)

1. A→B(双在线)全流程:消息续投、目标冷启动回复成功;
2. B→A 回迁(I1、I2 两变体);
3. A 原地 claude-code → codex;
4. 目标离线迁移 + 上线 backfill;
5. force 迁移一个 working 中的 agent,确认飞行 turn 丢弃后系统状态干净。

---

## 13. 未决问题

1. **迁移频控**:是否需要限制迁移频率(如冷却时间)防止误操作抖动?v1 倾向不做,靠确认交互兜底。
2. **suspended agent**:v1 拒绝迁移 suspended agent(§4.1)。若运维反馈"想把挂起的 agent 挪到新机再启用"是高频诉求,可放开为"允许迁移但不推 pinned,reactivate 时再推"。
3. **F3 误伤收窄**:`updatedAt` 快照会把无关 agent 编辑也当成迁移信号(多付一次会话冷启动,方向安全)。若要精确,需要服务端可观察的 placement 变更计数,那就回到"加列"——v1 明确不做,先验证误伤频率是否真实成为问题。
4. **源机自动清理**:是否在源 CLI 收到 `migrated` 时主动提示一条 `agent prune` 建议?倾向做(纯提示,不自动删)。
