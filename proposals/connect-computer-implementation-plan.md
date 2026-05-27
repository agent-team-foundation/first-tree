# Connect Computer 体验优化 — Implementation Plan

| | |
|---|---|
| **作者** | @gandy-developer |
| **日期** | 2026-05-26 |
| **基础文档** | proposals/connect-computer-optimization.md（gandy-assistant 出）<br>proposals/connect-computer-default-view-mockup.md（gandy-assistant 出） |
| **代码 baseline** | hub-fresh worktree `3992f98`（main） |
| **状态** | DRAFT — 待 design reflection 三轮后冻结 |

---

## 0. Executive Summary

本计划把 proposals 中定义的 First Delivery (P0-1 ~ P0-4) 拆成**三个独立可发布、互不阻塞的 PR**，按"风险递增、可见性递减"顺序排：

- **PR-A · Quick wins（首选起手）**：纯前端 + 一处 server 附加字段。P0-2 NewConnectionDialog 修正 + P0-4 4-pill 状态派生 + lastSeenAt + "first-tree" 改名。**零迁移，零 CLI 改动**，单 PR 完整可回滚。
- **PR-B · IA 重组**：P0-3 卡片视图 + 响应式 1024px 断点 + 降权 "+Connect"。建立在 PR-A 的 pill 派生函数之上。纯前端，**零迁移**。
- **PR-C · 服务端清理**：P0-1 register dedup + 孤儿归档 + daemon ↔ yaml 联动。涉及 schema 变更、迁移、CLI 改动、跨包契约。**最大 blast radius**，独立 PR 慎重发。

**推荐先 ship PR-A**：
- 70-80% 用户立刻能看到"机器现在能不能跑 agent"的明确答案
- 解决"永远 connecting"死路（最常见的用户投诉）
- 不动 DB schema、不动 CLI、不动 daemon 行为 → 回滚成本为零
- 完成后再决定 PR-B / PR-C 的优先级

---

## 1. 现状代码摸底（影响 plan 的关键发现）

读完 hub-fresh main 的关键代码（详见 §10 附录），把 proposals 里的假设和现实对齐：

### 1.1 `bootstrapCommand` 字段服务端已实现

`POST /me/connect-tokens` 已经在响应里返回：
- `command`: 单行 `first-tree login <token>`
- `bootstrapCommand`: 双行 `npm install -g <pkg>\nfirst-tree login <token>`（prod/staging）或同 `command`（dev，无 npm 包）
- `npmSpec`, `binName`

→ NewConnectionDialog **已经能拿到双行命令**，只是 [new-connection-dialog.tsx:141](packages/web/src/pages/clients/new-connection-dialog.tsx) 选用了 `token?.command`。**改成 `bootstrapCommand` 是一行修改**。

### 1.2 `capabilities` 没暴露在列表 API

- `GET /me/clients`（[api/me.ts:416-433](packages/server/src/api/me.ts)）返回 `id / userId / status / authState / sdkVersion / hostname / os / agentCount / connectedAt / lastSeenAt / lastUpdateAttempt`，**不含 capabilities**
- `GET /clients/:id`（[api/clients.ts:15-37](packages/server/src/api/clients.ts)）返回包括 `capabilities`，但需要 row-level 拉取
- 当前 Web `ClientsPage` 展开行触发 `getClientCapabilities`，对 1 台机器有效；列表层级要看 pill 状态需要每行各打一发请求

**对 4-pill 派生的影响**：
- 🔴 Auth expired：用 `authState`（已在列表）
- ⚪ Offline：用 `status`（已在列表）
- 🟢 Ready vs 🟡 Setup incomplete：**需要 capabilities**（区分点是"至少有一个 capability state=ok"）

**决策**：在 PR-A 内给 `/me/clients` 加 `capabilities` 字段（来自现有的 `clients.metadata.capabilities`，零 DB 改动，纯响应映射扩展）。同时给 `/orgs/:orgId/clients`（admin 视图）加同样字段为 PR-B 备料。详见 §3.1。

### 1.3 `deriveAuthState` 已经服务端纯函数化

[services/client.ts:376-385](packages/server/src/services/client.ts) 把 `authState: "ok" | "expired"` 推断挪到了 server。Web 拿到的 `authState` 是服务端算好的，**前端 pill 派生直接用即可**。

### 1.4 `cleanupStaleClients` 仅翻 status，不删行

[services/client.ts:459-479](packages/server/src/services/client.ts) 把停跳的 client 翻成 `disconnected`，**没有任何归档/删除**。P0-1 的孤儿归档需要：
- 新增定时 sweep（disconnected > 阈值 + agentCount=0 的行）
- 表上加 `archivedAt` 列或新的 `status='archived'` 枚举值
- 所有读路径排除 archived 行（`/me/clients`、`/orgs/:orgId/clients`、`GET /clients/:id`）

**这件事属于 PR-C**，PR-A 不碰。

### 1.5 `logout --purge` 已经正确处理 daemon

[apps/cli/src/commands/logout.ts:14-44](apps/cli/src/commands/logout.ts) 默认**先停 daemon、再删 credentials**；`--purge` 才删 yaml。proposal 描述准确——**当前 logout 不是 orphan 的来源**。orphan 来自其他路径（多 channel、`rm -rf` yaml、login --override 后旧行）。

### 1.6 `clients` 表 schema 已经 user-owned + org-immutable

[db/schema/clients.ts](packages/server/src/db/schema/clients.ts) primary key 是 `id`，`userId` 可空但实际上每个新行都有，`organizationId` 是占位列（不消费）。没有 `(user_id, hostname, os)` unique 索引。

→ PR-C 添加 soft dedup 时，**不需要 unique 约束**（应用层处理 reuse 路径），但需要 `idx_clients_user_hostname_os` 检索索引。

### 1.7 现有 vitest 测试体系完整

`packages/server/src/__tests__/` 下有 `me-clients-list.test.ts`、`client-auth-state.test.ts`、`client-claim.test.ts` 等 ~12 个 client 相关测试文件。`packages/web/src/pages/clients/__tests__/new-connection-dialog.test.ts` 测了 `selectArrivedClient` 纯函数。**测试体系成熟，TDD 路径清晰**。

---

## 2. Scope 决策与三个 PR 的边界

### 2.1 为什么不一个 PR

proposals/connect-computer-optimization.md §6 自己说第一交付"建议 2-3 周"。把全部塞一个 PR：
- 单次审查负担过大，code review 质量下降
- 服务端去重（P0-1）需要迁移和 daemon 协议改动，blast radius 跟纯 UI 改动不在一个量级
- IA 重组（P0-3）跟 pill 派生（P0-4）虽然有依赖，但拆开有可读性收益（pill 派生函数先建立、覆盖测试，IA 再消费）
- 若 P0-1 出问题需要回滚，纯 UI 的 P0-2/P0-4 会被一起退掉，浪费已经验证可用的工作

### 2.2 PR 边界

