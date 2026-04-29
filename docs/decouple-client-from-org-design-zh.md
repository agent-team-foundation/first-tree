# 解耦 Client 与 Organization — 设计文档

**状态：** 草稿 — 方向探讨，尚未审批
**作者意图：** 让一台机器（一份 `~/.first-tree/hub/` 安装）能服务用户所属的所有 org，而不必在每次切换 org 时重新注册客户端身份。
**部分取代：** [multi-tenancy-hardening-design.md](./multi-tenancy-hardening-design.md) — 特别是其中"客户端在生命周期内绑定到唯一一个 org"这一规则。

> 英文权威版：[decouple-client-from-org-design.md](./decouple-client-from-org-design.md)。两份内容保持同步，以英文版为最终落地依据。

---

## 背景

当前共有三处与 `organizationId` 硬绑定：

1. **JWT** — 每个 access/refresh token 携带一个 `organizationId` 声明，由 `signTokensForMember()` 从 `members` 行盖章写入。
2. **`clients.organization_id`** — 在首次 `client:register` 时写入，在该行的整个生命周期内不可变（[packages/server/src/db/schema/clients.ts:27-29](../packages/server/src/db/schema/clients.ts:27)）。
3. **`agents.organization_id`** — 每个 agent 属于唯一一个 org；`agents.name` 在 org 内唯一。

当一个用户属于多个 org 时，服务端 `/auth/switch-org` 接口（[packages/server/src/api/me.ts:219](../packages/server/src/api/me.ts:219)，由 PR #187 引入）会用新 org 重新签发 token。**但它完全没有动 client 层。** 本地 CLI 下次重连时，[`registerClient()`](../packages/server/src/services/client.ts:89) 发现 clients 行还指向旧 org，抛出 `ClientOrgMismatchError`，CLI 把 `client.yaml` 备份成 `client.yaml.bak`，然后告诉用户重跑命令。

这就是用户的诉求："切换 org 不应该要求重新建立 client 连接。"

R-RUN 隔离规则当初的隐含前提是"一个用户对应一个 org"。PR #187 上线了 multi-org self-service，但没有同步重审这一前提。

---

## 目标

1. 一台机器一次安装即可服务用户所属的所有 org，不再触发 `ClientOrgMismatchError`，不再旋转本地 client 身份。
2. 操作员视角下，`/auth/switch-org` 是真正的零接触操作 — 仅刷新 token 即可。
3. 多租户隔离保证不被削弱：org A 的 agent 永远不能在 org B 的 session 下被操作。
4. 对存量 `clients.organization_id != null` 的数据有清晰的迁移路径。

## 非目标

- **不**让一个 agent 跨多 org 共享 — agents 仍然单 org 归属（这是产品问题）。
- **不**追求"同一进程同时跑两个 org 的 agent"（不同问题，见 Q2）。
- **不**重写 JWT 模型 — JWT 仍按 org 颁发，用于 session 范围限定。
- **不**调整 Web 端切换 org 的 UX，超出 `/auth/switch-org` 已提供的能力。

---

## 待决关键问题

需要在动手前敲定。**加粗**为推荐答案。

### Q1. "Client" 到底是什么？

两种心智模型，二选一：

- **模型 A — `client = user`，org 是运行时上下文。** 一个客户端代表"这个用户的这台机器"。WebSocket session 携带可切换的 org 上下文。一份 clientId，生命周期内可经历多个 org。
- **模型 B — `client = (user, org)`，但本地透明多路复用。** 服务端仍然把 clientId 绑到 org，本地配置维护一张 `{org → clientId}` 映射表，在切 org 时透明旋转。`ClientOrgMismatchError` 永远不会暴露给操作员。

**推荐：模型 A。** 与用户表达的心智模型一致，避免在本地维护映射表，也匹配 Web UI 中切换 org 的呈现方式。模型 B 是"用现有约束之上加一层用户体验糖" — 短期更干净但架构错配仍在。

### Q2. 一个客户端能否同时挂多个 org 的 agent？

当前不能。WS session 只持有一个 `organizationId`（[packages/server/src/api/agent/ws-client.ts:228](../packages/server/src/api/agent/ws-client.ts:228)），`agent:bind` 校验 `agent.organizationId === session.organizationId`（[同文件 line 355](../packages/server/src/api/agent/ws-client.ts:355)）。

