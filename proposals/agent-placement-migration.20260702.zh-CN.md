---
title: "提案:Agent 在 computer / runtime provider 间的受控迁移(零 DB 变更)"
soft_links:
  - docs/development/http-path-conventions.md
  - docs/development/agent-workspace-state.md
  - docs/cli-reference.md
---

# 提案:Agent 在 computer / runtime provider 间的受控迁移

**日期:** 2026-07-02
**状态:** 提案阶段(修订 v2:去掉 placement_id / 审计表,零 DB 变更)
**范围:** `packages/server`(service / API / WS,无 schema 变更)、`packages/shared`(仅请求 DTO)、`packages/client` + `apps/cli`(运行时与命令)、`packages/web`(管理入口)、相关文档与测试。

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
| agent suspended | 400(先 reactivate;suspend 状态下迁移没有意义,`agent:pinned` 对 suspended agent 也不会启动 slot) |
| 目标 client 不存在 / 不归 manager 的 user | 400 |
| 目标 == 当前 (client, provider),无变化 | 400(幂等噪音直接拒绝,防误操作;该前置同时是 §6 CAS 可靠性的前提) |
| 目标 client capability 显示 provider 不可用 | 400,`force: true` 可跳过(复用 `assertClientSupportsRuntimeProvider` 的三态语义) |
| 存在 `runtime_state = working` 的会话且未 `force` | 409,提示等待或 force |
| CAS 失败(并发迁移撞车) | 409,调用方重读重试 |

### 4.2 PATCH `/api/v1/agents/:uuid` 不变

`clientId` 保持一次性 NULL → ID。理由:PATCH 是通用更新面,迁移是带副作用(强制下线、会话重置)的操作,混进 PATCH 会让"改个 displayName 顺手把 agent 迁走"成为可能。service 层的 immutable 报错信息更新为指向 migrate 端点。

### 4.3 CLI

```
first-tree agent migrate <name-or-uuid> --to-client <clientId> [--provider <p>] [--force] [--yes]
```

- 业务逻辑放 `apps/cli/src/core/agent-migrate.ts`,命令层薄封装(仓库惯例);
- 交互式确认必须复述数据丢失边界(§7 的清单),`--yes` 跳过;
- `first-tree computers`(已有 `/me/clients`)辅助用户找 targetClientId。

### 4.4 Web

Agent 详情页(admin/manager 视角)加 "Migrate" 操作:选择目标 computer(来自该 manager user 的 clients 列表)+ provider 下拉,展示与 CLI 相同的数据丢失警告。v1 可以只做 CLI,Web 作为紧随的增量。

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
| workspace 工作区(含源 repo **未提交/未 push 的改动**) | **丢失**(留在源机,不搬) | CLI 确认文案必须点名这一条 |
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

允许。迁移即时生效(DB 层),agent 表现为 offline,`agent test` 端点如实报告;目标机上线注册时 pinned backfill 自动落地。CLI 在目标 client `status: disconnected` 时提示但不阻止。

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
2. **Client + CLI**:F1(`reason: "migrated"` 处理 + 会话作废)、F2(`wrong_client` 触发作废)、F3(registry 记录 `updatedAt` 快照)、`handleAgentPinned` 的 provider 改写/重启路径、`first-tree agent migrate` 命令(core + command + 确认文案)。
3. **Web + 文档收尾**:Web 迁移入口、全部文档更新、`retireClient` 文案、旧测试更新。

风险最高的是第 1 步的竞态正确性和第 2 步的 pinned-handler 改造(它同时服务首绑与迁移两个场景)。没有任何一步动 DB 结构。

---

## 12. 测试计划

- **Server 单测**:migrate 服务全部前置校验矩阵;CAS 并发(两个 migrate、migrate vs 首绑 claim);会话 runtime_state 重置;force 语义(capability 跳过、working 跳过);无变化请求 400。
- **WS 集成**:旧 client bind → migrate → 旧 client 收 force_disconnect、re-bind 收 `wrong_client`;目标 client 收 `agent:pinned`;bind 后 stuck-`delivered` inbox 恢复到新机。
- **CLI 单测**:pinned handler 的分支矩阵(新 alias / 同 alias 同 provider / 同 alias 换 provider × `failed`/`idle`/`suspended-skipped` 态重启);F1/F2/F3 三条作废路径(含 A→B→A 回迁模拟,daemon 不重启);源机残留 alias 的惰性行为(bind 拒绝后不影响其他 agent、watcher 不重加);prune 对迁走 alias 的 `pinned-elsewhere` 归类(已有测试,验证不回归)。
- **端到端手测脚本**:A→B、B→A 回迁(验证 F3)、A 原地换 provider、目标离线迁移 + 上线 backfill。

---

## 13. 未决问题

1. **迁移频控**:是否需要限制迁移频率(如冷却时间)防止误操作抖动?v1 倾向不做,靠确认交互兜底。
2. **suspended agent**:v1 拒绝迁移 suspended agent(§4.1)。若运维反馈"想把挂起的 agent 挪到新机再启用"是高频诉求,可放开为"允许迁移但不推 pinned,reactivate 时再推"。
3. **F3 误伤收窄**:`updatedAt` 快照会把无关 agent 编辑也当成迁移信号(多付一次会话冷启动,方向安全)。若要精确,需要服务端可观察的 placement 变更计数,那就回到"加列"——v1 明确不做,先验证误伤频率是否真实成为问题。
4. **源机自动清理**:是否在源 CLI 收到 `migrated` 时主动提示一条 `agent prune` 建议?倾向做(纯提示,不自动删)。
