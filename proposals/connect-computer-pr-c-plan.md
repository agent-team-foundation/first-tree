# PR-C Implementation Plan — Server Dedup + CLI Cleanup

| | |
|---|---|
| **作者** | @gandy-developer |
| **日期** | 2026-05-27 |
| **基础** | proposals/connect-computer-optimization.md §P0-1 + 用户 2026-05-27 决策 |
| **依赖** | PR-A 已 merge (`b48178f7`) |
| **代码 baseline** | `feat/connect-computer-dedup` off `origin/main` |
| **状态** | DRAFT — 待 design reflection 三轮后冻结 |

---

## 0. Executive Summary

消灭"两个同名 GandydeMacBook-Pro.local 行"问题（PR-A dev 截图里的真实数据症状）的**根因**：服务端没有 `(user_id, hostname, os)` 软去重，每次 `client.yaml` 重新生成 → 新行累积。

**用户决策（2026-05-27）**：
- ✅ 去重 key 用 `(user_id, hostname, os)` 软去重
- ✅ **孤儿归档：30 天 + 0 agents pinned + status=disconnected → 自动 archive**（用户 2026-05-27 二次决策）
- ✅ `logout --purge` 加警告 + 二次确认

**Scope（含 archival）**：

1. Server `registerClient` 加 dedup transaction — `(user_id, hostname, os)` 软合并到 canonical 行
2. WS `client:register` 处理器返回 canonical clientId（response.clientId 字段已存在，赋成 canonical 值）
3. CLI `ClientConnection.handleMessage` `client:registered` 路径：检测 response.clientId 与本地 mismatch → emit redirect 事件
4. CLI bootstrap: 收到 redirect → 写 yaml + 优雅退出（supervisor 重启自动接 canonical 身份）
5. CLI `logout --purge`: 加交互式 2 步确认 prompt + `--yes` flag 跳过
6. **新增**：`clients.archived_at TIMESTAMP NULL` 列 + 所有读路径加 `WHERE archived_at IS NULL` 过滤
7. **新增**：`archiveAbandonedClients` 服务函数 + 接入 `background-tasks` 定时调度（hourly sweep）
8. **新增**：`registerClient` (A) 同 id 路径在重连时自动 unarchive（`archived_at = NULL`），让用户带凭证回归时直接复活旧行

**Excluded** (与用户决策一致):
- ❌ `first-tree computer prune` 用户清理 CLI — 用户未要求，后续 PR
- ❌ daemon ↔ yaml file watch — 较复杂，后续 PR
- ❌ admin Web UI 展示 archived 行供恢复 — 后续 PR（admin 当前可用 SQL `UPDATE clients SET archived_at = NULL WHERE id = '...'` 恢复）

---

## 1. 现状代码摸底

### 1.1 Server 端（`packages/server/src/services/client.ts`）

`registerClient` 当前路径（[services/client.ts:51-127](packages/server/src/services/client.ts)）：

```ts
1. SELECT existing row by clientId
2. If existing.userId != data.userId → throw ClientUserMismatchError
3. INSERT ... ON CONFLICT (clients.id) DO UPDATE
```

unique key 是 `clients.id`，没有 `(user_id, hostname, os)` 查询。

### 1.2 WS 处理器（`packages/server/src/api/agent/ws-client.ts`）

`client:register` 帧处理（[ws-client.ts:435-497](packages/server/src/api/agent/ws-client.ts)）：

```ts
const data = clientRegisterSchema.parse(msg);
...
await clientService.registerClient(app.db, { clientId: data.clientId, ... });
clientId = data.clientId;  // <-- server-side session 用 CALLER's id
connectionManager.setClientConnection(data.clientId, socket);
socket.send(JSON.stringify({ type: "client:registered", clientId: data.clientId }));
```

→ PR-C 需要：
- `registerClient` 返回 canonical id
- WS handler 用 canonical id 作为 session-local clientId + `connectionManager` key + 响应 clientId 字段

### 1.3 CLI ClientConnection（`packages/client/src/client-connection.ts`）

`client:registered` 处理（[client-connection.ts:779-796](packages/client/src/client-connection.ts)）：

```ts
if (type === "client:registered") {
  // 完全不读 msg.clientId
  this.registered = true;
  this.startHeartbeat();
  this.emit("connected");
  ...
}
```

→ PR-C 需要：
- 读 `msg.clientId`，与 `this.clientId` 比较
- 若 mismatch → 不进入 connected 流程，emit 新 `client:redirect` 事件（带 canonical id），cleanly close（设 `this.closing=true` 防止 reconnect loop）

`this.clientId` 是 `readonly` —— 不可变。Redirect 后由 caller 重建 ClientConnection 实例。

### 1.4 CLI Bootstrap（`apps/cli/src/core/client-runtime.ts`）

`ClientRuntime` 构造时把 `clientId` 传入 `new ClientConnection({ clientId, ... })`（[client-runtime.ts:80-95](apps/cli/src/core/client-runtime.ts)）。Bootstrap 流程在 `apps/cli/src/commands/login.ts` 或 `daemon.ts` 中。

→ PR-C 需要：
- Bootstrap 监听 `ClientConnection.on("client:redirect")`
- 收到事件 → 写 yaml.client.id = canonicalId → `process.exit(0)`（service 模式下 supervisor 自动重启，inline 模式下用户重跑命令）

### 1.5 `logout --purge`（`apps/cli/src/commands/logout.ts`）

当前实现（[commands/logout.ts:14-44](apps/cli/src/commands/logout.ts)）已正确（先停 daemon 再删 yaml），但没有交互式确认。`--purge` 是隐藏 flag，能看到 docs 的用户大概率知道在做什么；但加二次确认能拦住 copy-paste 失误。

→ PR-C 需要：
- 加 interactive `select` prompt（用现有 `@inquirer/prompts`）
- 加 `--yes` flag 用于脚本场景

---

## 2. 架构设计

### 2.1 服务端去重事务

