# Connection 与 Identity 关系收束 — 设计文档

**状态:** 草稿 v3.1 — 基于 `origin/main@f7b00b4` 实测重审。**全程零 schema 改动**:`clients.organization_id` 列保留,仅在代码层切断所有读路径。范围拆分为 4 个串行 PR(§8)。
**意图:** Client connection 重新定义为"机器/工作目录"级实体。Connection 与 organization 之间没有任何运行时关系 — 不在 session 上携带 org、不缓存 org 集合、不参与切 org 流程;一份本地安装在生命周期内同时只持有一个 user 的活动 session,运行时鉴权完全沿 `agents → manager → user` 链路实时校验;切 user 必须经显式确认。
**关系澄清:** 同名/同主题前作 [decouple-client-from-org-design-zh.md](./decouple-client-from-org-design-zh.md) 提议 drop `clients.organization_id` 但**未合入** main(实测 `clients.organization_id` 仍为 NOT NULL + FK)。本设计**不**接管 drop — 列保留为 vestigial 标记,产品演进中如有需要再单独 PR 处理;同时撤回前作 Q7(`session:org_changed` 推帧),理由见 §2.2。
**对齐:** Context Tree `agent-hub/NODE.md` 中 *"Client = a connection entity representing one SDK process"*。

> 英文权威版:待补;以英文版为最终落地依据。

> ⚠️ **v3 关键修正(相对 v2)**
> 1. `clients.organization_id` 列保留 — PR-A **不**做 DROP COLUMN,只在代码层切断读路径;`registerClient` 仍把入参 `organizationId` 写入(NOT NULL 约束被迫填值),所有读路径切换为基于 `clients.user_id` 单字段。读路径切净后该列即为 vestigial,可由独立 follow-up PR 自行决定何时 drop。
> 2. `agents` 表无 `manager_user_id` denormalized 列 — 所有 owner 维度查询统一走 `agents.manager_id → members.id → members.user_id` JOIN/sub-query。
> 3. `/auth/switch-org` 退化不是单点改动 — 当前 web 端依赖 endpoint 返回新 token + `adoptTokens`(`packages/web/src/components/user-menu.tsx:65`、`auth-context.tsx`),退化必须配套设计前端默认视图存储与 `/me` 默认 org 选择;归到 PR-C。
> 4. Admin 路由没有统一的 org context 入口(当前 `/admin/clients`、`/admin/agents` 都直接读 `scope.organizationId`)— "改为 HTTP 显式声明 org" 需要先定路径 / header 约定;归到 PR-D。
> 5. `agent listing` 语义二分:**(a) "我可见的 org roster"** 仍由 `agentVisibilityCondition` 持有 same-org + roster 语义,**(b) "我管理的 agents"** 才是跨 org 的、由 `manager.userId === jwt.userId` 限定 — 旧 v2 把两者混作一谈。

---

## 1. 背景

`clients` 表自始绑用户、绑组织。前作 *decouple-client-from-org* 提出 drop `organization_id`,但**实测尚未合入 main**(`clients.organizationId` 仍 NOT NULL + FK,`registerClient`/`assertClientOwner`/`listClients`/`listMyPinnedAgents`/`inferWizardStep` 均依赖该列;详见 §4.10.1)。本设计取一条 schema 零改动的轻路径 — **代码层切断所有 organization_id 读路径,列暂留**;新建行仍写入 organization_id(用 JWT default org claim 作 placeholder)以满足 NOT NULL,但 server 不再据此做任何鉴权或过滤判断。在此基础上澄清剩余两条语义:

1. **同一份本地安装(同一 clientId、同一工作目录)能否被多个 user 复用?** — 共享开发机、CI、演示机的常见场景。
2. **同一时刻同一 connection 上能否持有多个 (user, org) 上下文?** — 例如 user 在 org A 与 org B 都是 member,希望两边的 agent 都直接可用。