模型 A 下两个子选项：

- **Q2a — 单活动 org。** Session 同时只有一个 active org。切换时解绑旧 org 的 agent、重绑新 org 的 agent。不变量更简单。
- **Q2b — 多活动 org。** Session 可同时持有多个 org 的 agent；每条帧带 org 标签。匹配"一台机器，所有我属的 org"的直觉（agent-A 和 agent-B 同时显示 connected）。

**推荐：v1 走 Q2a。** Q2b 是长期方向但代价显著（每帧 org 打标、`(client, org)` 维度的 presence、inbox 订阅多路复用）。先跑通 Q2a，再视需要演进到 Q2b。

### Q3. `clients.organization_id` 怎么处理？

- **直接 drop 列。** 最干净。"本 org 下的 clients" 视图改为通过 `agents` join `agent_presence` 推导。
- **改为可空，仅作信息字段。** 改动小但留下误导性的列。
- **替换为 `client_organizations` 关联表。** 可记录该 client 服务过的所有 org，便于审计；但对当前问题而言过重。

**推荐：drop 列。** 信噪比最高。失去的信息都可推导。

### Q4. 切换 org 时 `agent_presence` 行如何变化？

`agent_presence.client_id` 表示"这个 agent 当前在哪台机器上跑"。WS 切 org 时：

- **以 WS session 为权威：** 切换瞬间将旧 org 下挂在该 client 上的 agent 标记为 `offline`（清空 clientId），随后重绑新 org 的 agent。会有解绑/重绑抖动，但能让 presence 保持诚实。

**推荐：上述方案（先解绑后重绑）。** 其它方案会泄露"幽灵 connected"状态，对操作员和外部 Adapter 都很迷惑。

### Q5. R-RUN 新约束如何？

当前检查（在 `packages/server/src/services/agent.ts`）：

```
client.userId === jwt.userId            ← 保留
client.organizationId === jwt.orgId     ← 移除
agent.organizationId === jwt.orgId      ← 保留（已有）
```

**新不变量：** `agent.organizationId === session.organizationId AND client.userId === jwt.userId`。

跨租户安全仍然成立：要绑定 agent X（属于 org A），必须 (1) 持有 org A 的 JWT — 只有该 org 的 member 才会被颁发，且 (2) 拥有该 client。唯一被弱化的：单个 clientId 可以在生命周期内服务多个 org，但每次单独操作仍有 org 范围限定。

**推荐：交由 security review 确认。** 这是本次最承重的改动。

### Q6. 迁移路径

`clients.organization_id` 当前是 `notNull` 且有 FK。要么 drop，要么置空。

**推荐：** 同一个 PR 同时 drop 列、drop 索引、删除 `ClientOrgMismatchError` 类、删除旋转辅助代码、更新文档。一个 migration 即可：`DROP INDEX idx_clients_org; ALTER TABLE clients DROP COLUMN organization_id;`。无需 backfill — 这部分数据已经不再权威，直接丢弃。

### Q7. 在线运行的 CLI 如何感知 Web 端的切 org？

`/auth/switch-org` 返回新 token 后，正在运行的 CLI 进程仍持有旧 token。两种做法：

- **服务端通过现有 WS 推 `session:org_changed` 帧**，client 原地重新 handshake。
- **客户端依赖 token 过期周期被动重连** — 自然但慢。

**推荐：服务端推帧。** UX 更跟手，复杂度低。如本期 PR 想压缩范围，可放到后续 follow-up。

---

## 推荐设计（一句话）

> `clients` 行只属于一个 user，**不**绑定任何 org；WebSocket session 从已验证的 JWT 中携带当前 `organizationId`；R-RUN 保持 `agent.organizationId === session.organizationId` 与 `client.userId === jwt.userId` 两条不变量；`/auth/switch-org` 对本地 CLI 实现真正零接触，可由服务端推送 `session:org_changed` 帧加速切换。

---

## 影响面

### 按层级