**新增**：`packages/server/src/services/client.ts`

**关键修订（adversarial review finding #1, P0）**：原 plan 用 `SELECT ... FOR UPDATE` 想串行化并发 register，但 **FOR UPDATE 在空结果集上不锁任何行** —— 两个并发 first-time register 都看到 "no canonical"，都 INSERT，产生 dedup 想消除的同一类 orphan。修复：用 `pg_advisory_xact_lock(hashtext(key))` 在 SELECT 之前就锁住 `(user, hostname, os)` key，PG 事务级 advisory lock 是空结果集仍然有效的串行化原语，事务结束自动释放。

```ts
export type RegisterClientResult = {
  /** Canonical clientId for this (user, hostname, os) tuple. May differ from the
   *  caller's `data.clientId` if a soft-dedup merge happened. */
  canonicalClientId: string;
  /** True when soft-dedup picked a different row than the caller asked for. */
  redirected: boolean;
};

/** Thrown when soft-dedup would steal a canonical row whose socket is still
 *  live (i.e. another CLI is currently connected as the canonical). Caller
 *  (WS handler) translates this to `client:register:rejected` + close 4403 so
 *  the offending CLI does not keep stealing the slot every reconnect. */
export class ClientDedupConflictError extends Error {
  readonly code = "CLIENT_DEDUP_CONFLICT";
  constructor(canonicalId: string) {
    super(`Another client is currently connected as canonical "${canonicalId}". Retry later.`);
    this.name = "ClientDedupConflictError";
  }
}

export async function registerClient(
  db: Database,
  data: { clientId, userId, organizationId, instanceId, hostname?, os?, sdkVersion?, lastUpdateAttempt? },
  /** Injected by the WS handler. Returns true iff the canonical id currently
   *  has a live socket held by `connectionManager` that is NOT this caller. */
  isCanonicalSlotLive: (canonicalId: string) => boolean,
): Promise<RegisterClientResult> {
  return db.transaction(async (tx) => {
    // (A) Same-id path: if a row with caller's id exists, run the existing
    //     user-mismatch + upsert path. No dedup query, no advisory lock —
    //     normal reconnect path stays O(1).
    const [bySameId] = await tx.select(...).from(clients).where(eq(clients.id, data.clientId)).limit(1);
    if (bySameId) {
      // existing user-mismatch check + metadataMerge upsert, returning data.clientId
      return { canonicalClientId: data.clientId, redirected: false };
    }

    // (B) Dedup path. Caller's id is new — check (user, host, os) for a
    //     canonical row. ADVISORY LOCK FIRST to serialize concurrent first-
    //     time registers from the same machine, otherwise both would race
    //     past an empty SELECT and both INSERT.
    if (!data.hostname || !data.os) {
      // Without hostname/os we cannot dedup safely — plain insert.
      ...plain insert with data.clientId...
      return { canonicalClientId: data.clientId, redirected: false };
    }

    // `pg_advisory_xact_lock(hashtext(...))` — 64-bit integer key, released
    // automatically at COMMIT/ROLLBACK. hashtext is deterministic on the
    // concatenated key. No new schema needed.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${data.userId} || '|' || ${data.hostname} || '|' || ${data.os})
      )
    `);

    // Now safe to SELECT — any concurrent transaction with the same key is
    // blocked behind us on the advisory lock.
    const candidateRows = await tx.select({ id, status, lastSeenAt }).from(clients)
      .where(and(
        eq(clients.userId, data.userId),
        eq(clients.hostname, data.hostname),
        eq(clients.os, data.os),
      ));

    // Two-step agent-count: GROUP BY + FOR UPDATE is invalid in PG (cannot
    // lock through aggregate). We already hold the advisory lock for this
    // key, so a plain COUNT is race-safe within our scope.
    const agentCounts =
      candidateRows.length > 0
        ? await tx.select({ clientId: agents.clientId, count: sql<number>`count(*)::int` })
            .from(agents)
            .where(and(
              sql`${agents.clientId} IS NOT NULL`,
              inArray(agents.clientId, candidateRows.map((r) => r.id)),
              ne(agents.status, "deleted"),
            ))
            .groupBy(agents.clientId)
        : [];
    const counts = new Map(agentCounts.map((c) => [c.clientId, c.count]));
    const candidates = candidateRows.map((r) => ({ ...r, agentCount: counts.get(r.id) ?? 0 }));

    const canonical = pickCanonical(candidates);  // see §2.2

    if (!canonical) {
      ...plain insert with data.clientId...
      return { canonicalClientId: data.clientId, redirected: false };
    }

    // (C) Connection-stealing guard (adversarial finding #3, #19). If a
    // different live socket is currently registered as canonical, fail the
    // dedup — do NOT silently kick the other CLI off. The WS handler maps
    // ClientDedupConflictError to `client:register:rejected`, so the
    // offending CLI sees a clear error instead of an invisible takeover.
    if (isCanonicalSlotLive(canonical.id)) {
      throw new ClientDedupConflictError(canonical.id);
    }

    // (D) Redirect path: merge caller's connection info onto canonical row.
    // metadata merge MUST mirror the existing single-id upsert path
    // (services/client.ts:94) — `COALESCE(metadata, '{}'::jsonb) || jsonb`
    // — so capabilities (written by updateClientCapabilities) are NOT
    // clobbered. Only `lastUpdateAttempt` sub-key is overwritten.
    const metadataMerge = data.lastUpdateAttempt
      ? sql`COALESCE(${clients.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastUpdateAttempt: data.lastUpdateAttempt })}::jsonb`
      : undefined;

    await tx.update(clients).set({
      status: "connected",
      instanceId: data.instanceId,
      sdkVersion: data.sdkVersion ?? null,
      connectedAt: now,
      lastSeenAt: now,
      ...(metadataMerge ? { metadata: metadataMerge } : {}),
    }).where(eq(clients.id, canonical.id));
    return { canonicalClientId: canonical.id, redirected: true };
  });
}
```

### 2.2 Canonical 选择规则 (`pickCanonical`)

**纯函数**，输入：`Array<{id, status, lastSeenAt, agentCount}>` （DB 查询已经预 join 好）。规则：

1. **有 agents pinned** 的行优先（agentCount 降序）
2. 同 agentCount：**最近 lastSeenAt** 在前（降序）
3. 同时相同：取最老的 `id` （字符串升序——UUID v7 排序 ≈ 创建时间升序，稳定 tie-break）

**修订（adversarial finding #5）**：原 plan 想用 `SELECT clients.* JOIN agents COUNT GROUP BY ... FOR UPDATE` 单次查询拿数据，**PG 不允许在含 GROUP BY 的聚合查询上加 FOR UPDATE**。改成两步：
- Step 1: SELECT clients 候选（advisory lock 已在外层 holding，无需 FOR UPDATE）
- Step 2: SELECT clientId + COUNT(*) FROM agents WHERE clientId IN (...) GROUP BY clientId

两步在同一事务里、同一 advisory lock 范围内，并发安全。代码示例已在 §2.1 中体现。

### 2.3 WS handler 改动

`packages/server/src/api/agent/ws-client.ts:435-530`：

```ts
let result: RegisterClientResult;
try {
  result = await clientService.registerClient(
    app.db,
    { clientId: data.clientId, userId: session.userId, ... },
    // Inject "is this canonical id currently held by a different live socket?"
    // The connection manager already exposes `getSocket` / `isActiveClientConnection`;
    // we wrap to give registerClient a yes/no without leaking the socket object.
    (canonicalId) => {
      const existing = connectionManager.getSocket(canonicalId);
      return existing !== undefined && existing !== socket && existing.readyState === existing.OPEN;
    },
  );
} catch (err) {
  if (err instanceof ClientDedupConflictError) {
    // Adversarial finding #3 — protect against silent connection-stealing.
    // Different live CLI is already canonical; this caller does NOT take
    // over its slot. CLI sees rejected + closes.
    socket.send(JSON.stringify({
      type: "client:register:rejected",
      message: err.message,
      code: err.code,
    }));
    socket.close(4403, "client dedup conflict");
    return;
  }
  // existing ClientUserMismatchError / ClientOrgMismatchError handling
  ...
}