| PR | 涵盖 proposal 项 | 修改文件包 | 迁移 | CLI 改动 | Schema 改动 |
|---|---|---|---|---|---|
| **PR-A** | P0-2 + P0-4 (+ `/me/clients` 加 capabilities 字段) | web + server（一处）| 否 | 否 | 否 |
| **PR-B** | P0-3 | web | 否 | 否 | 否 |
| **PR-C** | P0-1 | server + cli + shared | **是** | **是** | **是** |

### 2.3 风险递增

- PR-A：纯展示+一处 server response shape 加字段。可视化的 diff 一目了然。失败模式：pill 派生逻辑误判 → 用户看到错误状态。回滚 = 还原 PR。
- PR-B：仅 IA。失败模式：响应式 broken / 单设备 vs 多设备分支处理错。回滚 = 还原 PR。
- PR-C：跨服务、跨进程、含 DB 迁移。失败模式：dedup 误合并、归档了不该归档的行、daemon 自杀逻辑误伤。**必须先有 staging 验证**。

### 2.4 推荐执行顺序

1. **PR-A 先发**（本 plan 详细覆盖到 task 级别）
2. PR-A merge 后立刻评估 PR-B（IA 重组）—— PR-B 的 mockup 已经在 proposal 里定型，只是 React 组件重组
3. PR-C 独立排期 ——  staging 灰度先验证 dedup 不误合并

---

## 3. PR-A 架构设计

### 3.1 数据流：`/me/clients` 携带 capabilities

**现状**：
```ts
type HubClient = {
  id; userId; status; authState; sdkVersion;
  hostname; os; agentCount; connectedAt; lastSeenAt;
  // 不含 capabilities
};
```

**改动**：
```ts
type HubClient = {
  ...same as above...
  /**
   * Runtime-provider capabilities snapshot (server reads from
   * clients.metadata.capabilities). Empty object when never reported.
   * Used by the client-side pill derivation to distinguish Ready
   * (≥1 capability state=ok) from Setup incomplete (all ≠ ok).
   */
  capabilities: ClientCapabilities;
};
```

**实现要点**：
- 服务端 [api/me.ts:420-432](packages/server/src/api/me.ts) 的 `.map(c => ...)` 加一行：`capabilities: ((c.metadata?.capabilities) as ClientCapabilities | undefined) ?? {}`
- 与 [api/clients.ts:21](packages/server/src/api/clients.ts)（`GET /clients/:id`）的处理一致
- **Member path**：`listClients`（[services/client.ts:323-325](packages/server/src/services/client.ts) `.select().from(clients)`）拉所有列含 `metadata`。**响应映射可直接读 `c.metadata.capabilities`**
- ⚠️ **Admin path**：`listClientsForOrgAdmin`（[services/client.ts:338-356](packages/server/src/services/client.ts)）用 explicit column select，**不含 `metadata`**。Task A1 必须在此 select 中加入 `metadata: clients.metadata`，否则 admin 视图收不到 capabilities，pill 在 admin 模式会全错（误判成 setup_incomplete）。这是 adversarial review 抓到的 P0 项

**响应大小影响**：capability 是 `Record<provider, entry>`，目前两个 provider（claude-code、codex），每个 entry 几个 string 字段。1 个 client ≤ 1KB。70-80% 用户 1 台 client → 总响应 < 2KB，可忽略。

### 3.2 4-Pill 派生（前端纯函数）

**文件**：`packages/web/src/pages/clients/derive-status.ts`（新建）

```ts
import type { ClientCapabilities } from "@first-tree/shared";
import type { HubClient } from "../../api/activity.js";

export type ComputerStatusPill = "ready" | "auth_expired" | "setup_incomplete" | "offline";

export type ComputerStatus = {
  pill: ComputerStatusPill;
  /** Headline copy for the top-of-page sentence. */
  headline: string;
};

/**
 * Pure 4-state pill derivation for the Settings → Computers row.
 *
 * Order is by user-actionable severity (most actionable first). All
 * inputs come from existing fields — no new server columns, no thresholds.
 *
 * NOTE on `expired` vs `disconnected`: the server contract in
 * `services/client.ts:376-385` returns `authState=expired` ONLY when
 * `status=disconnected` AND offline duration exceeds the refresh-token
 * TTL. So `expired` ⊂ `disconnected` — the step-2 disconnected branch is
 * unreachable when step 1 matched. Keep both as defensive ordering in
 * case the server contract changes (e.g., adds admin-driven revocation).
 */
export function deriveComputerStatus(client: HubClient): ComputerStatus {
  // 1. authState=expired wins — credentials are dead, user must re-login.
  if (client.authState === "expired") {
    return { pill: "auth_expired", headline: "Your computer needs to log in again" };
  }
  // 2. Disconnected (but auth still ok — token alive, machine just offline).
  if (client.status !== "connected") {
    return { pill: "offline", headline: "Your computer is offline" };
  }
  // 3. Connected + at least one capability with state=ok → Ready.
  const caps = client.capabilities ?? {};
  const anyOk = Object.values(caps).some((entry) => entry?.state === "ok");
  if (anyOk) {
    return { pill: "ready", headline: "Your computer is ready" };
  }
  // 4. Connected + zero ok capabilities → Setup incomplete.
  return { pill: "setup_incomplete", headline: "Finish setting up your computer" };
}

/** Priority order — used by both row sorting and top-of-page summary. */
export const PILL_PRIORITY: Record<ComputerStatusPill, number> = {
  auth_expired: 0,
  setup_incomplete: 1,
  offline: 2,
  ready: 3,
};
```

**特性**：
- 零 server 字段、零阈值（符合 mockup §"状态 pill 定义"硬约束）
- 完全纯函数，pinpoint TDD：表格驱动测试 N 个 input → expected pill
- 不依赖时间（mockup 明确不引入 stale heartbeat 阈值）

### 3.3 `ComputerStatusPill` 组件

**文件**：`packages/web/src/pages/clients/computer-status-pill.tsx`（新建）

复用现有 PresenceChip 的视觉语言（dot + label），但加 4 个 pill 状态色：
- 🟢 Ready → `var(--state-idle)` 绿
- 🔴 Auth expired → `var(--state-error)` 红（已有）
- 🟡 Setup incomplete → `var(--state-blocked)` 琥珀
- ⚪ Offline → `var(--fg-4)` 灰

Pill 文案是固定字符串。组件接收 `pill: ComputerStatusPill`。

### 3.4 表格列改动（不重组 IA，那是 PR-B 的事）

[clients.tsx](packages/web/src/pages/clients.tsx) 当前表头：
```
| chevron | Hostname | (Owner) | OS | SDK | Agents | Connected | Status | actions |
```

PR-A 改成：
```
| chevron | Hostname | (Owner) | OS | first-tree | Agents | Last seen | Status | actions |
                                       ↑↑↑↑↑↑↑↑↑↑               ↑↑↑↑↑↑↑↑↑   ↑↑↑↑↑↑
                                       仅文案改名              relative time   单 pill
```