回答之前先确认协议层与数据层的事实。读代码(详见 [§ 附录 A](#附录-a--代码事实摘录))后:

| 既有事实 | 含义 |
|---|---|
| WS frame 已以 **agentId 为路由 key**,身份不出现在帧上;agent 的 (user, org) 由 `agents.managerId` / `agents.organizationId` 在 DB 层权威 | 协议层不需要 sessionId 字段;connection 与 org 解耦无 wire 改动 |
| R-RUN 已是 **per-bind 校验 + 后续 frame 走 in-memory `boundAgents` map** | bind 通过后 agent-scoped 帧不再回 DB;connection 与 org 解耦的 R-RUN 改动只在 bind 入口 |
| inbox NOTIFY 已是 **per-inboxId(per-agent)订阅** | 与 connection / user / org 维度都无关 |
| `agent_presence` 不需要 user/org 列 — agent 自身已携带权威 (user, org) | schema 零改动 |
| JWT 编码 `(sub=userId, memberId, organizationId, role)`,但 server 在 handshake 阶段从 `members` 表反查 organizationId 作权威,JWT 的 org claim 仅为 hint | server 可以彻底忽略 JWT 的 org/role/memberId,只读 sub;JWT 颁发流程无需改动 |
| `agent:bind` 已 JOIN `agents → members` 拿到 manager.userId([ws-client.ts:553-557](packages/server/src/api/agent/ws-client.ts:553))且**已**校验 `agent.managerUserId === session.userId`([ws-client.ts:581/597](packages/server/src/api/agent/ws-client.ts:581));bind 路径上 *尚未* 校验 `members.status` 也 *尚未* 解除 `agent.organizationId === session.organizationId` 同 org 限制([ws-client.ts:565](packages/server/src/api/agent/ws-client.ts:565)) | 改动 = 加 `members.status='active'` 列到 SELECT + 把 line 565 的 org 同等校验删除;manager 链路本身已就位 |

这些事实把方案空间收到一个明确判断:**connection 完全不需要持有任何 org 维度信息,运行时鉴权改由 agent → manager → user 的实时链路承载;反之"多 user 共活"代价大但需求模糊。**

---

## 2. 决策

**Per-user 单活;Per-org 共活,无切换动作。**

| 维度 | 决策 |
|---|---|
| 同 connection 同时持多 user | **禁止** |
| 同 connection 在生命周期内换 user | **允许,必须经 `client claim --confirm` 显式接管** |
| 同 connection 同时持多 org | **N/A** — connection 不携带任何 org 信息;agent 的 org 归属由 `agent.managerId → members.(userId, organizationId)` 链路承载,bind 时通过 join 实时校验 |
| 同 connection 在生命周期内"切 org" | **不存在该动作** — connection 与 org 完全无关;Web 端 `/auth/switch-org` 退化为前端默认视图调整器,不驱动 backend session |
| `clients.user_id` | **NOT NULL,运行时鉴权依据** |
| `clients.organization_id` | **列保留 + 切断读路径**(PR-A 改 6 个消费点;新行 INSERT 时仍写入 JWT default org claim 作 placeholder 满足 NOT NULL,但 server 不再据此做鉴权/过滤;详见 §4.1 / §4.10.1)|

### 2.1 为什么走"connection 与 org 完全解耦"

| 论据 | 引文 |
|---|---|
| WS frame 以 agentId 为 routing key,同 socket 上前后两条 frame 操作不同 org 的 agent 在协议层无障碍 | [ws-client.ts:66-70](packages/server/src/api/agent/ws-client.ts:66) |
| `agent:bind` 已 JOIN `agents → members` 拿 manager.userId,把 R-RUN 从 `agent.organizationId === session.organizationId` 改为 `manager.userId === jwt.userId AND manager.status='active'` 是同一 query 内的改动 | [ws-client.ts:540-619](packages/server/src/api/agent/ws-client.ts:540) |
| `agent_presence` / `notifier` / `connection-manager` 全部以 agentId/inboxId 为 key,与 user/org 维度无关 | [agent-presence.ts](packages/server/src/db/schema/agent-presence.ts);[notifier.ts:115](packages/server/src/services/notifier.ts:115);[connection-manager.ts:145-154](packages/server/src/services/connection-manager.ts:145) |
| JWT 仍按 (user, member, org) 颁发即可 — server 完全忽略 JWT 的 org/memberId/role 三个 claim,只读 sub(userId) | [auth.ts:44-58](packages/server/src/services/auth.ts:44);[ws-client.ts:107-115](packages/server/src/api/agent/ws-client.ts:107) |
| `agent:pinned` backfill 以 clientId 查 agents,client 是 user-owned,backfill 自然覆盖该 user 名下所有 org 的 agent — 不需按 org 过滤 | [client.ts:160-171](packages/server/src/services/client.ts:160) |

用户最初痛点"切 org 不应重连"在本决策下完全消失 — 不只切换免重连,根本不存在切换。

### 2.2 为什么撤回上一篇的 `session:org_changed` 推帧

上一篇 Q7 推荐"切 org 时 server 通过 WS 推 `session:org_changed` 让 CLI 无感切换"。该方案隐含了 *socket session 持有 org 状态* 的前提 — 必须有"解绑旧 org agent、重绑新 org agent"的状态迁移。本设计中 connection 与 org 完全解耦:

- session 不持任何 org 信息,**没有需要切的动作**。
- 旧 org 的 agent 不需要解绑。
- 推帧带来的复杂度(WS 协议演进、CLI 端 partial reconnect、presence 抖动窗口)被消除。

撤回该项是 net 简化。

### 2.3 为什么不走"多 user 共活"

| 复杂点 | 影响 |
|---|---|
| `auth` 帧从 single-shot 扩为可重复 / 新增 `session:open` 帧 | 协议演进,需长期兼容 |
| `auth:expired` timer 从 socket 级变 per-user 级 | 多个独立的 refresh 周期 |
| logout / token 撤销 = 按 `agent.managerUserId` 维度的 partial unbind | 新代码路径;`boundAgents` map 不能整体清空 |
| `agent:pinned` backfill 必须按当前 socket 持有的 user 集合过滤 | 真实 metadata 泄漏点(Bob 的 socket 看到 Alice 的 agent 名)|
| `credentials.json` 单 JWT → 多 JWT 模型 | 客户端配置层重写;泄漏面扩大(N 个 user 凭证) |
| 资源用量 1× → N× | 一进程同时跑 N 个 user 的 agent 工作集,容量预算需重算 |
| CLI 焦点身份歧义 | `agent create` / `agent list` 默认作用在哪个身份 |

v1 不背。

---

## 3. 非目标

- **不**让一个 agent 跨 user / 跨 org 共享 — agents 仍单 user × 单 org 归属(agent.managerId 唯一)。
- **不**让一份 `~/.first-tree/hub/` 同时持有两个不同 user 的活动 session。
- **不**重写 JWT 颁发流程 — JWT 仍按 (user, member, org) 颁发以向后兼容;server WS handshake 不再读 JWT 的 org/memberId/role claim,只读 sub(userId)。
- **不**追求"同机多工作目录"自动协同 — 多工作目录视为多 client(每个目录有独立 clientId)。

---

## 4. 设计要点

### 4.1 数据层

| 改动 | 说明 |
|---|---|
| `clients.organization_id` | **列保留**(NOT NULL + FK + index 不动);**所有读路径切断**(PR-A);新行 INSERT 时仍写入(JWT default org claim 作 placeholder 满足 NOT NULL),但 server 后续不再据此做任何鉴权/过滤判断 — 进入 vestigial 状态。彻底 drop 留给独立 follow-up PR。|
| `clients.user_id` | 仍 NOT NULL;**运行时鉴权唯一依据** |
| `agent_presence` | **不变** — agent.organizationId / managerId 已是权威,无需新增 user/org 列 |
| `agents` 表 | **不变** — owner 维度查询统一走 `agents.manager_id → members.id → members.user_id` 的 JOIN/sub-query;**不**引入 denormalized `manager_user_id` 列(避免双写一致性 + 与 §4.4 claim 事务的写放大)|

**本设计不引入新表,也不改动任何现有 schema。** owner 切换事件通过 server 应用日志(结构化 log:`{event: "client.owner_transfer", clientId, fromUserId, toUserId, ts}`)覆盖,不在 DB 持久化。理由:转 owner 是低频运维事件,事后追溯走日志聚合(已有的 OTel/log 收集)足够,新增一张表反而增加 schema 维护与回滚面。如果未来产品需要"who used this machine when"的查询面板,再单独引入。

#### 4.1.1 Vestigial 列的写入与不变量(PR-A)

`clients.organization_id` 是 NOT NULL + FK,server 不能停止写入。设计选择:

| 路径 | 行为 |
|---|---|
| `registerClient` 新行 INSERT | 仍接受 `organizationId` 入参(来源:WS handshake 阶段从 JWT `organizationId` claim 读取,JWT 已携带,无需额外 DB 查询);写入 placeholder。**不再校验** `existing.organizationId !== data.organizationId`(原 `ClientOrgMismatchError` 路径删除)|
| `registerClient` 已存在行 UPDATE(`onConflictDoUpdate`) | 不再 set `organizationId`(让旧值保留,避免 placeholder 在 user 多 org 场景下漂移)|
| 所有读路径(`assertClientOwner`、`listClients`、`listMyPinnedAgents`、`inferWizardStep`) | **不再读 `clients.organization_id`** — 全部按 `clients.user_id` 单条件过滤 |

**不变量:** PR-A 合入后,`grep -r "clients.organizationId\|clients.organization_id" packages/server/src/{services,api}` 在非 schema 文件中应只剩 `registerClient` 的 INSERT 写入路径;读路径 zero matches。

**未来彻底 drop 的 follow-up PR:** 列上无 server 读取后,可通过单独 PR 走 (a) ALTER COLUMN DROP NOT NULL → (b) registerClient 也停止写入 → (c) DROP COLUMN 三步走;本设计不绑这条路径。

### 4.2 WS handshake 简化

`AuthenticatedSession` 类型剥离所有 org 维度字段:

| 字段 | 旧 | 新 |
|---|---|---|
| `userId` | string | string(不变,唯一保留)|
| `memberId` | string | **删除** |
| `organizationId` | string | **删除** |
| `role` | string | **删除**(admin 路由实时查,见 §4.5)|

handshake 流程([ws-client.ts:380-458](packages/server/src/api/agent/ws-client.ts:380))调整:

1. JWT verify 成功后,从 `users` 表确认 active([ws-client.ts:407-414](packages/server/src/api/agent/ws-client.ts:407)) — 不变。
2. **不再**查 `members` 表;**不再**预加载任何 org 集合。session 在 socket 上只持 `userId`。
3. 校验 `clients.user_id === jwt.userId`,不一致 → `CLIENT_USER_MISMATCH`。
4. JWT 中的 `organizationId` claim 被忽略(可作日志使用,不参与任何运行时判断)。

**核心原则:** connection 与 org 之间没有任何缓存、集合、引用关系。任何"该 user 在哪些 org 中"的判断推迟到 bind / 查询面,且每次实时查 `members` 表。

### 4.3 R-RUN 不变量(实施验收基线)

> 1. **WS handshake:** `clients.user_id === jwt.userId`;不一致返回 `CLIENT_USER_MISMATCH`(WS close 4403)。
> 2. **`agent:bind`:** 三条同时成立 ——
>    a. `agent.managerUserId === jwt.userId`(经 `agents → members` 已有的 JOIN 拿到)
>    b. **`members.status === 'active'`**(同 JOIN;manager 所在 membership 必须仍活跃)
>    c. `agent.clientId === clients.id`(对已 pin 的 agent)**或** `agent.clientId IS NULL`(首次 pin)
> 3. **后续 frame:** 依赖 in-memory `boundAgents` map,不复查 DB([ws-client.ts:619](packages/server/src/api/agent/ws-client.ts:619))。
> 4. **Admin 路由 role 检查:** 每次实时 `SELECT role FROM members WHERE user_id = jwt.userId AND organization_id = <HTTP 请求声明的 org> AND status='active'` — JWT 中的 role 与 organizationId 都不可信(见 §4.5)。

**`agent.organizationId` 在 R-RUN 中不再被读取。** 该字段仍存在并被查询面/日志使用(列出"我在 org A 的 agent"),但不参与 bind 鉴权。"该 user 是否仍在 agent 所属 org 内"的判断由 §4.3.2.b 的 manager.status 隐式完成 — agent.managerId 指向的 member 行记录了 `(userId, organizationId)`,只要该 member 仍 active 即可。被踢出 org 时,member.status 改 inactive,bind 即拒。

### 4.4 切 user 流程

入站 JWT 的 user_id ≠ `clients.user_id` 时:

| # | 动作 |
|---|---|
| 1 | server 抛 `CLIENT_USER_MISMATCH`,WS close 4403 |
| 2 | CLI 收到关闭码 → 输出 *"This client is currently owned by alice@example.com. Run `first-tree-hub client claim --confirm` to transfer ownership. This will unpin Alice's N agents from this machine."* |
| 3 | 用户跑 `first-tree-hub client claim --confirm`(交互式二次确认 — 显示当前 owner、新 owner、被解绑 agent 列表与计数)→ 调 `POST /clients/:id/claim` |
| 4 | server 在单事务内执行(注意:`agents` 表无 `manager_user_id` 列,通过 `members` join 解出):`UPDATE clients SET user_id = ?` ; `UPDATE agents SET client_id = NULL WHERE client_id = ? AND manager_id IN (SELECT id FROM members WHERE user_id = $oldOwnerId)` ; `UPDATE agent_presence SET status='offline', client_id = NULL, runtime_state=NULL, … WHERE client_id = ?`;事务提交后写一条结构化 log(`event: client.owner_transfer`)|
| 5 | CLI 重连 WS handshake → 通过 |

旧 agent.managerId 仍指向旧 owner;agent 暂时不在任何 client 上跑,等旧 owner 在另一台机器上重新 pin。

`client claim` 不提供 `--force` — 必须经过交互式 prompt;CI 场景需要预先以正确身份 connect。

### 4.5 角色检查改实时查(归到 PR-D)

**前置阻塞:** 当前 admin 路由没有显式的 org context 入口 — `/admin/clients`([api/admin/clients.ts:18](packages/server/src/api/admin/clients.ts:18))、`/admin/agents`([api/admin/agents.ts:138](packages/server/src/api/admin/agents.ts:138)) 等都直接读 `scope.organizationId`(来自 JWT `memberId` 默认 member 行)。改"以 HTTP 显式声明 org"不是单点替换,需要先定 org context 来源约定。

**当前架构:** `memberAuthHook`([middleware/member-auth.ts:9-68](packages/server/src/middleware/member-auth.ts:9))从 JWT 中读 `memberId`,查 `members` 表填充 `request.member = { userId, memberId, organizationId, role, agentId }`。`memberScope(request)`([services/access-control.ts:45-53](packages/server/src/services/access-control.ts:45))再把 `request.member` 包成 `MemberScope`,几乎所有 HTTP 路由层鉴权都基于该 scope。

**问题:** `MemberScope.organizationId / role` 都来自 jwt.memberId 指向的 *单一 member 行* — 即"jwt 颁发时 default org 下的 role"。同 user 在其他 org 的 role 完全不在 scope 中。多 org 共活下,这变成跨 org admin 越权的根源。

**改造路径(PR-D 单独承担):**

| 步骤 | 动作 |
|---|---|
| 1 | **定义 admin 路由 org context 来源约定** — 候选(择一):**(α)** path 参数 `/admin/orgs/:orgId/clients`、`/admin/orgs/:orgId/agents/...`(REST 风格,但所有现有 admin 路径要 rename,break web 调用方);**(β)** HTTP header `X-Organization-Id`(无 path 改造,但靠 header 易漏);**(γ)** request body / query `organizationId` 必填(列表/读路径放 query,写路径放 body)。**推荐 (γ)**:对现有 web 调用面破坏最小,Zod schema 可直接覆盖。 |
| 2 | `memberAuthHook` 保留,继续填 `request.member`;字段意义降级为"JWT 颁发时的 default member context",仅供 web 端默认视图与历史路由使用 |
| 3 | 新增 helper `requireMemberInOrg(request, orgId)` — 实时查 `members WHERE user_id=jwt.userId AND organization_id=orgId AND status='active'`,返回 `{ memberId, role }`;查不到抛 403 |
| 4 | 所有 admin 路由按 §4.10.1 清单把 `scope.role === "admin"` 检查替换为 `requireMemberInOrg(request, query.organizationId)`(假设走 (γ)) |
| 5 | listing 路由的过滤改造统一在 PR-D 内做 — 详见 §4.5.1 |

**为什么不直接删 memberAuthHook?** Web 端的非 admin 路由(如 `/me/agents`、`/me/chats`)默认视图仍然需要"用户当前关注的 org",这是 UX 约定不是安全约束。`request.member` 字段保留,但所有承重的鉴权决策必须经 step 3-4 路径,JWT 的 role 与 organizationId claim **永远不直接读**。

**漏一处即跨 org admin 越权**(同 user 在 org A 是 admin、在 org B 是 member,持 default = org A 的 JWT 操作 org B 的 admin 路由)。PR review checklist 强制标记;PR-D 实施前必须基于当时的 main HEAD 重新做 §4.10.1 的精确扫描清单。

#### 4.5.1 Agent listing 语义二分(PR-D)

v2 把两个独立概念混作一谈。v3 拆开:

| 语义 | 用例 | 实现 |
|---|---|---|
| **(a) 我可见的 org roster** | Web `/admin/agents` 列表(同 org 同事)、`agentVisibilityCondition`、`assertAgentVisible` | **保留 same-org + (organization-visible OR managerId=self) 语义。** 改造点仅在于 `scope.organizationId` 不再来自 JWT default 而是来自 HTTP 显式声明的 org(同 §4.5 step 1)。 |
| **(b) 我管理的 agents(跨 org)** | CLI `agent list`(默认列出 user 全 active org 自管 agent)、claim 流程显示待 unpin 列表 | **新 helper** `listAgentsManagedByUser(db, userId)` — 用 `agents JOIN members ON agents.manager_id = members.id WHERE members.user_id = $userId AND members.status = 'active'`;CLI 加 `--org <id>` flag 在客户端再过滤(server 不需要新 endpoint,跨 org 列表本来就不该传给 web — UX 约定 web 端永远只展示当前选中 org 的 roster)。 |

**关键:** `agentVisibilityCondition` 不改变 same-org 含义(否则破坏现有 roster UX:你不会期望 org A 的 admin 在 listAgents 看到 org B 的 agent)。这与 v2 §4.10.3 "改 helper 为 user 全 active org IN 条件"是错的,v3 撤回。

### 4.6 `/auth/switch-org` 退化(归到 PR-C)

**当前现状(实测):**
- Server `POST /auth/switch-org`([api/me.ts:219-245](packages/server/src/api/me.ts:219))**重新签发 token** — 调 `signTokensForMember` 返回新 JWT(`memberId`/`organizationId`/`role` claim 都变)。
- Web `user-menu.tsx:65` 收到新 token 后调 `adoptTokens`,然后 `auth-context.tsx` 从 `/me` 重读 `organizationId`/`memberId`/`role` 刷新 UI。

**v2 简单写"不再签发新 JWT 即可"是错的** — web 端 auth state(`AuthContext.organizationId / memberId / role`)目前完全跟 JWT claim 走,不签新 token 就没有更新机制。

**v3 的退化方案(PR-C 一次性完成):**

| 步骤 | 动作 |
|---|---|
| 1 | 引入"前端选中 org"独立存储 — `localStorage` 键 `firstTreeHub.selectedOrganizationId`(不进 cookie,以免被 server 误读;web only 状态)|
| 2 | `AuthContext` 改为:`organizationId / memberId / role` 从 `selectedOrganizationId` + `/me` 返回的 `memberships` 列表派生(currentMembership = memberships.find(m => m.organizationId === selectedOrganizationId));不再从 JWT claim 派生 |
| 3 | `POST /auth/switch-org` 实现层简化为:**校验 user 在 target org 是 active member 即返回 204**,不再签发 token;web 端在 `switchOrg` handler 里更新 `localStorage` + 触发 `/me` 重拉 |
| 4 | `signTokensForMember` 与 `auth.ts` 仍按 (user, member, org) 颁发 JWT(handshake 时 server 只读 sub,JWT 内 memberId/organizationId/role claim 是历史 hint,server 不再依赖它们做鉴权)|
| 5 | `memberAuthHook` 保留为 web 默认视图 fallback — 当请求未在 query/body 显式声明 org 时,fallback 到 JWT memberId 指向的 default member。承重的 admin gate 不走该 fallback(走 §4.5 的 `requireMemberInOrg`)|

**端点保留 + 行为变更:** 调用面不变(还是 POST `/auth/switch-org` body `{organizationId}`),返回值从 `{accessToken, refreshToken}` 改为 `204 No Content`;**web 端必须同 PR 升级**(否则 `adoptTokens(undefined)` 会出错)。

**WS session 不受影响:** 不推任何 WS 帧,WS 上 bound 的 agent 不变。

**回滚预案:** revert PR-C 即可恢复 token 重发模型;migration 无 schema 改动。

### 4.7 配置文件拆分

| 文件 | 内容 | 谁拥有 | 何时改 |
|---|---|---|---|
| `client.yaml` | clientId、client_secret、server URL | 机器(工作目录)| `client connect` 一次性写入,生命周期不动 |
| `credentials.json` | 当前 user 的 access + refresh JWT(单一)| 用户 | 每次 login / logout |

切 org 不动文件(JWT 不变,session 一开始就覆盖所有 org)。切 user 等价于 logout + login + 必要时 `client claim --confirm`。

### 4.8 Membership 撤销的及时性

User 被踢出 org B(`members.status` 改 `inactive`)后:

| 场景 | 行为 |
|---|---|
| Alice 已 bound 的 org B agent X | 仍在 in-memory `boundAgents` 中工作,直到 unbind 或 socket 关 — **本 PR 不主动撤** |
| Alice 新尝试 `agent:bind` org B 的 agent Y | `agent:bind` 处的 `agents → members` JOIN 返回 `manager.status = 'inactive'` → R-RUN §4.3.2.b 不通过 → 拒绝 |

主动 force-unbind 在线 agent 的能力可作 follow-up PR(admin 路径推 `agent:force_disconnect`,已存在),本设计不引入。

### 4.9 迁移路径(分 PR 串行)

**全程 schema 零改动。** PR 拆分:

| PR | 范围 | schema | 风险 |
|---|---|---|---|
| **PR-A** | 切断 `clients.organization_id` 所有读路径(§4.10.1 6 处);新行 INSERT 仍写 placeholder 但删除 `ClientOrgMismatchError` 校验路径;`assertClientOwner` 删 admin 跨 user 兜底 | 无 | 低 — 纯代码,语义收紧而非扩张 |
| **PR-B** | (1) WS handshake `AuthenticatedSession` 简化为只 `userId`;(2) `agent:bind` 加 `members.status='active'` 校验 + 删除 `agent.organizationId === session.organizationId` 同 org 限制;(3) `registerClient` user 不一致改抛 `ClientUserMismatchError`;(4) `claimClient` service + `POST /clients/:id/claim`;(5) CLI `client claim --confirm` + mismatch 引导 | 无 | 中 — claim 事务必须原子;agent:bind 改造范围已在 §4.10.2 列出 |
| **PR-C** | `/auth/switch-org` 退化(server 改 204、web AuthContext 改 localStorage 派生);**server + web 必须同 PR 升级** | 无 | 中 — web auth state 重写,有视觉/路由回归风险 |
| **PR-D** | (1) 定义 admin org context 来源约定((γ) query/body `organizationId`);(2) `requireMemberInOrg` helper;(3) §4.10.3 4 处 admin gate 重写;(4) §4.5.1 listing 二分(`agentVisibilityCondition` 接受显式 orgId 入参,新 `listAgentsManagedByUser` helper);(5) CLI `agent --org <id>` flag | 无 | 高 — 漏一处即跨 org admin 越权;PR 实施前重新扫一遍 main HEAD 的调用面 |

**串行依赖:**
- PR-A 必须先合(把读路径切干净,PR-B 的 `agent:bind` / handshake 简化不再被 `clients.organization_id` 牵扯)
- PR-B 不依赖 PR-C/D;但 PR-D 依赖 PR-A(admin gate 与 listing 都建立在 client 读路径不再绑 org 的语义上)
- PR-C 与 PR-B/D 都独立(web 端 auth state 改造与 backend 鉴权改造可并行)

**回滚:**
- PR-A:纯 revert,无 schema 副作用;列与数据未动
- PR-B:revert handshake 简化 + claim API/CLI;无 schema 副作用
- PR-C:revert `/auth/switch-org` server 改动 + web auth state 改动 → 行为回到 token 重发模型
- PR-D:**已上线后 revert 会重新引入跨 org admin 越权窗口**,优先 forward-fix

**Vestigial 列彻底 drop(可选 follow-up):** PR-A/B/C/D 全部合入后,`clients.organization_id` 仅在 `registerClient` INSERT 时写 placeholder,无任何读取。如产品决策要清理,单独 PR 走 ALTER COLUMN DROP NOT NULL → 停止写入 → DROP COLUMN 三步,与本设计解耦。

### 4.10 实施前承重项核对(基于 `origin/main@f7b00b4` 实测)

#### 4.10.1 PR-A:`clients.organization_id` 读路径切断点清单(**6 处,schema 不动**)

| 文件 | 当前行为 | 改造方向 |
|---|---|---|
| [db/schema/clients.ts:13-15, 41](packages/server/src/db/schema/clients.ts:13) | `organizationId` NOT NULL + FK + `idx_clients_org` | **保留不变** — 列继续作为写入路径的载体,后续可由独立 follow-up PR 决定何时彻底 drop |
| [services/client.ts:69-128 `registerClient`](packages/server/src/services/client.ts:69) | 入参含 `organizationId`,line 89 校验 `existing.organizationId !== data.organizationId` 抛 `ClientOrgMismatchError`,line 106/107 INSERT 写入,line 117 onConflictDoUpdate 也 set | **保留入参** + 保留 INSERT 写入(满足 NOT NULL,值来源 = handshake 阶段从 JWT `organizationId` claim 读取,作 placeholder);**删除 line 89 校验**(`ClientOrgMismatchError` 路径整段删,既然不再校验)+ **从 onConflictDoUpdate 的 set 中删除 `organizationId`**(避免已存在行被新 placeholder 覆盖)|
| [services/client.ts:28-54 `assertClientOwner`](packages/server/src/services/client.ts:28) | line 41 `row.organizationId !== scope.organizationId` 抛 404;line 45 admin 跨 user 兜底依赖 org | scope 入参删 `organizationId`;**采用选项 A — 直接删除 admin 跨 user 兜底**,只保留 `row.userId === scope.userId` 检查 |
| [services/client.ts:178-204 `listMyPinnedAgents`](packages/server/src/services/client.ts:178) | scope `{userId, organizationId}`,JOIN `clients` 后 `eq(clients.organizationId, scope.organizationId)` | scope 删 `organizationId`;过滤改为 `eq(clients.userId, scope.userId)` 单条 |
| [services/client.ts:246-284 `listClients`](packages/server/src/services/client.ts:246) | admin 路径走 `eq(clients.organizationId, scope.organizationId)`;member 路径同时过滤 user + org | admin 路径在 PR-A 暂改为 `eq(clients.userId, scope.userId)`(等同 member,admin 跨 user 列表能力随选项 A 一并暂弃);member 路径 drop org 过滤;待 PR-D 重写 admin 跨 user 列表语义 |
| [api/admin/clients.ts:18-49](packages/server/src/api/admin/clients.ts:18) | `GET /clients`、`GET /clients/me/agents` 把 `scope.organizationId` 传 service | 入参精简,跟 service 同步删 |
| [api/me.ts:260-269 `inferWizardStep`](packages/server/src/api/me.ts:260) | `where(and(eq(clients.userId, m.userId), eq(clients.organizationId, m.organizationId)))` 判该 user 在 org 是否有 client | 改为 `eq(clients.userId, m.userId)` 单条;含义从"该 user 在该 org 有 client"变为"该 user 任何 org 有 client",对 wizard 含义影响:多 org user 在第二 org 上看到的 onboarding 阶段会从"connect"直接跳过 — 验收时与 PM 对齐(本变化与"connection 与 org 完全无关"一致,接受)|

**WS handshake 调用方:** PR-A 内 `ws-client.ts` 调 `registerClient` 时仍把 `session.organizationId`(此时 session 仍持 org)传入作 placeholder;PR-B 把 session 简化为只 `userId` 后,改为直接从 JWT `organizationId` claim 读取传入。

**不变量验证:** PR-A 合入后 `grep -r "clients\.organizationId\|clients\.organization_id" packages/server/src/{services,api,middleware}` 应只剩 `registerClient` INSERT 路径上的写入;读取 zero matches。**该 grep 作为 PR-A 的 PR review checklist 项。**

#### 4.10.2 PR-B:`agent:bind` 与 `AuthenticatedSession` 改造点

| 文件 | 行 | 当前 | 改造 |
|---|---|---|---|
| [api/agent/ws-client.ts AuthenticatedSession 类型](packages/server/src/api/agent/ws-client.ts) | ~107-115 | `{userId, memberId, organizationId, role}` | `{userId}` 单字段 |
| [ws-client.ts handshake](packages/server/src/api/agent/ws-client.ts) | ~380-458 | JWT verify + 查 members 表填 session | 仅 JWT verify;不再查 members |
| [ws-client.ts:565](packages/server/src/api/agent/ws-client.ts:565) | `if (agent.organizationId !== session.organizationId)` 抛 WRONG_ORG | **删除该分支** — 跨 org 同 user 自由 bind |
| [ws-client.ts:542-558 SELECT](packages/server/src/api/agent/ws-client.ts:542) | 已 SELECT `members.userId` AS `managerUserId` | 加 SELECT `members.status` AS `managerMemberStatus` |
| [ws-client.ts:580-600 R-RUN](packages/server/src/api/agent/ws-client.ts:580) | 校验 `managerUserId === session.userId`、`clientUserId === session.userId` | 同时加 `managerMemberStatus === 'active'`;不通过抛新 reject reason `MEMBERSHIP_INACTIVE`(或复用 `NOT_OWNED`)|
| [ws-client.ts handshake](packages/server/src/api/agent/ws-client.ts) | `register` handler client.userId 校验路径 | 不一致改抛 `ClientUserMismatchError`(WS close 4403);CLI 端解析见 §4.4 |

**新错误类:** `errors.ts` 加 `ClientUserMismatchError`(参照现有 `ClientOrgMismatchError`、`NotFoundError` 类的 constructor / code / httpStatus 模式)。

**新 service:** `claimClient(db, clientId, newUserId, oldUserId)` — 单事务,见 §4.4 SQL。

**新路由:** `POST /clients/:clientId/claim`(member-scoped,body 可空;调用方 jwt.userId 即新 owner;旧 owner 从 `clients.user_id` 当前值读出)。考虑放在 `api/admin/clients.ts` 或新增 `api/clients.ts`(member 路径,与 admin 隔离);倾向后者。

#### 4.10.3 PR-D:admin gate 与 listing 改造点(实施前重新扫 main HEAD)

| 文件 | 行 | 用途 | 改造方向 |
|---|---|---|---|
| [services/access-control.ts:149](packages/server/src/services/access-control.ts:149) | `assertCanManage` 中 admin 跳过 visibility 限制 | 改用 `requireMemberInOrg(request, agent.organizationId).role === "admin"` |
| [services/client.ts:45](packages/server/src/services/client.ts:45)(若 PR-A 已删则 N/A) | admin 跨 user 兜底 | PR-A 已选项 A 删除;PR-D 不需再处理 |
| [services/client.ts:248](packages/server/src/services/client.ts:248) | `listClients` admin 看全 org | 重写为"列出 caller 在其 admin org 内 member 名下的所有 client"(JOIN members)|
| [api/admin/agents.ts:142](packages/server/src/api/admin/agents.ts:142) | `scope.role === "admin"` ? `body.managerId` : `scope.memberId` | 用 `requireMemberInOrg(request, body.organizationId).role` |
| [api/admin/ws-admin.ts:51, 108, 116](packages/server/src/api/admin/ws-admin.ts:51) | admin WS 用 `payload.organizationId` 限定 admin 视图 | 帧上显式声明 `organizationId`,server `requireMemberInOrg` 实时校验 |
| [services/access-control.ts:65 `agentVisibilityCondition`](packages/server/src/services/access-control.ts:65) | `eq(agents.organizationId, scope.organizationId)` | 保留 same-org 语义;`scope.organizationId` 来源改为 HTTP 显式声明(query/body)而非 JWT default;**不改为跨 org IN** |
| 新增 helper | — | `listAgentsManagedByUser(db, userId)` 用于 CLI `agent list` 跨 org 视图(§4.5.1 表格 (b))|

PR-D 实施前必须基于当时的 main HEAD 重新扫一遍 — 上述行号 8 周后大概率漂移。

#### 4.10.4 Client SDK 对 4403 的现有行为(**已天然兼容,加测试断言即可**)

[client-connection.ts:420-450](packages/client/src/client-connection.ts:420) 的 close handler:

- 注册阶段 `this.registered = false`;`client:registered` 帧到达后才设 true([client-connection.ts:540](packages/client/src/client-connection.ts:540))。
- `CLIENT_USER_MISMATCH` 在 server 端 `client:register` handler 抛出,server 发 `client:register:rejected` 后 `socket.close(4403, ...)`,此时 client SDK 尚未收到 `client:registered`,`wasRegistered=false`。
- close handler 中 `if (wasRegistered) this.scheduleReconnect()` — `wasRegistered=false` → **不进 reconnect 分支**,直接 reject 当前 connect promise。

**结论:** 4403 触发的 SDK 行为已是"一次性失败,不重连",符合本设计需求。**但必须新增测试断言**,因为 reconnect 行为绑定在 `wasRegistered` 与 `settled` 两个状态机上,改 SDK 时容易回归。

#### 4.10.5 与 main 上 #201/#202/#203 的兼容性(**全部兼容,无冲突**)

| PR | 影响 | 与本设计的兼容性 |
|---|---|---|
| [#201](https://github.com/agent-team-foundation/first-tree-hub/pull/201) topbar disconnect chip + new-connection modal | `pages/clients/new-connection-dialog.tsx:73` 用 `c.userId === user.id` 判 success;`hooks/use-disconnected-computers.ts:18-20` 同样过滤 | **完全对齐** — 本设计 `clients.user_id NOT NULL` 与之一致;切 user 后 disconnect-chip 自然消失(`c.userId !== oldUser.id`),良性 UX |
| [#202](https://github.com/agent-team-foundation/first-tree-hub/pull/202) mention_only 防回环 | 新 migration `0029`,改 messaging 路径 | 本设计 4 个 PR 全部 schema 零改动,无 migration 编号冲突;mention_only 与 R-RUN 路径无关 |
| [#203](https://github.com/agent-team-foundation/first-tree-hub/pull/203) onboarding single-card flow | 仅 web 改动 | 不影响(PR-C 改 web auth state 时单独 review) |

---

## 5. 影响面

### 5.1 文件清单(实现 PR 时再定位行号)

**Server(按 PR 归类):**

PR-A(纯代码,无 schema):
- [packages/server/src/services/client.ts](packages/server/src/services/client.ts) — `registerClient` 删 `ClientOrgMismatchError` 校验路径 + 从 onConflictDoUpdate 删除 `organizationId` set;`assertClientOwner` 删 org 校验 + 删 admin 跨 user 兜底;`listMyPinnedAgents` / `listClients` 切换为 `clients.userId` 单字段过滤
- [packages/server/src/api/admin/clients.ts](packages/server/src/api/admin/clients.ts) — service 调用面同步精简(删 `scope.organizationId` 入参)
- [packages/server/src/api/me.ts](packages/server/src/api/me.ts) — `inferWizardStep` 删 org 过滤

PR-B:
- [packages/server/src/api/agent/ws-client.ts](packages/server/src/api/agent/ws-client.ts) — `AuthenticatedSession` → `{userId}`;`agent:bind` 删 line 565 org 校验 + 加 `members.status='active'`;register handler 改抛 `ClientUserMismatchError`
- [packages/server/src/services/client.ts](packages/server/src/services/client.ts) — `registerClient` user 不一致改抛 `ClientUserMismatchError`;新增 `claimClient`(单事务)
- 新文件 [packages/server/src/api/clients.ts](packages/server/src/api/clients.ts) — `POST /:clientId/claim`(member-scoped)
- [packages/server/src/errors.ts](packages/server/src/errors.ts) — 新 `ClientUserMismatchError`

PR-C:
- [packages/server/src/api/me.ts](packages/server/src/api/me.ts) — `/auth/switch-org` 改返 204,不再 `signTokensForMember`

PR-D:
- [packages/server/src/services/access-control.ts](packages/server/src/services/access-control.ts) — `agentVisibilityCondition` 接受显式 orgId 入参(保留 same-org 语义);新增 `requireMemberInOrg`、`listAgentsManagedByUser` helper;`assertCanManage` 改用 `requireMemberInOrg`
- [packages/server/src/middleware/member-auth.ts](packages/server/src/middleware/member-auth.ts) — 保留(不删),字段意义降级为 web 默认视图 fallback
- [packages/server/src/api/admin/agents.ts](packages/server/src/api/admin/agents.ts) — admin gate 改 `requireMemberInOrg`
- [packages/server/src/api/admin/ws-admin.ts](packages/server/src/api/admin/ws-admin.ts) — admin WS 帧上显式声明 `organizationId` + admin 角色实时查
- [packages/server/src/services/client.ts](packages/server/src/services/client.ts) — `listClients` admin 重写为"caller admin org 内 member 名下 client"(JOIN members)

**Web(PR-C):**
- [packages/web/src/auth/auth-context.tsx](packages/web/src/auth/auth-context.tsx) — `organizationId / memberId / role` 改从 `selectedOrganizationId` + `/me memberships` 派生
- [packages/web/src/components/user-menu.tsx](packages/web/src/components/user-menu.tsx) — `switchOrg` 删 `adoptTokens`,改写 `localStorage` + 触发 `/me` 重拉

**Client SDK(PR-B):**
- [packages/client/src/client-connection.ts](packages/client/src/client-connection.ts) — 解析 `CLIENT_USER_MISMATCH` 关闭码,投递结构化错误给 CLI

**CLI(PR-B + PR-D):**
- [packages/command/src/commands/client.ts](packages/command/src/commands/client.ts)(PR-B)— 新增 `claim` 子命令;`connect` / `client start` 在收到 mismatch 错误时输出引导
- `packages/command/src/commands/agent.ts`(PR-D)— `--org` flag 与默认行为调整

**测试:**
- 见 §7。

**文档:**
- [docs/decouple-client-from-org-design-zh.md](docs/decouple-client-from-org-design-zh.md) — 头部加 *"Q7(`session:org_changed` 推帧)在后续 [Connection 与 Identity 关系收束](decouple-client-from-identity-design-zh.md) 设计中撤回"*
- [AGENTS.md](AGENTS.md) — "Unified user-JWT auth" 段落改为 *"socket 上覆盖该 user 全部 active org;切 user 经 `client claim` 显式确认"*
- [docs/cli-reference.md](docs/cli-reference.md) — `client claim`、`agent --org` 文档化
- Context Tree `agent-hub/client-runtime.md`、`agent-hub/claim-agent.md` 同步语义

### 5.2 风险等级

| 层级 | 风险 | 归属 PR |
|---|---|---|
| DB schema | **无改动** — `clients.organization_id` 列保留 vestigial(详见 §4.1) | — |
| `clients.organization_id` 读路径切断 | 低 — 6 处 grep-able 改造点 | PR-A |
| `registerClient` 入参 / 错误码改造 | 低 | PR-A → PR-B |
| WS handshake 类型简化 | 低 | PR-B |
| `agent:bind` 校验改 manager 链路 | 低 — 跨 user 防线由 manager.userId / clients.userId 检查保护;manager.status 检查覆盖 membership 撤销 | PR-B |
| `claimClient` service 单事务(JOIN members) | **中** — 转 owner + bulk unpin 必须事务一致 | PR-B |
| `/auth/switch-org` 退化 + web `AuthContext` 重写 | **中** — web auth state 来源切换有视觉/路由回归风险 | PR-C |
| Agent listing 二分(同 org roster vs 跨 org managed) | 中 — 语义切分需要 PM 对齐;CLI `agent list` 默认行为变化 | PR-D |
| Admin role 实时查迁移 | **中→高** — 漏一处即跨 org admin 越权 | PR-D |
| CLI `client claim` UX | 低 | PR-B |

---

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| **claim 误操作 — 输错命令导致他人失去 client** | 必须交互式二次确认;不提供 `--force`;显示当前 owner、新 owner、待解绑 agent 列表与计数 |
| **claim 时旧 agent unpin 中断** | `claimClient` 单事务完成 update + bulk unpin + presence reset,失败回滚;事务提交后再写日志,日志失败不影响主路径 |
| **`agent:bind` 校验路径改造时漏掉某分支** | 跨 user 防线(`agent.managerUserId === jwt.userId` 与 `clients.user_id === jwt.userId`)不变;bind 路径只剩三条原子检查,容易完整审计 |
| **`jwt.role === "admin"` / `jwt.organizationId` 调用点遗漏** | §4.10 已扫出精确清单(承重 4 处 admin gate + 1 处 admin WS);PR review checklist 强制标记;新增集成测试覆盖跨 org admin 越权 |
| **SDK 收 4403 后无限重连(成为攻击向量)** | §4.10.4 验证当前 SDK 行为天然不重连;新增显式测试断言 `scheduleReconnect` 未被调用,防 SDK 状态机改动时回归 |
| **`agentVisibilityCondition` 改造影响多个 listing** | v3 改造仅是 `scope.organizationId` 来源切换(从 JWT 派生 → HTTP 显式声明),保持 same-org + roster 语义不变;集成测试覆盖跨 user 隔离(同 org Bob 不能 list Alice 的 private agent)|
| **Membership 撤销与 in-memory bind 的窗口** | bind 时通过 `agents → members` JOIN 拿 manager.status 实时校验,无 in-memory 缓存;已 bound 的 agent 主动 force-unbind 留作 follow-up |
| **JWT 跨机器泄漏** | R-RUN 中的 `clients.user_id === jwt.userId` 检查对该场景边际拦截;基线仍依赖 token 撤销与短 TTL refresh |
| **claim API 缺乏速率限制 — 暴力试错 owner 转移** | 路由层加 per-(client_id) 速率限制;基于结构化 log `event: client.owner_transfer` 设告警("一台机器同小时多次 owner 转移") |
| **共享机上 `client_secret` 可被同机其他 user 读取** | 接受 — 与 claim 流程互补:secret 是机器层凭证,owner 转移由 JWT + 显式确认 + 结构化日志覆盖,不依赖文件权限 |

回滚预案见 §4.9 串行依赖与回滚段落 — 4 个 PR 全部纯代码改动,revert 无 schema 副作用;PR-D 已上线后 revert 会重新引入跨 org admin 越权窗口,优先 forward-fix。

---

## 7. 测试计划

1. `pnpm check && pnpm typecheck` 通过。
2. 现有 Vitest 套件通过。
3. 新增集成测试:
   - **多 org 同 socket 并行 bind:** Alice 在 org A 与 org B 都是 member,WS 已连;同 socket 上 `agent:bind` org A 的 agent 成功 → 紧接 `agent:bind` org B 的 agent 也成功;两个 agent 的 inbox NOTIFY、session:state、runtime:state 各自独立工作互不干扰;调 `/auth/switch-org` 后两 agent 都仍 bound。
   - **切 user 默认拒绝:** Alice 的 `client.yaml` + Bob 的 JWT → handshake 收 `CLIENT_USER_MISMATCH`;CLI stderr 含 claim 引导文本。
   - **显式 claim 接管:** `client claim --confirm` → 200 → handshake 通过 → DB:`clients.user_id = Bob`,Alice 名下所有 agent 在 `agents.client_id` 与 `agent_presence.client_id` 都为 NULL,presence offline;server 日志含一行 `event: client.owner_transfer { clientId, fromUserId: Alice, toUserId: Bob, ts }`。
   - **claim 后 Alice 重连被拒:** Alice 的 JWT → `CLIENT_USER_MISMATCH`(owner 已是 Bob)。
   - **claim 反向:** Alice 重新 `client claim --confirm` → owner 改回 Alice;Bob 名下 agent 全 unpin;Alice 之前的 agent 仍 NULL,需要手动重 pin。
   - **Membership 撤销立即生效:** Alice 持 (org A, org B) 双 membership,bind org A agent 成功;Alice 被踢出 org B(`members.status='inactive'`)后,新的 `agent:bind` org B agent 拒(`agents → members` JOIN 见 manager.status='inactive')。
   - **跨 org admin 越权拦截:** Alice 是 org A admin、org B member;向 admin API 路径携带 org B 上下文(如 `/admin/orgs/<orgB>/...`)→ admin gate 实时查 `members WHERE (Alice, orgB)` 见 role='member' → 拒。
   - **`/auth/switch-org` 不影响 socket:** 调用前后 socket 上 bound 的 agent 列表完全相同;不收到任何 server 推帧;`/auth/switch-org` 仅刷新前端默认视图,不影响 backend 任何运行时判断。
   - **`CLIENT_USER_MISMATCH` (4403) 不触发 SDK 重连:** Bob 持自己的 JWT 连 Alice 的 `client.yaml` → server 关 4403 → client SDK 抛错并退出连接 promise;**显式断言 `scheduleReconnect` 未被调用**(可通过 spy / counter 验证)。这是承重断言,防止 SDK 的 `wasRegistered/settled` 状态机改动时回归引入对 4403 的无限重连(成为针对 server 的攻击向量)。
   - **`agentVisibilityCondition` 改造后跨 user 隔离仍成立:** Alice 在 org A、Bob 在 org A,Bob `agent list` 不返回 Alice 名下任何 agent(即使两人在同 org);保护机制是 `agents.managerId === scope.memberId` 或 visibility=organization 的双条件未被改坏。
4. 手动场景演练:见 [§ 附录 B](#附录-b--典型场景对照)。
5. 威胁建模:跨 user 防线由 `agent.managerUserId === session.userId` 与 `clients.user_id === jwt.userId` 双重保护;跨 org 范围扩大限定在该 user 自身的 active membership 内,**不引入新跨 user 攻击面**。

---

## 8. 推进顺序(4 个串行 PR)

1. **设计对齐** — 与相关方对齐 *"per-user 单活;connection 与 org 完全解耦;`clients.organization_id` 列暂留 vestigial 不做 DROP"* 决策,以及 §4.5 admin org context 来源走 (γ) query/body `organizationId`。前作 design doc 头部加 *"未合入 main;本设计取代 — `clients.organization_id` 暂不 drop,只切代码层读路径"* 备注。
2. **PR-A — 切断 `clients.organization_id` 读路径(承重前置;无 schema 改动)**
   - §4.10.1 6 个消费点改造(读路径全切;`registerClient` 仍 INSERT 写 placeholder 但删 `ClientOrgMismatchError` 校验 + 删 onConflictDoUpdate 中的 `organizationId` set)
   - `assertClientOwner` 选项 A:删 org 校验 + 删 admin 跨 user 兜底
   - `listClients` admin 路径暂改"列出 caller 自己的 client"(等同 member);admin 跨 user 列表能力暂弃,PR-D 重写
   - PR review checklist:`grep -r "clients\.organizationId\|clients\.organization_id" packages/server/src/{services,api,middleware}` 仅命中 `registerClient` INSERT 一处
3. **PR-B — agent:bind multi-org + claim API + CLI**
   - WS handshake `AuthenticatedSession` → `{userId}`
   - `agent:bind` SELECT 加 `members.status`,删 line 565 `agent.organizationId === session.organizationId` 校验,加 `members.status='active'` 检查
   - `errors.ts` 新 `ClientUserMismatchError`;`registerClient` user 不一致改抛它;WS close 4403
   - `claimClient` service(单事务,SQL 见 §4.4)+ `POST /clients/:clientId/claim` 路由
   - CLI `client claim --confirm` + WS close 4403 解析与引导文本
   - 新增集成测试:多 org 同 socket 并行 bind、切 user 拒绝、claim 接管、claim 反向、membership 撤销 bind 拒绝、4403 不触发 SDK 重连
4. **PR-C — `/auth/switch-org` 退化(server + web 同 PR)**
   - server `POST /auth/switch-org` 返 204 + 改 schema
   - web `AuthContext` 重写为 `localStorage` + `/me memberships` 派生
   - `user-menu.tsx` 删 `adoptTokens` 路径
   - 测试:web 端切 org 不影响已建立的 WS;切 org 后 admin 视图按 selected org 渲染
5. **PR-D — Admin role 实时查 + listing 二分**
   - 定 admin org context 来源约定 ((γ) query/body `organizationId`)
   - `requireMemberInOrg` helper
   - 4 处 admin gate + 1 处 admin WS payload(§4.10.3)
   - `agentVisibilityCondition` 接受显式 orgId 入参
   - 新 `listAgentsManagedByUser`;CLI `agent list` 改用之 + `--org` flag
   - 集成测试:跨 org admin 越权拦截;listing 二分覆盖
6. **文档更新**(每个 PR 自带,合入 main 后整体)— `AGENTS.md`、`docs/cli-reference.md`、Context Tree `agent-hub/client-runtime.md` / `agent-hub/claim-agent.md`

建议分支命名:
- PR-A:`refactor/decommission-clients-org-reads`(读路径切断,无 schema)
- PR-B:`feat/client-claim-and-multi-org`(claim + multi-org 主功能;沿用当前 worktree 分支)
- PR-C:`refactor/web-auth-state-localstorage`
- PR-D:`feat/admin-realtime-role-check`

---

## 附录 A — 代码事实摘录

第一稿讨论"多用户 / 多组织共活方案的复杂性"时,部分论据基于对协议层与数据层的预设,实际看代码后这些预设大多不成立。修正如下:

| 第一稿假设 | 真实情况 | 引文 |
|---|---|---|
| WS 帧需要新增 sessionId 字段才能多活 | 已经以 agentId 为 frame routing key,身份不在帧上 | [ws-client.ts:66-70](packages/server/src/api/agent/ws-client.ts:66);[connection-manager.ts:145-154](packages/server/src/services/connection-manager.ts:145) |
| R-RUN 在多活下退化为 per-frame DB 鉴权 | 已经是 per-bind 校验 + 后续 frame 走 in-memory `boundAgents` map | [ws-client.ts:540-619](packages/server/src/api/agent/ws-client.ts:540) |
| inbox NOTIFY 多路复用复杂、按 client_id 切片 | NOTIFY 订阅本来就是 per-inboxId(per-agent),与 client/user 维度无关 | [notifier.ts:115](packages/server/src/services/notifier.ts:115);[ws-client.ts:627](packages/server/src/api/agent/ws-client.ts:627) |
| `agent_presence` 需要新增 `active_user_id` / `active_organization_id` 列 | 不需要 — agent.organizationId / managerId 是权威 | [agent-presence.ts:6-33](packages/server/src/db/schema/agent-presence.ts:6) |
| 跨 session 误推帧造成 metadata 泄漏 | 推帧路径以 agentId 为权威(`agentToClient` map),不依赖 session | [connection-manager.ts:145-154](packages/server/src/services/connection-manager.ts:145) |
| JWT 必须改成 user-only 才能 connection 与 org 解耦 | JWT 仍按 (user, member, org) 颁发即可;server 完全忽略 org/memberId/role claim,只读 sub | [auth.ts:44-58](packages/server/src/services/auth.ts:44);[ws-client.ts:107-115](packages/server/src/api/agent/ws-client.ts:107) |
| socket session 必须持有"该 user 在哪些 org" 集合才能 R-RUN | 不需要;`agent:bind` 已 JOIN `agents → members`,manager.userId / manager.status 在同一 query 内即可校验 | [ws-client.ts:553-557](packages/server/src/api/agent/ws-client.ts:553) |

修正后的判断:**connection 与 org 完全解耦在协议层、数据层、运行时都几乎零代价**;真正的复杂性集中在 "多 user 共活"(socket 持多 auth、partial unbind、`agent:pinned` backfill 按 user 过滤、credentials 多 JWT、CLI UX、资源用量)。本设计取 per-user 单活 — 用最小代价覆盖最大份额诉求。

---

## 附录 B — 典型场景对照

### B.1 多 org 用户(本设计:无切换动作)

Alice 在 org A 与 org B 都是 member。机器 M 上一份 `client.yaml`:

| # | 动作 |
|---|---|
| 1 | Alice `hub login` → 拿到 JWT(JWT 里有 organizationId claim,但 server 不读)|
| 2 | Client WS handshake;server 只校验 `clients.user_id === jwt.userId`;session 只持 `{ userId: Alice }`,完全不查 / 不缓存 org 信息 |
| 3 | Alice 在 CLI 上 `agent list` → API 走 `agents JOIN members WHERE manager.userId = Alice AND member.status='active'`,自然返回 org A + org B 的所有 agent |
| 4 | Alice 任意 `agent:bind` org A 或 org B 的 agent — server 通过 `agents → members` JOIN 校验 `manager.userId === Alice AND manager.status='active'` 即通过 |
| 5 | Web 上 Alice 点 "switch to org B" → `/auth/switch-org` 仅刷新前端默认视图;**server 不推任何 WS 帧;CLI 上 bound 的 agent 不受影响** |

对比上一篇:上一篇 design 让 server 推 `session:org_changed` 帧驱动 CLI 解绑/重绑。本设计不再需要 — connection 跟 org 完全无关。

### B.2 共享开发机

Alice 跑了一阵子;Bob 想用同一台机器:

| # | 动作 |
|---|---|
| 1 | Alice `hub logout`(可选)|
| 2 | Bob `hub login` → 得 Bob 的 JWT |
| 3 | Client WS handshake → `CLIENT_USER_MISMATCH` |
| 4 | CLI 输出 *"This client is owned by alice@example.com. Run `first-tree-hub client claim --confirm` to transfer. This will unpin Alice's 3 agents from this machine."* |
| 5 | Bob 跑 `client claim --confirm` → 二次确认 → owner 切换 + Alice 名下 3 agent 全 unpin;server 日志记录 `event: client.owner_transfer` 一行 |
| 6 | Bob 重连成功;Bob 在多 org 中也自动覆盖 |

### B.3 Alice 反向 claim 回来

Bob 用完后 Alice 回到机器 M:`client claim --confirm` → owner 改回 Alice。Bob 期间 pin 的 agent 一并 unpin;Alice 之前的 agent 仍是 NULL(在 Bob 那次 claim 时已 unpin),需要 Alice 重新 `agent add` 或 Web 上重新 pin。

### B.4 CI / 演示机

机器 M 是无人值守 CI:

| # | 动作 |
|---|---|
| 1 | CI 启动 → 注入 service-account JWT |
| 2 | `client connect`(若首次) → 生成 `client.yaml`,owner = service-account |
| 3 | 跑 agent → 任务完成 |
| 4 | 可选 `hub logout`;`client.yaml` 留存 |

下次同 service-account 进来 handshake 通过;若换 service-account 触发 `CLIENT_USER_MISMATCH`,CI 脚本里显式 `client claim --confirm`(脚本场景虽接受 prompt 风险但仍要求显式参数,无静默接管路径)。

### B.5 Alice 被踢出 org B

Alice 在 org A、org B 都是 member,WS 上 bound 了 org B 的 agent X:

| # | 动作 |
|---|---|
| 1 | Admin 在 org B 把 Alice 踢出(`members.status` 改 `inactive`) |
| 2 | Alice 之前已 bound 的 agent X 仍在 in-memory `boundAgents` 中工作,直到 unbind 或 socket 关 |
| 3 | Alice 想新 bind org B 的 agent Y → server 通过 `agents → members` JOIN 见 `manager.status='inactive'` → 拒 |
| 4 | (follow-up)admin 路径推 force-unbind 让在线 agent X 也立即下线 |

### B.6 跨 org admin 越权(攻击者视角)

Alice 是 org A admin、org B member,持 JWT(JWT 内 organizationId 与 role claim 都不可信):

| # | 动作 |
|---|---|
| 1 | Alice 向 admin API 发请求,**HTTP 路径 / body 显式声明 org B 上下文**(如 `POST /admin/orgs/<orgB>/...`)|
| 2 | Server admin gate **不**读 JWT 的 role 与 organizationId,只读 jwt.userId,实时查 `members WHERE user_id=Alice AND organization_id=<HTTP 声明的 orgB> AND status='active'` → role = "member" |
| 3 | 拒绝 |

如果 Step 2 漏掉(用 jwt.role 判断),Alice 越权操作 org B。这就是 §4.5 的承重点。注意 org 上下文不来自 JWT 也不来自 WS session,只来自 HTTP 请求显式声明。

---

## 附录 C — 与前作 design 的差异速览

| 维度 | decouple-client-from-org(前作,**未合入**) | 本设计 |
|---|---|---|
| `clients.organization_id` | 提议 drop(未合入) | **列保留 vestigial,代码层切断读路径**;PR-A 不做 DROP COLUMN,follow-up PR 自行决定何时彻底 drop |
| `clients.user_id` | 保留 | **保留并强化 NOT NULL** |
| R-RUN 不变量 | `agent.organizationId === session.organizationId AND client.userId === jwt.userId` | `agent.managerUserId === jwt.userId AND member.status='active' AND clients.user_id === jwt.userId`;org 不再参与 R-RUN |
| 切 org 行为 | 推 `session:org_changed` 帧驱动 CLI 解绑/重绑 | **撤回 — session 一开始覆盖全部 active org,无切换动作** |
| `/auth/switch-org` 端点 | 重新签发 JWT + 推 WS 帧 | 仅作"前端默认视图调整器",不推 WS 帧、不变 backend session |
| 切 user 行为 | 未明确 | **`CLIENT_USER_MISMATCH` 拒绝 + `client claim --confirm` 显式接管 + 旧 agent unpin** |
| `agent_presence` schema | 不变 | 仍不变(代码事实修正)|
| Connection 单/多活 | 单活(隐含)| **per-user 单活;connection 与 org 完全无关(无 single/multi 概念)** |
| `client_uses` 流水 | 无 | 无新表 — owner 切换事件由 server 结构化日志覆盖 |
| Role 检查来源 | `jwt.role` | **(user, requestedOrgId) 实时查 `members.role`**,扫调用点改造 |
| CLI 命令体系 | 不动 | `client claim`;`agent --org` flag;`agent create` 多 org 用户强制 `--org` |

---

## 后续设计

本设计把 `clients.user_id` 从 JWT 解耦,但 JWT 还在带 `memberId / organizationId / role` 这些"化石字段" — 后续 follow-up 设计 [hub-strip-jwt-ambient-scope.20260508.md](../../first-tree-context/proposals/hub-strip-jwt-ambient-scope.20260508.md) 把这三个也物理移除,JWT payload 收窄为 `{ sub, type, iat, exp, jti }`,同时把 `/admin/*` 路由按 4 个 Class 重新分类(配套规范 [http-path-conventions.md](http-path-conventions.md))。`/auth/switch-org` 端点和 `members.organizationId` 在 JWT 里的存在性一并消失。