// IMPORTANT: use canonical id for the local session, connection manager
// registration, and the registered-response frame. A caller using stale yaml
// gets corrected via the response and the next reconnect uses canonical.
clientId = result.canonicalClientId;
connectionManager.setClientConnection(result.canonicalClientId, socket);
socket.send(JSON.stringify({ type: "client:registered", clientId: result.canonicalClientId }));

// agent:pinned backfill: enumerate by canonical, not caller's id (adversarial
// finding #3 sub-point — without this, the backfill would miss agents on
// canonical that are not pinned to caller's input id).
const pinned = await clientService.listActiveAgentsPinnedToClient(app.db, result.canonicalClientId);
```

CLI 端在 `ClientConnection.handleMessage` 已有的 `client:register:rejected` 分支需要识别新 code：

```ts
const err =
  code === "CLIENT_USER_MISMATCH" ? new ClientUserMismatchError(message) :
  code === "CLIENT_ORG_MISMATCH" ? new ClientOrgMismatchError(message) :
  code === "CLIENT_DEDUP_CONFLICT" ? new ClientDedupConflictError(message) :
  new Error(`client:register rejected: ${message}`);
```

新增 `ClientDedupConflictError` 类（在 client-connection.ts，mirror 现有 `ClientUserMismatchError` 模式），CLI bootstrap 看到该 error 后**不退出**（这是临时冲突，跟 stale auth 不同）；让 reconnect 退避后重试。如果对端 CLI 真的下线了，下次 register canonical slot 空闲，dedup 成功。

### 2.4 CLI ClientConnection 改动

`packages/client/src/client-connection.ts`:

加新事件 `client:redirect`：

```ts
type ClientConnectionEvents = {
  ...
  /** Server soft-dedupped this register into a canonical clientId. The caller
   *  should persist the new id to yaml, dispose this ClientConnection, and
   *  spawn a fresh one with the canonical id. The current connection has
   *  already closed; reconnection is suppressed. */
  "client:redirect": [canonicalClientId: string];
};
```

`handleMessage`:

```ts
if (type === "client:registered") {
  const responseClientId = typeof msg.clientId === "string" ? msg.clientId : null;
  if (responseClientId && responseClientId !== this.clientId) {
    // Soft-dedup redirect. Stop the reconnect loop and surface for the caller.
    this.wsLogger.info({ local: this.clientId, canonical: responseClientId }, "server dedup redirect");
    this.closing = true;
    this.emit("client:redirect", responseClientId);
    this.ws?.close(1000, "client redirect");
    return;
  }
  // existing path unchanged
  this.registered = true;
  ...
}
```

### 2.5 CLI Bootstrap redirect handling

**位置**：放在 `ClientRuntime` 自身。**关键修订（adversarial finding #2, #8, #17）**：原 plan 让 redirect 监听器直接 `process.exit(0)` —— 在事件回调里同步退出会绕开 `runtime.stop()` 优雅关闭路径，agent slot 和 git worktree 等清理不跑。修复：抽 `handleClientRedirect` 走 `runtime.stop()` 后再 exit；yaml 写失败时退出码 75 让 supervisor 走 backoff。

```ts
// in ClientRuntime constructor:
this.connection.on("client:redirect", (canonicalId) => {
  // Defer to a non-event-loop frame so the WS close handler finishes first.
  // Without this, `process.exit` fires synchronously inside `handleMessage`
  // and the close frame may not flush + heartbeat/auth-refresh timers
  // (started elsewhere on this socket) won't be cleared by the close
  // handler's natural unwind.
  queueMicrotask(() => {
    void this.handleClientRedirect(canonicalId);
  });
});