具体：
1. SDK 列表头改 "first-tree"，单元格还显示 `client.sdkVersion`（mockup §"已敲定"决定不引入版本健康对比）
2. Connected 列改名 Last seen，单元格从 `formatDate(connectedAt)` 改为 `formatRelative(lastSeenAt)`，title 仍带绝对时间
3. Status 列：原来分支渲染 `AuthExpiredChip` 或 `PresenceChip`，改成统一 `<ComputerStatusPill pill={status.pill} />`
4. 顶部 subtitle：
   - 当 `clients.length === 1` → 单 headline (`status.headline`)
   - 当 `clients.length > 1` → "N ready · M offline · ..." 计数（不引入新字段就能算）
   - **Zero-suppression**：计数为 0 的 pill 不显示，避免 "1 ready · 0 setup_incomplete · 0 offline" 这种噪音。仅显示出现过的 pill
5. 行排序按 `PILL_PRIORITY` 升序（红色冒到最上面），同 pill tie-break `lastSeenAt` 降序
   - **Member 模式 (non-admin) 当前没有显式 sort**（按 API 返回顺序）— PR-A 引入 pill-priority sort 会**改变现有用户视野中的行顺序**。这是有意 UX 改进（问题机器冒头）。在 PR description 中显式 call out
   - **Admin 模式**当前按 `lastSeenAt` 降序排（[clients.tsx:159-169](packages/web/src/pages/clients.tsx)）；PR-A 改成 pill-priority + lastSeenAt 联合排序

### 3.5 NewConnectionDialog 三件套修正

**文件**：[packages/web/src/pages/clients/new-connection-dialog.tsx](packages/web/src/pages/clients/new-connection-dialog.tsx)

#### 3.5.1 改用 `bootstrapCommand`

```ts
<ConnectCommandPanel
  command={token?.bootstrapCommand ?? null}  // was token?.command
  ...
/>
```

Onboarding 已经在用 `bootstrapCommand`（[step-connect-computer.tsx](packages/web/src/pages/onboarding/steps/step-connect-computer.tsx) 通过 `useOnboardingFlow().computer.cliCommand`）。一致化即 fix。

#### 3.5.2 Token 过期 → error phase

`token.expiresIn` 已经返回（秒数，~10 分钟默认）。在 mint 成功后启动一个 setTimeout：

```ts
useEffect(() => {
  if (!open || !token || phase !== "waiting") return;
  const ms = token.expiresIn * 1_000;
  const handle = setTimeout(() => {
    setErrorMessage("This token expired. Generate a new one to continue.");
    setPhase("error");
  }, ms);
  return () => clearTimeout(handle);
}, [open, token, phase]);
```

**`open` 在 deps 里很关键**：modal 关闭时，前一个 effect 的 cleanup（return 函数）跑，timer 被 clearTimeout。否则 close + reopen with same token cache 会让旧 timer 在新 modal 上 fire（adversarial review finding #3）。

**Race 分析**：
- 用户拷贝命令在 t=9min，切到 terminal 跑，CLI 在 t=10:30s 连上
- 前端 timer 在 t=10min fire → phase=error
- Polling tick 在 t=10:05min 看到 arrived client → 想 setPhase=success
- 但 polling useEffect 的 guard `phase !== "waiting"` 会让 tick 直接 return（已经在 error phase）
- **正确行为**：server 已经在 t=10min 把 connect-token 标记 expired，CLI 跑会被 server 拒绝（AUTH_ERROR）—— 永远不会有"过期 token 的 CLI 成功落地"这种状态

→ 边界一致。**额外测试**：用 fake timers 模拟该序列，验证 phase 始终 error 不被 polling 翻回 success。

并在 error phase 加一个 "Generate new token" 按钮 → 触发 `mintToken()` 重新走 loading→waiting（实现详见 §3.13）。

#### 3.5.3 StuckPanel 抽出共用

[step-connect-computer.tsx:89-122](packages/web/src/pages/onboarding/steps/step-connect-computer.tsx) 的 `StuckPanel` 是个纯 presentational 组件（无 timer）。**75 秒触发逻辑是在父组件 `StepConnectComputer` 的 [useEffect](packages/web/src/pages/onboarding/steps/step-connect-computer.tsx:30-38) 里管理的**（`stuck` boolean state + setTimeout）。

**修订设计（避免 adversarial review finding #4 的耦合问题）**：

1. 把 `StuckPanel` 抽出到 `packages/web/src/components/connect-stuck-panel.tsx` —— **保持纯 presentational**，无 internal timer。文案仍走 `COPY.connectComputer.*`（onboarding copy 也由 NewConnectionDialog import — 当前 dialog 已经间接使用 `ConnectCommandPanel` 共享 panel，加 `import { COPY } from "../onboarding/copy.js"` 是接受的轻耦合，避免大规模 copy 重组）
2. 75 秒触发逻辑**各 caller 自己管**：
   - Onboarding `StepConnectComputer` 保留 `stuck` state（不变）
   - NewConnectionDialog 加同样模式的 `stuck` state + useEffect（waiting phase 时启动 75s timer，phase 变化或 unmount 时 clear）
3. 共享常量：`packages/web/src/components/connect-stuck-panel.tsx` 顶部 `export const STUCK_AFTER_MS = 75_000;` 让 onboarding 和 dialog 同时 import，确保两端漂移不掉
4. **DRY trade-off**：两处各写一份 small useEffect（~5 行 each）总比让 ConnectStuckPanel 把 timer 内置然后被 parent 通过 `triggerKey`/`reset` prop 隔空控制更清晰。Explicit over clever

→ **不动 onboarding 的行为**（重要：当前 onboarding 在 `connectedClient` 到达时清 stuck，NewConnectionDialog 在 phase 变化时清 stuck，逻辑分别在 parent 里写，互不干扰）

### 3.6 测试策略

#### 3.6.1 单元（pure-fn / vitest）

- **`derive-status.test.ts`**: 矩阵覆盖 4 个 pill × 关键边界条件
  - authState expired 强势压制 status / capabilities
  - status disconnected + authState ok → offline
  - connected + zero capability ok → setup_incomplete
  - connected + 至少一个 capability ok → ready
  - capabilities 为空对象（从未上报）→ setup_incomplete
  - capabilities 含 missing / unauthenticated / error 但没有 ok → setup_incomplete
  - **edge**: `capabilities` 字段缺失（undefined）→ 视同 `{}`，setup_incomplete
  - **edge**: capability entry `state` 字段缺失（malformed）→ optional chain 跳过该 entry，等同 ≠ ok

- **`new-connection-dialog.test.ts`**（已有的扩展）:
  - 现有 `selectArrivedClient` 测试保留
  - 新增：token expiresIn 到点切 phase=error（用 `vi.useFakeTimers()`）
  - 新增：使用 `bootstrapCommand` 而非 `command`
  - 新增：mint 失败时 phase=error 显示 error 消息（点击 Generate 按钮重试也走 mint）
  - 新增：error phase 下点击 "Generate new token" 按钮 → 触发 mintToken 重新走 loading→waiting