| 层级 | 改什么 | 风险 |
|---|---|---|
| **DB schema** | 删除 `clients.organization_id` 与 `idx_clients_org`，单个 migration | 中 — 破坏性 |
| **`registerClient()`** | 移除跨 org 检查；从函数签名中移除 `organizationId` | 低 — 纯简化 |
| **`ws-client.ts` handshake** | 不再向 `clients` 写入 `organizationId`；session org 仍来自 `members` | 低 |
| **R-RUN（agent service）** | 删除 `client.organizationId === session.organizationId`；保留用户检查 + agent-org 检查 | **高 — 安全关键，cross-tenant 集成测试为强制项** |
| **`agent_presence` 生命周期** | 切 org 时解绑旧 org pin、重绑新 org，新代码路径 | 中 — 容易泄露幽灵 connected |
| **`/auth/switch-org`** | 可选：向活动 WS 推 `session:org_changed`，使 client 不必重启即重 handshake | 低（若延后） |
| **`ClientOrgMismatchError`** | 删除该错误类、API 映射、WS close 路径 | 低 — 纯删除 |
| **CLI `handleClientOrgMismatch` + `rotateClientIdWithBackup`** | 全部删除；移除 `connect.ts` / `client.ts` / `saas-connect.ts` 的 catch 点 | 低 |
| **`inferWizardStep()`** | "曾连接过"判断目前用 `(clients.userId, clients.organizationId)`；需改为基于 `agents` 推导（如"该 org 下该用户管理的任意 agent 是否被 pin 过"） | 中 — onboarding UX 回归风险 |
| **管理端"本 org 的 clients"视图** | 当前 `WHERE clients.organization_id = $1`；改为通过 client × pinned agent × agent.org 推导 | 中 — 涉及管理端与统计 |
| **测试** | 重写 `client-org-scoping.test.ts`、`me-multi-org.test.ts`；新增 cross-tenant R-RUN、切 org presence 转移、切 org 不旋转的测试 | 高 — 测试面净增 |
| **文档** | `multi-tenancy-hardening-design.md` 加"已被部分取代"标记；AGENTS.md 中"统一 user-JWT 鉴权"段落更新；CLI 参考移除旋转描述 | 低 |

### 具体文件清单（路径已确认；具体行号在实现时再定位）

**Server：**
- [packages/server/src/db/schema/clients.ts](../packages/server/src/db/schema/clients.ts) — 删列与索引
- `packages/server/drizzle/00XX_*.sql` — 新 migration（drop column + drop index）
- [packages/server/src/services/client.ts:69-128](../packages/server/src/services/client.ts:69) — 移除 org 检查与参数
- [packages/server/src/services/agent.ts](../packages/server/src/services/agent.ts) — R-RUN org 检查移除
- [packages/server/src/middleware/agent-selector.ts](../packages/server/src/middleware/agent-selector.ts) — 确认并更新
- [packages/server/src/api/agent/ws-client.ts](../packages/server/src/api/agent/ws-client.ts) — handshake + (Q7) `session:org_changed` 推送
- [packages/server/src/errors.ts:53-57](../packages/server/src/errors.ts:53) — 删除 `ClientOrgMismatchError`
- [packages/server/src/api/me.ts:260-278](../packages/server/src/api/me.ts:260) — 替换 `inferWizardStep` 中的 clients 查询
- [packages/server/src/api/me.ts:219-245](../packages/server/src/api/me.ts:219) — `/auth/switch-org` 推送切换帧（Q7）

**Client SDK：**
- [packages/client/src/client-connection.ts:96-102, 455](../packages/client/src/client-connection.ts:96) — 删除 WS close 中的 mismatch 路径；(Q7) 新增 `session:org_changed` 处理

**CLI：**
- [packages/command/src/core/client-reidentify.ts](../packages/command/src/core/client-reidentify.ts) — 删除该文件
- [packages/command/src/core/index.ts](../packages/command/src/core/index.ts) — 移除导出
- [packages/command/src/index.ts](../packages/command/src/index.ts) — 移除再导出
- [packages/command/src/commands/connect.ts:377-386](../packages/command/src/commands/connect.ts:377) — 移除 catch
- [packages/command/src/commands/client.ts:181-186](../packages/command/src/commands/client.ts:181) — 移除 catch
- [packages/command/src/commands/saas-connect.ts:254](../packages/command/src/commands/saas-connect.ts:254) — 移除 catch

**测试：**
- [packages/server/src/__tests__/client-org-scoping.test.ts](../packages/server/src/__tests__/client-org-scoping.test.ts) — 重写或删除
- [packages/server/src/__tests__/me-multi-org.test.ts](../packages/server/src/__tests__/me-multi-org.test.ts) — 调整断言
- 新增：cross-tenant agent-bind 拒绝
- 新增：切 org 时 presence 转移
- 新增：`client connect` + `/auth/switch-org` 不旋转 clientId 的端到端流程