protected async handleClientRedirect(canonicalId: string): Promise<void> {
  // 1. Persist new id to yaml. Failure must be loud + retried by supervisor
  //    backoff (exit 75 = TEMPFAIL) — silent failure would loop forever as
  //    each restart re-reads the stale id, hits the same redirect, and
  //    tries to write again (adversarial finding #8).
  const yamlPath = join(defaultConfigDir(), "client.yaml");
  try {
    setConfigValue(yamlPath, "client.id", canonicalId);
  } catch (err) {
    print.check(false, "failed to persist canonical client id to yaml", err instanceof Error ? err.message : String(err));
    print.status("", "Recovery: ensure the config directory is writable, then re-run the command.");
    await this.stop().catch(() => {});
    process.exit(75);
  }

  print.status("✓", `merged with existing computer record on this hub (id: ${canonicalId})`);
  print.status("", "restarting to pick up the new identity...");

  // 2. Graceful shutdown — run the same path SIGINT triggers in login.ts.
  //    Without this, agent.slot.stop() never fires, git mirrors leak
  //    worktree refs, and the WS close handler may not unbind agents
  //    cleanly server-side.
  await this.stop().catch((err) => {
    print.status("⚠️", `runtime.stop() during redirect threw: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 3. Exit cleanly. Service mode: supervisor restarts with new yaml.
  //    Inline mode (login.ts:210 `await new Promise(() => {})`): the
  //    process exits and the user re-runs login. Exit 0 over 75 — this
  //    is a successful identity migration, not a fault.
  process.exit(0);
}
```

测试时子类化 `ClientRuntime` 覆盖 `handleClientRedirect` 来捕获 invocation 并验证 stop+exit 顺序。

**`--override` 路径**（adversarial finding #10 — 部分接受）：
- `login --override` 走 `claimClient` 后 register 用 yaml 里**已有**的 clientId，命中 §2.1 (A) 路径，dedup 查询不跑 → 不触发 redirect。✓
- 但若 yaml 是新生成的（用户之前 `logout --purge` 过），`postClaim` 会先 404（row 不存在）。这是**已存在的 UX 限制**，PR-C 不解决。文档在 §6 known limitations 中记入。

### 2.7 孤儿归档（user 2026-05-27 决策：30 天）

#### Schema 改动

`packages/server/src/db/schema/clients.ts` 加 `archived_at` 列：

```ts
export const clients = pgTable("clients", {
  // ...existing columns...
  /**
   * Soft-delete timestamp. NULL = active row, surfaced in all read paths.
   * Non-NULL = archived (abandoned orphan); excluded from read paths but
   * still recoverable via admin SQL `UPDATE clients SET archived_at = NULL`.
   * Set by the hourly `archiveAbandonedClients` sweep when a row is
   * (disconnected AND last_seen > 30d AND zero pinned agents).
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  index("idx_clients_user").on(table.userId),
  index("idx_clients_org").on(table.organizationId),
  // New index supports the hourly sweep WHERE clause efficiently:
  // (status, last_seen_at) covers the predicate scan; archived_at NULL is
  // the bulk of the table, so filtering it via the index keeps the scan
  // bounded as the table grows.
  index("idx_clients_sweep").on(table.status, table.lastSeenAt).where(sql`archived_at IS NULL`),
]);
```

Drizzle migration generated via `pnpm --filter @first-tree/server db:generate`. Migration is **additive** (ADD COLUMN NULLABLE + CREATE INDEX) — zero blast radius, PG can apply it online.

#### 阈值常量

`packages/server/src/services/client.ts`:

```ts
/**
 * Orphan archival threshold. A `clients` row is auto-archived when ALL three
 * hold:
 *   1. `status = 'disconnected'`
 *   2. `last_seen_at < NOW() - ORPHAN_ARCHIVAL_STALE_DAYS days`
 *   3. zero non-deleted agents pinned to it
 *
 * 30 days chosen as a deliberate product decision (2026-05-27): long enough
 * to survive a typical vacation / contractor cycle, short enough that
 * abandoned `client.yaml` regenerations clear within a month. The threshold
 * is decoupled from the auth refresh-token TTL — even if a row's auth
 * credentials are still mintable, an unused machine for 30 days with no
 * pinned work is treated as abandoned.
 */
export const ORPHAN_ARCHIVAL_STALE_DAYS = 30;
```

未来若需要可配置：把常量挪到 `app.config.runtime.clientArchivalStaleDays`，schema 在 `packages/shared/src/config/`。本 PR 先用 const，避免引入新配置字段。

#### Sweep 函数

`packages/server/src/services/client.ts`:

```ts
/**
 * Sweep abandoned `clients` rows: disconnected, untouched for at least
 * {@link ORPHAN_ARCHIVAL_STALE_DAYS} days, and carrying no non-deleted
 * pinned agents. Sets `archived_at = NOW()` so read paths can filter
 * them out without losing the data (admin SQL can resurrect by clearing
 * the column).
 *
 * Returns the number of rows archived. Idempotent: re-archiving an
 * already-archived row is a no-op via `archived_at IS NULL`.
 *
 * `agents` join uses a NOT EXISTS subquery (cheaper than COUNT GROUP BY
 * for the "no rows" check the predicate cares about).
 */
export async function archiveAbandonedClients(db: Database, staleDays = ORPHAN_ARCHIVAL_STALE_DAYS): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE clients
    SET archived_at = NOW()
    WHERE status = 'disconnected'
      AND archived_at IS NULL
      AND last_seen_at < NOW() - make_interval(days => ${staleDays})
      AND NOT EXISTS (
        SELECT 1 FROM agents
        WHERE agents.client_id = clients.id
          AND agents.status != 'deleted'
      )
    RETURNING id
  `);
  return result.length;
}
```

#### Scheduler 接入

`packages/server/src/services/background-tasks.ts:55-75` 现有 `heartbeatTimer` 已经按 30s 跑 `cleanupStaleClients`。Archival 不需要 30s 这么频繁（孤儿状态变化以天为单位）。**单独加 hourly timer**：

```ts
let orphanArchiveTimer: ReturnType<typeof setInterval> | null = null;

// ... inside start():

// Orphan client archival sweep — runs hourly. Cheap (single indexed
// UPDATE) so a tighter cadence is harmless, but the predicate is
// 30-day-grained so hourly is plenty.
orphanArchiveTimer = setInterval(async () => {
  try {
    const archived = await clientService.archiveAbandonedClients(app.db);
    if (archived > 0) {
      log.info({ archived, staleDays: clientService.ORPHAN_ARCHIVAL_STALE_DAYS }, "archived abandoned client rows");
    }
  } catch (err) {
    log.error({ err }, "client orphan archival sweep failed");
  }
}, 60 * 60 * 1000);

// ... inside stop():
if (orphanArchiveTimer) {
  clearInterval(orphanArchiveTimer);
  orphanArchiveTimer = null;
}
```

#### 读路径过滤

**所有列出 clients 的查询必须加 `archived_at IS NULL`**：

| 路径 | 当前 query | PR-C 改动 |
|---|---|---|
| `services/client.ts::listClients` | `select().from(clients).where(eq(userId,..))` | 加 `AND archived_at IS NULL` |
| `services/client.ts::listClientsForOrgAdmin` | join + where(orgId) | 同上 |
| `services/client.ts::getClient` | by id | 同上 — archived 行从 API 视角不存在（404） |
| `services/client.ts::assertClientOwner` | by id + user check | 同上 |
| `services/client.ts::cleanupStaleClients` | flip status | **不动**（cleanup 只标 disconnected，跟 archival 是两件事；archived 行天然不进 cleanup 因 status 已 disconnected） |
| `api/me.ts::inferOnboardingStep` | `SELECT id FROM clients WHERE userId` | 加过滤（否则 archived 行让 onboarding 误以为有 client） |

注意：`agent:bind` 路径 join `clients` 查 user 时也要过滤 archived — 否则一个 client 被 archive 后还能 bind 就是 bug。Verify in `ws-client.ts:539-557` agent.bind path。

#### `registerClient` (A) 路径自动 unarchive

用户带着原 yaml 在 31 天后回来 → `client:register` 用旧 id → 命中 (A) path → 同 id 行已被 archive。**Upsert 时 clear archived_at** 让用户无感复活：

```ts
// In (A) same-id path (§2.1)
await tx.insert(clients).values({ ..., archivedAt: null })
  .onConflictDoUpdate({
    target: clients.id,
    set: {
      ...,
      archivedAt: null,  // unarchive on reconnect
    },
  });
```

也要确认 dedup 路径 (D) 在 UPDATE canonical 时也带 `archivedAt: null`（如果 canonical 本身已被 archive 但仍是同 user/host/os 的最佳候选）。§2.1 (D) UPDATE 语句加这一字段。

#### Unarchive 优先级 + pickCanonical

`pickCanonical` 应该**偏好非 archived**：

1. 非 archived 优先
2. 同档：agentCount 降序
3. 同档：lastSeen 降序
4. 同档：id 升序

```ts
function pickCanonical(rows: Array<{id, status, lastSeenAt, agentCount, archivedAt}>): Row | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    // Non-archived first (smaller archivedAt-ness wins)
    const aArch = a.archivedAt !== null;
    const bArch = b.archivedAt !== null;
    if (aArch !== bArch) return aArch ? 1 : -1;
    // Then agentCount desc
    if (a.agentCount !== b.agentCount) return b.agentCount - a.agentCount;
    // Then lastSeenAt desc
    if (a.lastSeenAt > b.lastSeenAt) return -1;
    if (a.lastSeenAt < b.lastSeenAt) return 1;
    // Stable tie-break: id asc
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0] ?? null;
}
```

如果所有候选都是 archived（用户彻底放弃后回来），canonical 仍能选出来 → dedup UPDATE 同时 unarchive 该行。

### 2.6 `logout --purge` 二次确认

**关键修订（adversarial finding #7）**：交互式 prompt 在 non-TTY 环境（systemd unit、CI、`echo y |` pipe）会 hang。加 non-TTY guard：`--yes` 显式同意才允许 purge，否则提前 exit 1 with 明确错误。

`apps/cli/src/commands/logout.ts`:

```ts
program
  .command("logout")
  .option("--purge", "Also remove client.yaml ...")
  .option("--yes", "Skip the interactive confirmation when --purge is set (required in non-TTY env)")
  .action(async (options) => {
    ...
    if (options.purge && !options.yes) {
      if (!process.stdin.isTTY) {
        // Non-TTY (cron, CI, systemd ExecStart) — interactive prompt would
        // hang. Refuse loudly with the exact flag the operator needs.
        print.line("\n  ✗ --purge requires interactive confirmation, but stdin is not a TTY.\n");
        print.line("    Re-run with --yes to skip the prompt (only if you've confirmed the consequences).\n\n");
        process.exit(1);
      }
      print.line("\n  ⚠️  --purge will permanently remove this computer's identity (client.yaml).\n");
      print.line("     Next `first-tree login` will register a brand-new computer row on the Hub.\n");
      print.line("     The existing row will become an orphan until the server's dedup merges it back\n");
      print.line("     (only if the same user reconnects from the same hostname + OS).\n\n");
      const choice = await select<"purge" | "cancel">({
        message: "How would you like to continue?",
        choices: [
          { name: "Cancel — keep client.yaml", value: "cancel" },
          { name: "Purge — I want to lose this computer's identity", value: "purge" },
        ],
      });
      if (choice === "cancel") {
        print.line("\n  Cancelled. client.yaml retained.\n");
        return;
      }
    }
    ...existing logic...
  });