- **`connect-stuck-panel.test.tsx`** (新):
  - 默认 75s 后渲染 StuckPanel 内容
  - `afterMs={500}` prop 缩短测试时长
  - 用 `vi.useFakeTimers()` 跳过 setTimeout

- **`clients-sort.test.ts`** (新或集成在 clients.test.ts):
  - 抽出 `compareByPillPriority(a, b)` helper（在 clients.tsx 或 derive-status.ts）
  - 测试：🔴 排在 🟡 前面；同 pill 按 lastSeenAt 降序 tie-break
  - 测试：admin 双分组各自独立排序，不跨组

#### 3.6.2 集成（server vitest）

- **`me-clients-list.test.ts`** 扩展：
  - `/me/clients` 响应包含 `capabilities` 字段
  - 已上报 capabilities 的 client 返回完整 map
  - 从未上报的 client 返回 `{}`
  - admin 模式同样断言 `/orgs/:orgId/clients` 含 capabilities

#### 3.6.3 端到端（手测）

PR-A 是纯展示+一处字段补充，没有需要 e2e 框架的 happy path。手测清单写入 PR 描述：

- [ ] 单 ready computer：顶部"Your computer is ready"，Status 列绿点
- [ ] Auth expired computer：顶部"...needs to log in again"，红 pill
- [ ] 没装 runtime 的 computer：黄 setup_incomplete pill
- [ ] 双 computer 一 ready 一 offline：顶部"1 ready · 1 offline"，offline 行排上面
- [ ] NewConnectionDialog 双行命令可见
- [ ] NewConnectionDialog 等 10 分钟（token 过期）→ 自动切红色 error + Generate new token 按钮
- [ ] NewConnectionDialog 75s 不连 → 出现 stuck panel

### 3.7 PR-A 不做的事（明确排除）

- ❌ 单设备卡片视图（→ PR-B P0-3）
- ❌ 响应式 2-up 多卡片（→ PR-B P0-3）
- ❌ "+Connect computer" 按钮降权位置（→ PR-B P0-3）
- ❌ 服务端 register dedup（→ PR-C P0-1）
- ❌ 孤儿归档（→ PR-C P0-1）
- ❌ daemon ↔ yaml binding（→ PR-C P0-1）
- ❌ Admin team view 解锁诊断（→ 后续 P1 PR，不在 First Delivery）
- ❌ Copy suggestion 模板（→ 后续 P1 PR）
- ❌ 行内 state-aware actions（→ PR-B 或单独 PR，跟 IA 重组耦合）

### 3.8 关于 proposal P0-4 "capability matrix 主视图可见" 的部分满足

proposal §5 P0-4 包含一条 "capability matrix 主视图可见，不再深埋展开行"。在 PR-A 保持 table IA 的前提下，**完整在主行渲染 runtime 矩阵会让表格过宽**。PR-A 的折中：

- **主行**：4-pill 已经隐含传达 "capabilities 状况"（Ready ⇔ 至少一个 ok；Setup incomplete ⇔ 全不 ok）。具体 provider 详情**仍保留展开行**
- **PR-B 卡片视图**才真正把 runtime 矩阵搬到卡片主体（卡片体内有空间承载详情，table 没有）
- proposal §3 mockup variant A/B 全部基于卡片视图，是 PR-B 的目标态

→ PR-A 满足 "状态信号在主视图可见"（pill 即状态结论），完整 capability 详情主视图化在 PR-B 实现。这是有意为之的拆分，不是遗漏。

### 3.9 类型边界细节

- `clients.metadata` 类型是 `jsonb` → TS `Record<string, unknown>`，`metadata.capabilities` 是 `unknown`。服务端 [api/clients.ts:21](packages/server/src/api/clients.ts) 已经有 typeof guard 模式（`metadata.capabilities && typeof === "object"`），Task A1 复用同一 guard
- Web 收到的 `capabilities` 不做二次 zod parse（信任服务端） — 仅用 `Object.values(caps).some(...)` 这种 defensive 访问。`entry?.state` optional chain 处理 entry 缺失情形

### 3.10 `formatRelative` 实现

`packages/web/src/lib/utils.ts` 现有 `formatDate` 用于绝对时间。新增 `formatRelative` 基于 `date-fns/formatDistanceToNowStrict`（已有依赖；如未有则用 native fallback）：

```ts
import { formatDistanceToNowStrict } from "date-fns";

/** "12 sec ago" / "8 days ago" / etc. Pure wrapper for grep-ability. */
export function formatRelative(iso: string): string {
  return `${formatDistanceToNowStrict(new Date(iso))} ago`;
}
```

如 date-fns 不在依赖里，先确认包：`pnpm --filter @first-tree/web why date-fns`；不在的话改用 `Intl.RelativeTimeFormat` 手写一个 minimal 实现，避免新增依赖。Task A5 第一步检查并做选择。

### 3.11 Stuck panel `afterMs` prop 共用

`ConnectStuckPanel` 接受 `afterMs?: number` 默认 75_000 — 让 Onboarding（明示传 75000 与之前一致）和 NewConnectionDialog（用 default）共享同一常量，避免两端漂移。常量本身放 `packages/web/src/components/connect-stuck-panel.tsx` 顶部 `export const DEFAULT_STUCK_AFTER_MS = 75_000;` 让两端 import 同一 source。

### 3.12.0 关于 "first-tree" 改名的语义说明

PR-A 仅改 **列表头** "SDK" → "first-tree"，单元格内容继续是 `client.sdkVersion`（这是 hub CLI 自身的版本字符串，比如 `v1.3.2`）。

注意：展开行里的 capability 矩阵已经显示了**每个 runtime provider 的 sdkVersion**（如 "Claude Code v0.8.1"）—— 那是 provider runtime 版本，跟 hub CLI 版本是两件事，**不重命名**。

→ 用户读：顶层列叫 "first-tree" = hub CLI 版本；展开里叫 "Claude Code v0.8.1" = provider runtime 版本。两者语义清晰区分。

### 3.12.1 关于 PR-A 列改动的"短命"成本

PR-A 改 table 列（rename SDK / rename Connected / swap status cell），PR-B 会把整个 table 改成 card。PR-A 的这些 column-level 修改在 PR-B merge 后会被替换掉。

**这个成本是有意接受的**：
- PR-A 的列修改总共 < 10 行 diff
- PR-A 单独发能立刻给 70-80% 用户带来可见改进
- 等 PR-B 一起发会让 PR-A 阻塞在更大的 IA 工作上，降低首批用户感知优化的速度
- 短命改动经过 PR-A 的测试与生产观察，让 PR-B 的卡片视图实现有更多 user data 参考

### 3.12.2 ~~关于 capability 双源~~ 改为单源 (per adversarial review finding #9)

**最初设计**：列表 capabilities 用于 pill；展开行继续 `GET /clients/:id` 拉详情 → **双源、cache 不同 key、polling cadence 不同步**

**修订**：既然列表已经带 capabilities，**展开行直接消费 list 缓存的 capabilities，不再单独 fetch**。