**文档：**
- [docs/multi-tenancy-hardening-design.md](./multi-tenancy-hardening-design.md) — 加 "superseded" 标记
- [AGENTS.md](../AGENTS.md) — 更新 "Unified user-JWT auth" 段落
- [docs/cli-reference.md](./cli-reference.md) — 移除关于身份旋转的描述

---

## 风险与回滚

- **R-RUN 削弱是承重风险。** Cross-tenant 集成测试为合并前的强制项；建议过一次安全评审。
- **迁移是破坏性的**（删列）。回滚需要重新 `ADD COLUMN` 并从 `agent_presence` / `agents` 推导回填，必须在快照上演练 down migration。
- **Onboarding wizard 回归。** `inferWizardStep` 替换信号需在 fresh-install、单 org、多 org 三条路径上分别验证。
- **管理端静默回归。** 任何按 org 列出 clients 的视图都需逐一审计。

---

## 测试计划

1. `pnpm check && pnpm typecheck` 通过。
2. 现有 Vitest 套件经改写后通过。
3. 新增集成测试：
   - 用户 U 在 org A 与 org B 都是 member。先连接，再通过 `/auth/switch-org` 把 token 从 A 切到 B。验证 `client:register` 不再抛 `ClientOrgMismatchError`，且对 org B 的 agent 执行 `agent:bind` 成功。
   - 用户 U 持有 org A 的 JWT，尝试绑定 org B 的 agent。R-RUN 用既有的 agent-org 错误拒绝（不再是已删除的 `ClientOrgMismatchError`）。
   - 同一用户在 org A 已 pin 了 agent，切到 org B：org A 的 agent 转 `offline`，org B 的 agent 转 `connected`；切回 org A，旧 agent 自动重新 online，无需人工介入。
   - `inferWizardStep` 路径：用户在 org X 是新 member，无 agent → 步骤为 `connect`（或新信号下的对应步骤）；同一用户已经在 org Y 连过 client，再切回 X → 仍为 `connect`（因 X 下没 agent）。
4. 手动 CLI 演练：
   - 连接 org A → Web 切到 org B → 验证无旋转提示；org B 的 agent 可绑定。
   - launchd / managed 模式：同样场景，无人工提示，无 `.bak` 文件生成。
5. 威胁建模评审：确认"一个 client 跨多 org"未引入任何新的跨租户数据通路。

---

## 推进顺序

1. 与相关方对齐 Q1–Q7。
2. Schema 改动 + migration。
3. Service 层改动：`registerClient`、R-RUN、ws-client handshake；删除 `ClientOrgMismatchError`。
4. 更新 `inferWizardStep` 与所有按 org 过滤 client 的管理端视图。
5. CLI：删除 `client-reidentify.ts`，移除各 catch 点。
6. 测试：cross-tenant 集成覆盖、切 org presence 转移。
7. （可选）服务端推 `session:org_changed` 帧 + 客户端处理。
8. 文档：标记 `multi-tenancy-hardening-design.md` 已被部分取代；更新 AGENTS.md。

建议分支名：`feat/decouple-client-from-org`。

---

## 附录：当前的失败链路（便于对照）

1. 用户在机器 M 上连接到 org A。`clients` 行被创建，`organization_id = A`。
2. 用户接受 org B 的邀请（或自助开了第二个 org），现在同时属于两个 org。
3. 用户在 Web 上点 "switch to org B" → `/auth/switch-org` → 拿到 `organizationId = B` 的新 token。
4. 机器 M 上的 CLI（仍在跑或重启后）使用新 JWT 发送 `client:register`。
5. [`registerClient()`](../packages/server/src/services/client.ts:89) 读到 clients 行，发现 `organization_id = A ≠ B` → 抛 `ClientOrgMismatchError`。
6. WebSocket 以 `CLIENT_ORG_MISMATCH` 关闭。
7. CLI 在 [`handleClientOrgMismatch()`](../packages/command/src/core/client-reidentify.ts:66) 中捕获 → 备份 `client.yaml` → 生成新的 `client_xxxx` → 退出，提示操作员重跑命令。
8. 操作员重跑 → 写入新的 `clients` 行，`organization_id = B`。

新设计完全消除步骤 5–8。