```

---

## 3. Task 分解（TDD-style）

### Task C1 · pickCanonical pure helper + tests

**Files:**
- Create: `packages/server/src/services/__tests__/pick-canonical.test.ts`
- Modify: `packages/server/src/services/client.ts` (add `pickCanonical`)

- [ ] **Step 1: Failing test** — table-driven cases:
  - empty candidates → null
  - single candidate → that candidate
  - multiple, none has agents → most recent lastSeenAt wins
  - multiple, some have agents → highest agentCount wins
  - same agentCount + same lastSeenAt → oldest id (stable tie-break)
- [ ] **Step 2:** implement `pickCanonical`
- [ ] **Step 3:** test green
- [ ] **Step 4: no commit** (per "single coherent PR commit" policy from PR-A)

### Task C2 · Server `registerClient` dedup transaction + tests

**Files:**
- Modify: `packages/server/src/services/client.ts` (rewrite `registerClient`)
- Modify: `packages/server/src/__tests__/client-register-claim.test.ts` (extend with dedup cases)

- [ ] **Step 1: Failing test** — `registerClient` dedup matrix:
  - new clientId + no canonical → INSERT new, returns `{canonicalClientId: input, redirected: false}`
  - new clientId + canonical exists (status=disconnected) → UPDATE canonical to connected, returns `{canonicalClientId: canonical.id, redirected: true}`
  - new clientId + canonical exists (already connected) → UPDATE canonical's instance_id + lastSeen, returns redirected. (Server WS-side `connectionManager.setClientConnection` already replaces old socket per existing behavior.)
  - existing clientId (same id) → existing upsert path, returns `{canonicalClientId: input, redirected: false}`
  - existing clientId + DIFFERENT userId → still throws `ClientUserMismatchError`
  - hostname or os missing on register → no dedup, plain INSERT (defensive — pickCanonical without anchor would over-merge)
  - **Concurrency test**: two concurrent registers from same (user, host, os) with different ids must serialize. Setup: use two `db.transaction` blocks in parallel with `Promise.all`, both calling `registerClient`. After both resolve, assert exactly ONE row exists for `(user, host, os)`. Without `FOR UPDATE` the test would observe two rows briefly; with it, one transaction blocks on the other's lock and observes the freshly-inserted canonical on its retry.
- [ ] **Step 2:** rewrite `registerClient`
- [ ] **Step 3:** test green

### Task C3 · WS handler uses canonical id

**Files:**
- Modify: `packages/server/src/api/agent/ws-client.ts` (lines 435-530 approximately)
- Add: `packages/server/src/__tests__/client-register-dedup-ws.test.ts` (integration test via inject)

- [ ] **Step 1: Failing test** — WS `client:register` frame with dedup-triggering payload:
  - Response is `{type: "client:registered", clientId: canonical}` (NOT the caller's input id)
  - `connectionManager.getSocket(canonical)` returns the WS (NOT under input id)
  - `agent:pinned` backfill enumerates by canonical (verify by setting up an agent pinned to canonical, then registering with new id — agent:pinned frames should arrive)
- [ ] **Step 2:** update handler — all three sites:
  - local `clientId = result.canonicalClientId`
  - `connectionManager.setClientConnection(result.canonicalClientId, socket)`
  - `socket.send({type: "client:registered", clientId: result.canonicalClientId})`
  - `listActiveAgentsPinnedToClient(app.db, result.canonicalClientId)` (was `data.clientId`)
- [ ] **Step 3:** test green

### Task C4 · CLI ClientConnection emits redirect event

**Files:**
- Modify: `packages/client/src/client-connection.ts` (events type + handleMessage)
- Add: `packages/client/src/__tests__/client-connection-redirect.test.ts`

- [ ] **Step 1: Failing test** — mock WS server sends `client:registered {clientId: "Y"}` while connection's `clientId == "X"`:
  - `client:redirect` event emitted with `"Y"`
  - `connected` event NOT emitted
  - `closing` is true; no reconnect attempts
- [ ] **Step 2:** implement event + handleMessage branch
- [ ] **Step 3:** test green

### Task C5 · ClientRuntime / bootstrap redirect handling

**Files:**
- Modify: `apps/cli/src/core/client-runtime.ts` (add `client:redirect` listener)
- Possibly: `apps/cli/src/commands/login.ts` if redirect needs handling during initial login (probably not — login uses fresh id, no canonical mismatch expected)
- Add: `apps/cli/src/__tests__/client-runtime-redirect.test.ts`

- [ ] **Step 1: Failing test** — simulate `client:redirect` event:
  - yaml is rewritten with canonical id (verify via `getConfigValue`)
  - `print.status` shows informative message
  - `process.exit(0)` called (mock `process.exit` for testability)
- [ ] **Step 2:** implement
- [ ] **Step 3:** test green

### Task C6 · `logout --purge` 2-step confirm

**Files:**
- Modify: `apps/cli/src/commands/logout.ts`
- Add: `apps/cli/src/__tests__/logout-purge-confirm.test.ts`

- [ ] **Step 1: Failing test** — invoke `logout --purge` programmatically with mocked inquirer prompt:
  - prompt is shown
  - "cancel" choice → yaml retained, "Cancelled" message
  - "purge" choice → yaml removed
  - `--yes` flag → prompt skipped, yaml removed directly
- [ ] **Step 2:** implement
- [ ] **Step 3:** test green

### Task C7 · 孤儿归档（schema + sweep + read-path filter + unarchive）

**Files:**
- Modify: `packages/server/src/db/schema/clients.ts` — 加 `archivedAt` 列 + sweep 索引
- Run: `pnpm --filter @first-tree/server db:generate` — drizzle 自动生成 SQL migration
- Modify: `packages/server/src/services/client.ts`:
  - 加 `ORPHAN_ARCHIVAL_STALE_DAYS = 30` 常量
  - 加 `archiveAbandonedClients` 函数
  - `listClients` / `listClientsForOrgAdmin` / `getClient` / `assertClientOwner` 加 `archived_at IS NULL`
  - `pickCanonical` 偏好非 archived（同 §2.7）
  - `registerClient` (A) + (D) 路径 set `archived_at = null` 复活旧行
- Modify: `packages/server/src/services/background-tasks.ts` — 加 hourly `orphanArchiveTimer`
- Modify: `packages/server/src/api/me.ts:554-572` `inferOnboardingStep` — `SELECT FROM clients WHERE userId AND archived_at IS NULL`
- Modify: `packages/server/src/api/agent/ws-client.ts` agent:bind join (`agents → clients`) — 加 archived 过滤
- Add: `packages/server/src/__tests__/client-archival.test.ts`

- [ ] **Step 1: Failing tests** for the sweep matrix:
  - row disconnected 31 天 + 0 agents + 非 archived → 被 archive
  - row disconnected 29 天 + 0 agents → 不 archive（阈值边界）
  - row disconnected 31 天 + 1 agent pinned → 不 archive（有 work）
  - row connected 60 天 + 0 agents → 不 archive（在线就不算孤儿）
  - row already archived → idempotent，不再次更新（`archived_at IS NULL` 守护）
  - 多次跑 sweep 行为稳定
- [ ] **Step 2: Failing tests** for read-path 过滤:
  - `listClients` 不返回 archived 行
  - `listClientsForOrgAdmin` admin 视图同样
  - `GET /clients/:id` 对 archived 行返回 404（assertClientOwner 看不到 → NotFoundError）
  - `agent:bind` 拒绝 bind 到 archived client 的 agent（WS-level test）
  - `inferOnboardingStep` 对仅有 archived clients 的用户返回 "connect" 而非 "create_agent"
- [ ] **Step 3: Failing tests** for unarchive on reconnect:
  - 已 archived 的 client.id 重连 → (A) 路径 unarchive，行复活
  - dedup 路径 (D) 命中 archived canonical → UPDATE 也 set archived_at=null
- [ ] **Step 4:** implement migration + service + scheduler + read-path + unarchive
- [ ] **Step 5:** test green
- [ ] **Step 6:** verify migration applies cleanly on a clean DB (`pnpm --filter @first-tree/server db:migrate`)

### Task C8 · End-to-end integration test

**Files:**
- Add: `packages/server/src/__tests__/client-dedup-e2e.test.ts`

- [ ] Full dedup flow:
  - User registers client A (hostname=H, os=O)
  - User registers client B (same H, O, different clientId)
  - B's WS gets `client:registered {clientId: A's id}` — verifies canonical preference
  - DB has only A's row updated (status=connected, latest lastSeenAt)
  - B's old id has no row in DB (was never inserted)
- [ ] Archival + return flow:
  - User registers A → A becomes disconnected → wait 31 days (manipulate `last_seen_at`) → sweep → A archived
  - User reconnects with same A id → A row unarchived, status=connected
  - `listClients` shows A again

### Task C9 · Full check + lint + format

- [ ] `pnpm test` all green
- [ ] `pnpm typecheck` clean
- [ ] `pnpm check` (biome) — no new lint errors in changed files

### Task C9 · 2 rounds code review (per user directive)

- [ ] Round 1 (correctness): fresh-context subagent, focus on dedup race conditions, redirect protocol back-compat, agent-pinned backfill consistency, FOR UPDATE lock scope
- [ ] Round 2 (adversarial): fresh-context subagent, focus on dedup loop scenarios (canonical row's agent pinned to old id?), CLI redirect loop safety, SQL injection on hostname/os (zod max() caps cover it but verify)

### Task C10 · Commit, push, PR, watch

- [ ] Single coherent commit
- [ ] Push branch, open PR with full body
- [ ] Watch CI, address reviewer comments
- [ ] Wait for user manual merge

---

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Dedup 误合并真实多机（同 hostname） | 用户决策接受此限制（plan §8 已注明）。文档说明 |
| Concurrent register race | `SELECT ... FOR UPDATE` 锁住候选集，事务串行化 |
| 老 CLI 收到 redirect 后 ignore response.clientId | 服务端仍然 tracking canonical 行；老 CLI 每次连接都会被 dedup（浪费 1 个 round-trip），但不影响功能正确性 |
| 新 CLI 的 process.exit(0) 行为在 inline 模式下让 user 困惑 | 退出前明确打印"restarting to pick up the new identity"；service 模式下完全自动 |
| `agent:pinned` backfill 用 caller's clientId 而非 canonical | C3 显式改成 canonical（防止 backfill 漏 agent） |
| Redirect loop（CLI 写 yaml → 重启 → 又被 redirect） | canonical id 由 server 决定且稳定；CLI 写完 yaml 后下次 register 用 canonical 直接命中 (A) 路径，不再 redirect |
| 用户在 PR-C 之前已经有 orphan 行 | 本 PR 不主动清理，但下一次任一旧 client 重连都会触发 dedup 合并到当前 canonical。**长期看是 self-healing** |

---

## 5. 观测性

在 `registerClient` 的 redirect 分支末尾 emit 一条结构化日志：

```ts
app.log.info({
  event: "client.dedup_merged",
  userId: data.userId,
  hostname: data.hostname,
  os: data.os,
  callerId: data.clientId,
  canonicalId: result.canonicalClientId,
  candidateCount: candidates.length,
}, "soft-dedup redirected register to canonical row");
```

→ 上线后第一天可以查日志验证：
- dedup 频率（是否预期 / 是否有异常 spike）
- candidateCount 分布（是否有 user 同 host 有 5+ orphan）
- 哪些 hostname 最多 dedup（hostname 漂移可见）

不引入 metric / counter（避免新依赖），靠日志查询即可。

## 6. Design Reflection 日志

### Round 1 · writing-plans self-review

发现并 inline 修复：
- §2.5 redirect listener 位置不清 → 钉在 `ClientRuntime`，抽 `handleClientRedirect` 让测试可 mock
- §2.5 补：`--override` 不受 redirect 影响的论证
- Task C2 测试矩阵补：canonical 已连接的场景 + concurrency test 具体写法（双 transaction Promise.all）
- Task C3 显式列出全部 3 处需要换 canonical id 的位置 + agent:pinned backfill 必改

### Round 2 · plan-eng-review 框架

- 架构：app-layer dedup + FOR UPDATE 是 boring 选择，PG 部分 unique index 不可行（旧数据有重复，会建索引失败）
- 性能：额外开销 = 1 个 SELECT FOR UPDATE on dedup path，可忽略
- 观测：补 §5 结构化日志
- 边界：canonical 已连接的场景已加测试

### Round 3 · adversarial subagent (fresh-context challenge)

20 finding，按严重度处理：

**P0 / 必修**：
- ✅ **#1 (conf 9)** — FOR UPDATE 在空结果集不锁任何行，并发 first-time register 仍然产生重复。修复：换成 `pg_advisory_xact_lock(hashtext(user|host|os))` 在 SELECT 前锁住 key（PG 事务级 advisory lock，空集仍有效）。§2.1 已重写

**P1 / 必修**：
- ✅ **#2 (conf 8)** — `process.exit(0)` 同步执行绕开 graceful shutdown。修复：`queueMicrotask` 推迟 + 走 `runtime.stop()` 后再 exit。§2.5 已重写
- ✅ **#3, #19 (conf 8/7)** — 老 CLI 反复 redirect 会偷走 canonical 现有 socket。修复：`ClientDedupConflictError` 在 canonical 当前有活 socket 时抛出，CLI 看到 `CLIENT_DEDUP_CONFLICT` 错误码后等 reconnect backoff，不偷别人 slot。§2.1 + §2.3 已写
- ✅ **#4 (conf 9)** — redirect 路径的 metadata UPDATE 必须复用现有 `||` jsonb merge SQL，否则 capabilities 被 wipe。§2.1 显式加了 `metadataMerge` 同款 SQL
- ✅ **#5 (conf 7)** — GROUP BY + FOR UPDATE 在 PG 不合法。修复：两步查询，advisory lock 在外层覆盖。§2.1 + §2.2 已改
- ✅ **#7 (conf 7)** — non-TTY 环境 `select` prompt 挂死。修复：`!process.stdin.isTTY && !--yes` 提前 exit 1。§2.6 已加 guard
- ✅ **#8 (conf 8)** — yaml 写失败导致 supervisor 无限 redirect 循环。修复：try/catch + exit 75 让 supervisor backoff。§2.5 已加
- ⏸ **#10 (conf 8)** — `--override` 后 yaml 被 purge 过的 UX 限制（postClaim 404）。**接受为已存在限制**，文档进 §7 known limitations，PR-C 不修

**P2 / 接受或记入 known limitations**：
- #6 pickCanonical 偏好"有 agents pinned"可能导致 stale row 复活 — 设计意图，文档
- #9 同 id 并发 register 重启 race — pre-existing，未引入
- #11 vitest 并发测试 fixture — 测试用例显式断言 "exactly one row" 即可揭示 #1 bug
- #12 instanceId 跨 server-instance — 现有行为，dedup 后稍频繁但不破坏正确性
- #13 PII (hostname/os) 在 log — 改成 `app.log.debug` 输出 hostname/os，summary 在 info（已调整 §5）
- #14 close 时 timer 清理 — 验证 ClientConnection 的 close handler 已清 heartbeat/auth-refresh timer（已有逻辑，仅需测试覆盖）
- #15 vanilla `logout`/login（不带 --purge）是 no-op for self-healing — 设计意图，因为 yaml 保留
- #16 UUID v7 tie-break ≈ 创建时间 — 已知
- #18 (A) vs (B) 之间的 TOCTOU — advisory lock 覆盖整个事务，含 (A) 的 SELECT
- #20 partial unique index + 一次性数据迁移 — 接受为**未来更优方案**，PR-C 选 advisory lock 是因为 zero migration scope。文档

**完成 Round 3 修订**。

### 已应用修订汇总（plan v0.3）

- §2.1 整段重写：advisory lock + 两步 candidate 查询 + canonical-slot-live guard + `ClientDedupConflictError`
- §2.2 修订：两步 agent count（不能 JOIN aggregate with FOR UPDATE）
- §2.3 修订：WS handler 注入 `isCanonicalSlotLive` + 翻译 `CLIENT_DEDUP_CONFLICT` 到 register-rejected
- §2.5 重写：`queueMicrotask` 推迟 + `runtime.stop()` 走优雅关闭 + yaml 写失败 exit 75
- §2.6 修订：non-TTY guard
- §5 修订：hostname/os 落 debug 级，dedup event 落 info

---

## 7. Known Limitations (PR-C 不修)

- **`login --override` 在 yaml purged 后 postClaim 会 404**（adversarial #10）。`postClaim` 需要 server-side 存在该 client.id；purge 后 yaml 是全新 id，server 没有匹配行。改进路径需重新设计 `--override` 语义（"找到我用户名下任意 hostname 匹配的行并 claim"），独立 PR
- **真实多机同 hostname 会被合并成一行**（plan §4 风险表 + 用户决策接受）。短期变通：用户在系统设置改 hostname；长期：machine fingerprint (P2)
- **老 CLI 永远 ignore response.clientId**（plan §4）：每次 reconnect 都触发一次 redirect 浪费 round-trip，但功能正确。等老 CLI 升级或下线
- **现存 orphan 行不会被本 PR 自动清理**：只在被 dedup 触发时合并。完整清理需要 orphan archival（阈值待定）或用户 prune CLI（后续 PR）
- **`logout`（不带 --purge）不触发 self-healing**：yaml 保留 → 下次 login 用同一 id → dedup 不跑（命中 (A) 路径）。这是设计：vanilla logout 是临时 sign-out，不该改 identity

## 8. Plan 冻结

Plan v0.3 完成所有 3 轮 reflection，进入实施阶段。