具体：
- `CapabilityMatrix` 组件接口从 `{ clientId, enabled }` 改为 `{ capabilities: ClientCapabilities }`
- ClientRow 把 `client.capabilities` 直接 pass down（client 来自 list query 缓存）
- 移除 `useQuery(["client-capabilities", clientId])` 整个分支
- `getClientCapabilities` API helper 仍保留（其他 caller 可能用到，未来需要 force-refresh），但 PR-A 不再从此组件调

**净效果**：
- 一处数据源（list `["clients"]`/`["clients", "org"]` 缓存）
- 数据新鲜度 = 10s polling
- 简化 ClientRow 组件（少一个 query）
- **少触发一次 API 调用**（用户每展开一行原本要打一发请求）

Task A5 task list 已对应更新（详见 §4 Task A5 Step ?）。

### 3.13 "Generate new token" 重置流程

NewConnectionDialog 的 mint 当前绑在 `useEffect(...,[open])`。要在 error 状态下点击按钮触发**重新 mint 而不关闭 modal**，需要把 mint 抽成独立函数，按钮点击 → `setPhase("loading")` + clear token + 调 mint。useEffect 内复用同一函数（解构重用，不复制）。

```ts
const mintToken = useCallback(async () => {
  setPhase("loading");
  setToken(null);
  setErrorMessage(null);
  openedAtRef.current = Date.now() - CONNECT_DETECT_FUDGE_MS;
  try {
    const t = await generateConnectToken();
    setToken(t);
    setPhase("waiting");
  } catch (err) {
    setErrorMessage(err instanceof Error ? err.message : "Failed to generate connect token");
    setPhase("error");
  }
}, []);

// open useEffect 调 mintToken；按钮 onClick 也调 mintToken
```

---

## 4. PR-A · Task 分解（TDD-style）

每个 task 一个 commit。**先红、后绿、再重构、再 commit**。

### Task A1 · 服务端 `/me/clients` + `/orgs/:orgId/clients` 加 capabilities

**Files:**
- Modify: `packages/server/src/api/me.ts:416-433`
- Modify: `packages/server/src/services/client.ts:338-356` (admin select expansion)
- Modify: `packages/server/src/__tests__/me-clients-list.test.ts`
- Modify: `packages/server/src/__tests__/admin-*.test.ts` 中 admin clients listing 相关 test

- [ ] **Step 1: Failing test (member path)** — `me-clients-list.test.ts` 加一个用例：插入 client + 写 `metadata.capabilities`，断言 `GET /me/clients` 返回的对象含 `capabilities` 且形状匹配
- [ ] **Step 2: 运行 `pnpm --filter @first-tree/server test -- me-clients-list`** — 看红
- [ ] **Step 3: 修改 api/me.ts** 在 `.map` 中加 `capabilities: ((c.metadata?.capabilities) as ClientCapabilities | undefined) ?? {}`
- [ ] **Step 4: 测试转绿**
- [ ] **Step 5: 额外断言** — 从未上报 capabilities 的 client 返回 `{}`，不是 undefined / null
- [ ] **Step 6: Failing test (admin path)** — 找到 admin clients listing 测试（如 `admin-clients-capabilities.test.ts` 或 `admin-overview.test.ts`），加用例：admin 视角 list 中的 team client 含 capabilities 字段
- [ ] **Step 7: 看红 + 验证根因**：当前 `listClientsForOrgAdmin` (`services/client.ts:338-356`) 的 select 子句**不含 `metadata`**，所以 admin 路径根本看不到 capabilities
- [ ] **Step 8: 修复 `listClientsForOrgAdmin`** —— 在 select 子句中添加 `metadata: clients.metadata`；orgs admin 路由 handler 同步加 `capabilities` 映射
- [ ] **Step 9: 整个 server pkg test pass**：`pnpm --filter @first-tree/server test`
- [ ] **Step 10: Commit** `feat(server): include capabilities in /me/clients and admin team listing`

### Task A2 · Web HubClient type 扩展

**Files:**
- Modify: `packages/web/src/api/activity.ts:35-47`
- Modify: 测试 fixture / mock

- [ ] **Step 1:** 把 `capabilities: ClientCapabilities` 加到 `HubClient` type
- [ ] **Step 2:** 修编译错误 (`ClientCapabilities` 已经从 `@first-tree/shared` export)
- [ ] **Step 3:** 现有 `new-connection-dialog.test.ts` 的 `client()` fixture 加 `capabilities: {}`
- [ ] **Step 4:** `pnpm --filter @first-tree/web typecheck` + `test` 通过
- [ ] **Step 5: Commit** `feat(web): extend HubClient type with capabilities`

### Task A3 · 4-pill 派生纯函数

**Files:**
- Create: `packages/web/src/pages/clients/derive-status.ts`
- Create: `packages/web/src/pages/clients/__tests__/derive-status.test.ts`

- [ ] **Step 1:** 先写 test 文件 — 表格驱动覆盖 §3.6.1 全部 case
- [ ] **Step 2:** `pnpm --filter @first-tree/web test -- derive-status` 红（模块不存在）
- [ ] **Step 3:** 实现 `derive-status.ts` 按 §3.2 spec
- [ ] **Step 4:** 测试转绿
- [ ] **Step 5: Commit** `feat(web): derive 4-state computer status pill`

### Task A4 · `ComputerStatusPill` 组件

**Files:**
- Create: `packages/web/src/pages/clients/computer-status-pill.tsx`
- Create: `packages/web/src/pages/clients/__tests__/computer-status-pill.test.tsx`

- [ ] **Step 1:** 测试断言 — pill="ready" 渲染绿圆点 + "Ready" 文字；其余三个 pill 同理 + 对应色 token
- [ ] **Step 2:** 红
- [ ] **Step 3:** 实现组件
- [ ] **Step 4:** 绿
- [ ] **Step 5: Commit** `feat(web): add ComputerStatusPill component`

### Task A5 · ClientsPage 集成 pill + 列改动 + 单源 capability

**Files:**
- Modify: `packages/web/src/pages/clients.tsx`
- Modify: `packages/web/src/lib/utils.ts` (add `formatRelative`)

- [ ] **Step 1:** Status 列：删除 `AuthExpiredChip + PresenceChip` 分支，统一渲染 `<ComputerStatusPill pill={deriveComputerStatus(client).pill} />`
- [ ] **Step 2:** SDK 表头 → "first-tree"（仅 thead 文案，cell 内容仍 `client.sdkVersion`）
- [ ] **Step 3:** Connected 表头 → "Last seen"，cell 从 `formatDate(connectedAt)` 改为 `formatRelative(lastSeenAt)`：
  - 第一步检查依赖：`pnpm --filter @first-tree/web why date-fns`。**有** date-fns → 用 `formatDistanceToNowStrict`；**没有** date-fns → 用 `Intl.RelativeTimeFormat` 手写最小实现（避免新增依赖）
  - 新增 `formatRelative(iso: string): string` 到 `lib/utils.ts`，返回 "12 sec ago" 这种字符串
  - Cell 上加 `title={absoluteTime}` tooltip 保留精确时间
- [ ] **Step 4:** 顶部 subtitle：
  - 单 client 时显示 `deriveComputerStatus(clients[0]).headline`
  - 多 client 时按 pill 计数生成 "1 ready · 1 offline" —— **zero-suppression**（只显示出现过的 pill）
  - 0 client 时不显示 subtitle，复用现有空状态文案
- [ ] **Step 5:** 行排序 compareByPillPriority helper（写在 derive-status.ts 或 clients.tsx 顶部）：
  ```ts
  export function compareByPillPriority(a: HubClient, b: HubClient): number {
    const pa = PILL_PRIORITY[deriveComputerStatus(a).pill];
    const pb = PILL_PRIORITY[deriveComputerStatus(b).pill];
    if (pa !== pb) return pa - pb;
    // tie-break: lastSeenAt 降序（最近的在前）
    return a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0;
  }
  ```
  应用：
  - Member 模式：`clients.sort(compareByPillPriority)`（**前所未有的 sort —— 是有意的 UX 改进**，PR description 说明）
  - Admin 模式：替换 `mineList`/`teamList` 现有的 `lastSeenAt` 排序为 `compareByPillPriority`
- [ ] **Step 6: 单源 capability**（adversarial finding #9 修订）：
  - `CapabilityMatrix` 组件接口从 `{ clientId, enabled }` 改为 `{ capabilities: ClientCapabilities }`
  - 移除 `useQuery(["client-capabilities", clientId])` 整个 hook + 内部 enabled/isLoading state
  - 展开行 `<CapabilityMatrix capabilities={client.capabilities ?? {}} />` 直接传 list 缓存数据
- [ ] **Step 7:** 视觉手测（dev server）：单设备 Ready / 单 Auth expired / 单 Setup incomplete / 双设备
- [ ] **Step 8:** Lint + typecheck + test 全包绿
- [ ] **Step 9: Commit** `feat(web): replace mixed status chips with 4-pill, rename columns, sort by pill priority, drop per-id capability fetch`

### Task A6 · 抽出 StuckPanel 到 shared component

**Files:**
- Create: `packages/web/src/components/connect-stuck-panel.tsx`
- Modify: `packages/web/src/pages/onboarding/steps/step-connect-computer.tsx`

- [ ] **Step 1:** 把 [step-connect-computer.tsx:89-122](packages/web/src/pages/onboarding/steps/step-connect-computer.tsx) 的 `StuckPanel` 函数和 75s 触发逻辑搬到新组件
- [ ] **Step 2:** 接口设计：`<ConnectStuckPanel afterMs={75_000} />` 内部自己管 setTimeout
- [ ] **Step 3:** Onboarding 改用新组件
- [ ] **Step 4:** 视觉对比 — Onboarding 75s 后仍出现同样的 panel
- [ ] **Step 5: Commit** `refactor(web): extract ConnectStuckPanel for reuse`

### Task A7 · NewConnectionDialog 三件套

**Files:**
- Modify: `packages/web/src/pages/clients/new-connection-dialog.tsx`
- Modify: `packages/web/src/pages/clients/__tests__/new-connection-dialog.test.ts`

- [ ] **Step 1:** 测试 — token expiresIn 到点后 phase 变成 "error"
- [ ] **Step 2:** 红（当前没有 expiry timer）
- [ ] **Step 3:** 加 expiry useEffect 实现 §3.5.2
- [ ] **Step 4:** 绿
- [ ] **Step 5:** 测试 — 渲染时传给 `ConnectCommandPanel` 的 `command` prop 是 `token.bootstrapCommand`，不是 `command`
- [ ] **Step 6:** 红
- [ ] **Step 7:** 一行修改
- [ ] **Step 8:** 绿
- [ ] **Step 9:** 加 `<ConnectStuckPanel />` 在 waiting phase（与 Onboarding 一致）
- [ ] **Step 10:** 加 "Generate new token" 按钮在 phase=error 时显示
- [ ] **Step 11:** Lint + typecheck + test pass
- [ ] **Step 12: Commit** `feat(web): NewConnectionDialog uses bootstrap command, handles token expiry, shows stuck panel`

### Task A8 · 全包测试 + lint

- [ ] **Step 1:** Repo root `pnpm test` 全绿
- [ ] **Step 2:** `pnpm typecheck` 全绿
- [ ] **Step 3:** `pnpm check` (biome) 全绿
- [ ] **Step 4:** 如有失败，逐一修复
- [ ] **Step 5: No commit** — 这一步保证下一步的提交干净

### Task A9 · Code review 第一轮（gstack /review，对当前 branch diff）

- [ ] 运行 `/review` 对 PR-A 分支 vs main 的 diff
- [ ] 评估每条 finding：fix / 反驳带 rationale / 标记 won't fix
- [ ] 修复采纳的项目，每一处 fix 单独 commit

### Task A10 · Code review 第二轮（codex review）

- [ ] 运行 `/codex review` 对相同 diff
- [ ] 评估每条 finding（重点：架构和边界条件，跟 gstack review 角度不同）
- [ ] 修复采纳，每一处 fix 单独 commit

### Task A11 · Push + PR

- [ ] Push 分支到 origin
- [ ] `gh pr create` — title "feat: Settings → Computers status pill + connect dialog fixes (Phase A)"
- [ ] PR body 含：summary、test plan（含 §3.6.3 手测清单）、scope（明确说 IA 重组在 PR-B、server dedup 在 PR-C）、引用两份 proposal
- [ ] **DO NOT merge** — 等 gandy2025 手动 merge

### Task A12 · 守 PR 直到 mergeable

- [ ] 定期检查 PR comment
- [ ] 每条 review comment 处理：fix / 反驳 / 标记需 user 决策
- [ ] CI 失败立刻看日志修
- [ ] 每次 fix 后 force-push 或 add commit + push
- [ ] 直到 PR `mergeable: clean`，**仍不合**，等 user

---

## 5. PR-B 简表（建立在 PR-A 之上）

仅给设计签合用，不展开 task 级。

| 项 | 描述 |
|---|---|
| 单设备 → 卡片 | `clients.length === 1` 时不渲染 table；渲染 `<ComputerCard />` 包含 heartbeat / first-tree version / OS / Runtimes 矩阵 / Agents 列表 |
| 多设备 → 卡片列表 | `length > 1` 时多卡片 grid；响应式 `@media (min-width: 1024px)` 2-up，否则 1-up |
| "+Connect" 降权 | 从 PageHeader 主按钮挪到角落 outline 按钮，并文案改 "Add another computer" |
| Capability matrix 主视图可见 | 原本展开行的 capability 列表从展开拉到卡片主体 |
| Auth expired / Setup incomplete 行内引导 | 卡片体内显示 "Generate new token" / install/sign-in 命令复制框 |

依赖：PR-A 的 `deriveComputerStatus` + `ComputerStatusPill` + `capabilities` 字段。

**风险点**：双视图（table / card）切换逻辑要小心，admin 分组在卡片视图下怎么展现需要额外设计（草案：team computers 折叠成 collapsible section）。

---

## 6. PR-C 简表（最大风险）

| 项 | 描述 |
|---|---|
| `registerClient` soft dedup | 查 `(user_id, hostname, os) AND status='connected'`，命中则**通过 WS frame 让客户端切换到旧 client_id**，旧行 reuse；客户端写回 yaml |
| 协议改动 | `client:register` 响应增加可选 `clientId` 字段；客户端若收到与本地不同的 id，写回 yaml 后重连 |
| `archivedAt` 列 | `clients` 表加 nullable `archived_at` timestamp，所有读路径加 `WHERE archived_at IS NULL` |
| Orphan sweep | 新增 cron service：`disconnected > 30 天 AND agent_count = 0 AND archived_at IS NULL` → SET `archived_at = NOW()` |
| daemon ↔ yaml 联动 | daemon 启动时 + 周期校验 `client.id` 与 yaml 一致；不一致自杀（防幽灵心跳） |
| 迁移 | drizzle migration 新增 `archived_at` + 索引 `idx_clients_user_hostname_os` |

**为什么 PR-C 单独**：
- 协议改动（`client:register` 响应）影响 CLI 所有版本（向下兼容：旧 client 收到未知字段忽略）
- 迁移阶段需要 staging 灰度
- 误删 / 误归档 / 误合并的代价高（用户机器"消失"）

依赖：无（独立于 PR-A / PR-B），但建议 PR-A 已经稳后再上，避免一次性回滚多东西。

---

## 7. 待用户拍板的（产品向）

继承自 proposals/connect-computer-optimization.md §7，未变：

1. **去重 key**：`(user_id, hostname, os)` 接受？hostname 不稳少数情况会误判 → **影响 PR-C**
2. **孤儿归档阈值**：30 天 + 0 agents pinned 是否合适 → **影响 PR-C**
3. **页面命名/路径**：`/clients` 与 `/settings/computers` 双入口是否合并 → **本期可不动**，PR-A/B 都保留双入口
4. **`logout --purge` 警告**：是否加显式警示文案 → **可独立小 PR**，不阻塞

**PR-A 不依赖任何上述决策。** PR-C 上之前需要把 1 + 2 敲定。

---

## 8. 风险与缓解

| 风险 | PR | 缓解 |
|---|---|---|
| Pill 派生在 capabilities 缺失时回到 setup_incomplete，对从未上报过 capability 的旧 client 不准 | A | 旧 client 升级 SDK 后会上报；老用户少；UI 文案明确"on this computer, install one of..." 不会引起恐慌 |
| 顶部 subtitle 单设备/多设备分支错（如 0 设备） | A | 0 设备显示既有的空状态文案 |
| Token expiry timer 在 modal 关闭后未清理 | A | useEffect cleanup 函数显式 clearTimeout（已在 §3.5.2 设计） |
| `formatRelative` 显示对旧时间不友好（"4 months ago" 真的友好吗） | A | mockup 已经明确 "Last seen 2 hours ago" / "Last seen 8 days ago" 的语义可用 |
| capability map 在响应大小膨胀（如果未来 provider 多） | A | 当前 2 provider；若超 10 个再考虑 server 端做"have-any-ok"摘要 |
| **Capability 响应 malformed（防御性）** | A | `Object.values(caps ?? {})` + `entry?.state` 双重 optional chain；Task A3 测试用例显式覆盖 |
| **`lastSeenAt` 字段无效（理论上 server 保证 ISO）** | A | server `lastSeenAt.notNull().defaultNow()` + `.toISOString()` 保证有效；端到端测试如果发现仍可加 try/catch 兜底 |
| **Token expiry timer 与 arrival detection race** | A | server 已经会 reject 过期 token —— 即使前端 timer 比 polling 早 fire 进 error，用户拷贝命令也会被服务端拒（CLI 报 "AUTH_ERROR"）。安全 |
| **PR-A 列改动短命被 PR-B 重写** | A | 接受短命成本（§3.12.1）—— PR-A 单独发的可见收益值得；diff 小 |
| PR-B 卡片视图与 admin 双栏冲突 | B | 草案先做"member-only 卡片，admin 仍用 table"，下个迭代再统一 |
| PR-C dedup 误合并：同一 hostname 跨真机（家里 MacBook = 公司 MacBook 同名） | C | 这种情形下 user 是同一个、hostname 同名 → **会被合并**。需要 fingerprint 才能区分；当前 spec 接受这个限制（用户应该改 hostname） |
| PR-C `archived_at` 加列对在线迁移影响 | C | drizzle migration 非阻塞 ALTER TABLE ADD COLUMN NULLABLE，PG 安全 |

---

## 9. 验证标准

### PR-A merge 前必须满足
- 全部 task 的 unit / integration 测试 pass
- 全包 `pnpm test` / `pnpm typecheck` / `pnpm check` 绿
- §3.6.3 全部手测过
- 2 轮独立 code review（gstack /review + /codex review）已运行，发现的项已 fix 或 documented
- PR 描述清楚说明 PR-B / PR-C 的延后理由

### PR-A merge 后短期监控
- /me/clients 响应大小变化（应该 < 2x，因为加了 capabilities）
- 单设备用户错率（pill 错判应当极低）
- NewConnectionDialog 报错率（token expired 占比应增加 — 因为现在能看见了）

---

## 10. 附录：关键代码定位（hub-fresh `3992f98` 上）

### 服务端
- [packages/server/src/api/me.ts:416-433](packages/server/src/api/me.ts) — `GET /me/clients`（PR-A capabilities 字段加这）
- [packages/server/src/api/clients.ts:15-37](packages/server/src/api/clients.ts) — `GET /clients/:id`（已含 capabilities）
- [packages/server/src/services/client.ts:51-127](packages/server/src/services/client.ts) — `registerClient`（PR-C dedup 改这）
- [packages/server/src/services/client.ts:376-385](packages/server/src/services/client.ts) — `deriveAuthState`（前端 pill 派生依赖此）
- [packages/server/src/services/client.ts:459-479](packages/server/src/services/client.ts) — `cleanupStaleClients`（PR-C 孤儿归档挂这）
- [packages/server/src/db/schema/clients.ts](packages/server/src/db/schema/clients.ts) — schema（PR-C 加 archived_at）

### Web 前端
- [packages/web/src/pages/clients.tsx](packages/web/src/pages/clients.tsx) — ClientsPage（PR-A 列改动；PR-B IA 重组主战场）
- [packages/web/src/pages/clients/new-connection-dialog.tsx](packages/web/src/pages/clients/new-connection-dialog.tsx) — NewConnectionDialog（PR-A 三件套）
- [packages/web/src/pages/onboarding/steps/step-connect-computer.tsx:89-122](packages/web/src/pages/onboarding/steps/step-connect-computer.tsx) — StuckPanel（PR-A 抽出共用）
- [packages/web/src/components/connect-command-panel.tsx](packages/web/src/components/connect-command-panel.tsx) — 共用 panel（无需改）
- [packages/web/src/api/activity.ts:35-47](packages/web/src/api/activity.ts) — `HubClient` 类型（PR-A 加 capabilities）

### Shared / CLI
- [packages/shared/src/schemas/client-capabilities.ts](packages/shared/src/schemas/client-capabilities.ts) — `ClientCapabilities` schema
- [packages/shared/src/config/resolver.ts:138-139](packages/shared/src/config/resolver.ts) — `auto-generate` client-id（PR-C 关联点）
- [apps/cli/src/commands/logout.ts](apps/cli/src/commands/logout.ts) — 当前正确，不改
- [apps/cli/src/commands/login.ts](apps/cli/src/commands/login.ts) — PR-C 可能加 yaml 校验

---

## 11. Design Reflection 日志（三轮）

### Round 1 · writing-plans self-review

发现并 inline 修复：
- §3.8 补：proposal P0-4 "capability matrix 主视图可见" 在 PR-A 部分满足（pill 隐含状态），完整主视图化在 PR-B
- §3.9 补：capability `metadata` 类型边界处理（typeof guard + optional chain）
- §3.10 补：`formatRelative` 实现细节 + 依赖检查
- §3.11 补：`STUCK_AFTER_MS` 常量共享
- §3.13 补：`mintToken` 重置流程

### Round 2 · plan-eng-review 框架分析

发现并 inline 修复（5 条）：
- §3.6.1 加 edge case 测试：capabilities undefined / malformed entry
- §3.6.1 加测试：mint 错误路径 + Regenerate button 重新触发 mint
- §3.6.1 加测试：ConnectStuckPanel 75s 触发（vi.useFakeTimers）
- §3.6.1 加测试：compareByPillPriority sort helper
- §8 补：capability malformed / lastSeenAt 无效 / timer race 三类失败模式

### Round 3 · adversarial subagent challenge（独立 fresh context）

13 条 finding，按严重度分级处理：

**P0/P1 修订到 plan**：

- ✅ **Finding 1** (P0, conf 9): `listClientsForOrgAdmin` admin select **不含 metadata** → admin 路径收不到 capabilities → admin 模式所有 team computer 都会被误判为 setup_incomplete。Task A1 Step 8 显式覆盖这一处 select 修改，新增 admin path 失败测试 Step 6-7
- ✅ **Finding 2** (P1, conf 9): Member 模式当前**没有**显式 sort，PR-A 加 pill-priority sort 会改变现有行顺序。§3.4 Step 5 显式 call out + PR description 说明
- ✅ **Finding 3** (P1, conf 8): 过期 timer useEffect deps 漏了 `open`，close+reopen with cached token 会让旧 timer 在新 modal 上 fire。§3.5.2 加 `open` 到 deps + 详细 race 分析
- ✅ **Finding 4** (P1, conf 8): StuckPanel 抽出有隐藏耦合（COPY keys、parent-driven timer）。§3.5.3 改设计：保持 StuckPanel 为纯 presentational，timer 留在各 caller parent
- ✅ **Finding 5** (P1, conf 9): `expired ⊂ disconnected` 是 server contract（`expired` 仅当 `disconnected` 才返回），prose 误导。§3.2 改注释 + 标注 step-2 是防御性 dead branch
- ✅ **Finding 7** (P1, conf 8): PR-B 卡片视图会需要 deprecate per-id capability fetch。§3.12.2 把这个工作前移到 PR-A 单源化（简化更早，PR-B 工作量更小）
- ✅ **Finding 9** (P1, conf 8): React Query cache 双源（list 和 per-id）。§3.12.2 改为单源 capability，移除 `useQuery(["client-capabilities", clientId])`
- ✅ **Finding 13** (P1, conf 8): "first-tree" 列改名 + 未改值有视觉混淆风险。§3.12.0 显式说明语义（hub CLI version vs provider runtime version）

**P2 noted（不修订，记录在 §8 风险表）**：
- Finding 6: vi fake timers 对 date-fns ✓ 兼容；Intl.RelativeTimeFormat fallback 风险
- Finding 8: PR-C 时间线建议 commit（标注在 §6 / §10）
- Finding 10: subtitle 多 segment 在窄屏丑 — §3.4 加 zero-suppression
- Finding 11: Regenerate token 后旧 CLI race（benign，加测试）
- Finding 12: 红 pill + 展开行绿 capability check 视觉冲突（接受，PR-B 改）

## 12. PR-A 实施结果（2026-05-27）

**PR-A 已交付**：[#586](https://github.com/agent-team-foundation/first-tree/pull/586)
- 状态：APPROVED + MERGEABLE，等用户手动 merge
- 测试：server 1218 / web 372 全绿，typecheck + biome 干净
- Review：3 轮设计反思 + 2 轮 adversarial code review，34 finding triage（9 落地 + 25 deferred）
- @yuezengwu 的 3 条 non-blocker 全部已在 PR body 列为 deferred follow-ups

## 13. 下个 PR 候选项 (TODO 来源于 dev 环境验收)

PR-A merge 后还有几个小 TODO 项可以打包到一个 follow-up PR 或放到 PR-B 里一起做：

### TODO-A1：dev channel 下 NewConnectionDialog 描述 vs 命令不一致

**症状**：dev channel（`first-tree-dev` 本地构建，无 npm 包）下：
- 服务端 `getChannelConfig().packageName === null` → 返回 `bootstrapCommand === command`（单行 `first-tree-dev login <token>`）
- 但 dialog 描述仍写 "If first-tree isn't installed yet, the command includes the install step." → 用户在 dev 环境看到的命令是单行，描述是误导

**修法**（两选一）：
1. 简单：在 dialog 里检测 `token.npmSpec === null`，把"installed yet..."那句话替换成 "Run this command in a terminal on the target machine."
2. 服务端：让 dev channel 也生成两行（第二行是 `cd <build-dir> && pnpm install` 之类构建提示），但这会复杂化 server config

**优先级**：低（只影响 dev 调试）—— 但用户已经在 dev 环境看到了，值得修一下消除困惑。

代码定位：
- `packages/web/src/pages/clients/new-connection-dialog.tsx` description 文案
- `packages/server/src/api/me.ts:349-358` bootstrapCommand 生成路径

### TODO-A2：可选 follow-up（之前 PR-A 也已列）

- `compareByPillPriority` 在每次比较中重派生 `deriveComputerStatus` —— 列表 K 行级别再做 `.map` 缓存
- `["clients"]` vs `["clients","me"]` cache-key 分裂——pre-existing，可统一
- `new-agent-dialog.tsx` / `use-computer-connection.ts` 仍调 `getClientCapabilities`——可改为读 list snapshot
- `getClient` 在 `api/activity.ts:80` 已无任何调用者，可删

### PR-B / PR-C（按原 plan）

- **PR-B**：P0-3 IA 重组（卡片视图 + 响应式 + "+Connect" 降权），建立在 PR-A 的 pill 之上
- **PR-C**：P0-1 服务端 dedup + 孤儿归档 + daemon ↔ yaml 联动（消除 dev 环境看到的"两个同名 GandydeMacBook-Pro.local 行"问题）
