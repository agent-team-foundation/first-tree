import {
  AGENT_STATUSES,
  type ClientCapabilities,
  clientCapabilitiesSchema,
  type RuntimeProvider,
  type UpdateAttempt,
  updateAttemptSchema,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import {
  BadRequestError,
  ClientRetiredError,
  ClientUserMismatchError,
  ConflictError,
  NotFoundError,
} from "../errors.js";
import { runtimeFieldsReset } from "./presence.js";
import { recordClientHeartbeat } from "./runtime-liveness.js";

/**
 * Assert the caller can act on this client. Throws 404 for both "not found"
 * and "not yours" to prevent UUID enumeration. The client is owned by exactly
 * one user; cross-user admin access is no longer supported by this code path
 * (see decouple-client-from-identity-design §4.10.5 option A). There is no
 * cross-user ownership transfer: machine handover is local-only via
 * `login <code>` on the target user, which parks the old local client and
 * activates a separate client id.
 */
export async function assertClientOwner(db: Database, clientId: string, scope: { userId: string }): Promise<void> {
  const [row] = await db
    .select({ id: clients.id, userId: clients.userId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row || row.userId !== scope.userId) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
}

export async function assertClientNotRetired(db: Database, clientId: string): Promise<void> {
  const [row] = await db
    .select({ retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
  if (row.retiredAt) {
    throw new ClientRetiredError(`Client "${clientId}" has been retired`);
  }
}

/**
 * Upsert the clients row for a given `client_id` under an authenticated user.
 *
 * Claim semantics (decouple-client-from-identity §4.1.1):
 *   - New client_id → INSERT with the authenticated user_id. `organization_id`
 *     is written as a placeholder (NOT NULL legacy column; no longer consumed
 *     by any read path) sourced from the caller-supplied JWT default org.
 *   - Existing row with the same user_id → refresh runtime columns.
 *     `organization_id` is **not** updated on conflict, so the placeholder set
 *     at first insert sticks for the row's lifetime.
 *   - Existing row with a different user_id → raises
 *     {@link ClientUserMismatchError} (WS close 4403). The CLI guides the
 *     operator through local-client switching; the previous owner's row stays
 *     untouched.
 */
export async function registerClient(
  db: Database,
  data: {
    clientId: string;
    userId: string;
    organizationId: string;
    instanceId: string;
    hostname?: string;
    os?: string;
    sdkVersion?: string;
    /**
     * Most recent self-update outcome reported by the client on its
     * `client:register` frame. Merged shallow into `clients.metadata`
     * under the `lastUpdateAttempt` key so the admin dashboard can
     * surface "X clients failed to self-update — last reason …".
     * Optional — clients without the update-state wiring don't send it.
     */
    lastUpdateAttempt?: UpdateAttempt;
  },
) {
  const now = new Date();

  const [existing] = await db
    .select({ id: clients.id, userId: clients.userId, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);

  if (existing?.retiredAt) {
    throw new ClientRetiredError(
      `Client "${data.clientId}" has been retired. Run \`${getServerCliBinding().binName} computer reset\`, then run \`${getServerCliBinding().binName} login <code>\` to register a new client identity.`,
    );
  }

  if (existing?.userId && existing.userId !== data.userId) {
    throw new ClientUserMismatchError(
      `Client "${data.clientId}" is owned by a different user. ` +
        `Run \`${getServerCliBinding().binName} login <code>\` with the intended account to switch local clients before daemon startup; if this mismatch persists, back up local workspaces and run \`${getServerCliBinding().binName} computer reset\`.`,
    );
  }

  // Shallow-merge `lastUpdateAttempt` into the existing metadata jsonb so
  // we don't clobber sibling keys like `capabilities` (written by
  // `updateClientCapabilities`). Postgres `||` is a shallow merge — the
  // top-level `lastUpdateAttempt` key is replaced wholesale, peers
  // untouched. COALESCE handles the brand-new-row case where metadata is
  // still NULL. We only emit the merge clause when the client actually
  // reported an attempt — old clients without the wire field continue to
  // not touch metadata at all.
  const metadataMerge = data.lastUpdateAttempt
    ? sql`COALESCE(${clients.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastUpdateAttempt: data.lastUpdateAttempt })}::jsonb`
    : undefined;

  const registered = await db
    .insert(clients)
    .values({
      id: data.clientId,
      userId: data.userId,
      organizationId: data.organizationId,
      status: "connected",
      instanceId: data.instanceId,
      hostname: data.hostname ?? null,
      os: data.os ?? null,
      sdkVersion: data.sdkVersion ?? null,
      connectedAt: now,
      lastSeenAt: now,
      ...(data.lastUpdateAttempt ? { metadata: { lastUpdateAttempt: data.lastUpdateAttempt } } : {}),
    })
    .onConflictDoUpdate({
      target: clients.id,
      set: {
        userId: data.userId,
        status: "connected",
        instanceId: data.instanceId,
        hostname: data.hostname ?? null,
        os: data.os ?? null,
        sdkVersion: data.sdkVersion ?? null,
        connectedAt: now,
        lastSeenAt: now,
        ...(metadataMerge ? { metadata: metadataMerge } : {}),
      },
      setWhere: and(isNull(clients.retiredAt), or(isNull(clients.userId), eq(clients.userId, data.userId))),
    })
    .returning({ id: clients.id });

  if (registered.length > 0) return;

  const [current] = await db
    .select({ userId: clients.userId, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);
  if (current?.retiredAt) {
    throw new ClientRetiredError(
      `Client "${data.clientId}" has been retired. Run \`${getServerCliBinding().binName} computer reset\`, then run \`${getServerCliBinding().binName} login <code>\` to register a new client identity.`,
    );
  }
  if (current?.userId && current.userId !== data.userId) {
    throw new ClientUserMismatchError(
      `Client "${data.clientId}" is owned by a different user. ` +
        `Run \`${getServerCliBinding().binName} login <code>\` with the intended account to switch local clients before daemon startup; if this mismatch persists, back up local workspaces and run \`${getServerCliBinding().binName} computer reset\`.`,
    );
  }
  throw new ConflictError(`Client "${data.clientId}" could not be registered because it changed concurrently.`);
}

export async function disconnectClient(db: Database, clientId: string) {
  const now = new Date();

  // Only reset agents still bound to this client.
  await db
    .update(agentPresence)
    .set({ status: "offline", clientId: null, ...runtimeFieldsReset(now) })
    .where(eq(agentPresence.clientId, clientId));

  await db
    .update(clients)
    .set({ status: "disconnected", lastSeenAt: now })
    .where(and(eq(clients.id, clientId), isNull(clients.retiredAt)));
}

export async function heartbeatClient(db: Database, clientId: string, instanceId: string) {
  await recordClientHeartbeat(db, { clientId, instanceId, routedAgentIds: [] });
}

export async function getClient(db: Database, clientId: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  return row ?? null;
}

/**
 * Pull the most-recent self-update attempt out of a client row's
 * `metadata` jsonb, if one is recorded. Returns `null` when:
 *   - the row has no metadata yet (client without update-state wiring,
 *     or first connect ever for this row)
 *   - the `lastUpdateAttempt` sub-object is missing
 *   - the sub-object fails schema validation (corrupted on disk, or a
 *     newer wire shape we don't recognise)
 *
 * Exposed so the admin / `/me/clients` routes can flatten metadata's
 * structured field into the response without each route re-doing the
 * narrowing.
 */
export function extractLastUpdateAttempt(metadata: unknown): UpdateAttempt | null {
  if (!metadata || typeof metadata !== "object") return null;
  const sub = (metadata as Record<string, unknown>).lastUpdateAttempt;
  const parsed = updateAttemptSchema.safeParse(sub);
  return parsed.success ? parsed.data : null;
}

/**
 * Pull the capability snapshot out of a client row's `metadata` jsonb.
 * Returns `{}` (never `null` / `undefined`) so the web pill derivation
 * can treat the value as a stable map without a conditional access.
 * Mirrors {@link extractLastUpdateAttempt}; same defensive shape.
 */
export function extractCapabilities(metadata: unknown): ClientCapabilities {
  if (!metadata || typeof metadata !== "object") return {};
  const sub = (metadata as Record<string, unknown>).capabilities;
  const parsed = clientCapabilitiesSchema.safeParse(sub);
  return parsed.success ? parsed.data : {};
}

export function clientStatusForApi(row: {
  status: string;
  retiredAt?: Date | null;
}): "connected" | "disconnected" | "retired" {
  return row.retiredAt ? "retired" : row.status === "connected" ? "connected" : "disconnected";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

/**
 * List the active agents currently pinned to a client. Used by the WS
 * registration handshake to backfill `agent:pinned` notifications missed while
 * the client was offline — without it, an admin who pinned an agent during a
 * client outage would still need a manual `agent add`.
 *
 * Only returns active agents. Suspended/deleted agents are intentionally not
 * startup candidates, so clients do not attempt binds the server will reject.
 * Human agents are
 * naturally excluded by the `clientId` filter — they never carry a clientId.
 */
export async function listActiveAgentsPinnedToClient(db: Database, clientId: string) {
  return db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      runtimeProvider: agents.runtimeProvider,
    })
    .from(agents)
    .where(
      and(
        eq(agents.clientId, clientId),
        eq(agents.status, "active"),
        sql`EXISTS (
          SELECT 1 FROM ${clients}
          WHERE ${clients.id} = ${clientId}
            AND ${clients.retiredAt} IS NULL
        )`,
      ),
    );
}

/**
 * Member-scoped: every non-deleted agent pinned to a client owned by this
 * user. This is an ownership/reconciliation surface, not a startup-candidate
 * surface: suspended agents must stay visible so local config/workspaces are
 * retained while disabled. Cross-org by design — a client is owned by a user,
 * not an org (decouple-client-from-identity §4.1).
 */
export async function listMyPinnedAgents(
  db: Database,
  scope: { userId: string },
): Promise<Array<{ agentId: string; clientId: string; runtimeProvider: RuntimeProvider; status: string }>> {
  const rows = await db
    .select({
      agentId: agents.uuid,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
      status: agents.status,
    })
    .from(agents)
    .innerJoin(clients, eq(agents.clientId, clients.id))
    .where(and(eq(clients.userId, scope.userId), isNull(clients.retiredAt), ne(agents.status, "deleted")));
  return rows.filter(
    (r): r is { agentId: string; clientId: string; runtimeProvider: RuntimeProvider; status: string } =>
      r.clientId !== null,
  );
}

/**
 * Replace this client's capabilities snapshot. Capabilities live under
 * `clients.metadata.capabilities` (Option C — no dedicated column); other
 * `metadata` subkeys are preserved on merge.
 *
 * Caller is expected to have already passed `assertClientOwner`.
 */
export async function updateClientCapabilities(
  db: Database,
  clientId: string,
  capabilities: ClientCapabilities,
): Promise<void> {
  const parsed = clientCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid capabilities payload: ${parsed.error.message}`);
  }

  const [client] = await db
    .select({ metadata: clients.metadata, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
  if (client.retiredAt) {
    throw new ClientRetiredError(`Client "${clientId}" has been retired`);
  }

  const baseMetadata = (client.metadata ?? {}) as Record<string, unknown>;
  const existingCapabilities = clientCapabilitiesSchema.safeParse(baseMetadata.capabilities);
  if (existingCapabilities.success && stableJson(existingCapabilities.data) === stableJson(parsed.data)) {
    return;
  }

  // Atomic key update so concurrent modelCatalogRpc refs (and other metadata
  // writers) are not erased by a whole-object metadata replace.
  await db
    .update(clients)
    .set({
      metadata: sql`jsonb_set(
        COALESCE(${clients.metadata}, '{}'::jsonb),
        '{capabilities}',
        ${JSON.stringify(parsed.data)}::jsonb,
        true
      )`,
    })
    .where(eq(clients.id, clientId));
}

/**
 * Scope-aware client listing. Returns the caller's own clients (cross-org —
 * a client is owned by a user, not an org). The admin route adds a separate
 * `?organizationId=` cross-user view via {@link listClientsForOrgAdmin}.
 */
export async function listClients(db: Database, scope: { userId: string }) {
  const rows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.userId, scope.userId), isNull(clients.retiredAt)));
  return attachAgentCounts(db, rows);
}

/**
 * Admin-only cross-user listing: every client owned by an active member of
 * `orgId`. Joining `clients → members.user_id` instead of `clients.organization_id`
 * keeps the read path consistent with the rule that connection has no
 * runtime relationship to organization (decouple-client-from-identity §A).
 *
 * The caller must verify admin role realtime via `requireMemberInOrg` before
 * invoking this function — the service does not re-check, so it is
 * unsafe to expose without that gate.
 */
export async function listClientsForOrgAdmin(db: Database, orgId: string) {
  const rows = await db
    .select({
      id: clients.id,
      userId: clients.userId,
      organizationId: clients.organizationId,
      status: clients.status,
      sdkVersion: clients.sdkVersion,
      hostname: clients.hostname,
      os: clients.os,
      instanceId: clients.instanceId,
      connectedAt: clients.connectedAt,
      lastSeenAt: clients.lastSeenAt,
      retiredAt: clients.retiredAt,
      metadata: clients.metadata,
    })
    .from(clients)
    .innerJoin(members, eq(members.userId, clients.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.status, "active"), isNull(clients.retiredAt)));
  return attachAgentCounts(db, rows, { organizationId: orgId });
}

/**
 * Infer whether the client's locally-cached refresh token can plausibly
 * still mint access tokens. Used by the Web admin dashboard to render an
 * "AUTH EXPIRED" pill on rows whose offline duration has exceeded the
 * server's configured refresh-token TTL.
 *
 * Uses `lastSeenAt` (not `connectedAt`) because a healthy long-lived
 * client slides the refresh token continuously, so the absolute connect
 * time is no proxy for liveness. `lastSeenAt` is updated on register,
 * heartbeat, and the final disconnect — it lower-bounds the issue time
 * of the refresh token the client most likely still holds.
 *
 * Pure function, no DB access; the column-less design means there's no
 * server-side revocation path yet — every "expired" decision is purely
 * time-based. If we ever want admin-driven revocation, add a column
 * back and OR its value into this function.
 */
export function deriveAuthState(
  row: { status: string; lastSeenAt: Date },
  refreshTokenExpirySeconds: number,
): "ok" | "expired" {
  if (row.status === "disconnected") {
    const offlineMs = Date.now() - row.lastSeenAt.getTime();
    if (offlineMs > refreshTokenExpirySeconds * 1000) return "expired";
  }
  return "ok";
}

async function attachAgentCounts<T extends { id: string }>(
  db: Database,
  rows: T[],
  options: { organizationId?: string } = {},
): Promise<Array<T & { agentCount: number }>> {
  if (rows.length === 0) return [];

  const clientIds = rows.map((row) => row.id);
  const counts = await db
    .select({
      clientId: agents.clientId,
      count: sql<number>`count(*)::int`,
    })
    .from(agents)
    .where(
      and(
        inArray(agents.clientId, clientIds),
        ne(agents.status, "deleted"),
        options.organizationId ? eq(agents.organizationId, options.organizationId) : undefined,
      ),
    )
    .groupBy(agents.clientId);

  const countMap = new Map(counts.map((c) => [c.clientId, c.count]));

  return rows.map((row) => ({
    ...row,
    agentCount: countMap.get(row.id) ?? 0,
  }));
}

/**
 * Retire a client row. This is destructive: it cuts runtime bindings on this
 * client, but preserves agent identity, profile, chats, and history.
 *
 * Runs in a single transaction with `SELECT … FOR UPDATE` on the client row
 * so a concurrent `createAgent(clientId=X)` serializes with the tombstone and
 * sees the retired guard instead of landing a hidden pin.
 */
export async function retireClient(db: Database, clientId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ id: string; retired_at: Date | null }>(
      sql`SELECT id, retired_at FROM clients WHERE id = ${clientId} FOR UPDATE`,
    );
    if (!locked) {
      throw new NotFoundError(`Client "${clientId}" not found`);
    }

    const now = new Date();
    await tx
      .update(agentPresence)
      .set({ status: "offline", clientId: null, ...runtimeFieldsReset(now) })
      .where(eq(agentPresence.clientId, clientId));
    await tx
      .update(agents)
      .set({
        status: AGENT_STATUSES.SUSPENDED,
        clientId: null,
        metadata: sql`${agents.metadata} - 'runtimeSession' - 'runtimeSwitch'`,
        updatedAt: now,
      })
      .where(and(eq(agents.clientId, clientId), ne(agents.status, AGENT_STATUSES.DELETED)));
    await tx
      .update(agents)
      .set({
        clientId: null,
        metadata: sql`${agents.metadata} - 'runtimeSession' - 'runtimeSwitch'`,
        updatedAt: now,
      })
      .where(and(eq(agents.clientId, clientId), eq(agents.status, AGENT_STATUSES.DELETED)));

    if (locked.retired_at) return;

    await tx
      .update(clients)
      .set({ status: "disconnected", instanceId: null, retiredAt: now, lastSeenAt: now })
      .where(eq(clients.id, clientId));
  });
}

/**
 * System-scope sweep: mark clients as disconnected when their own heartbeat
 * is stale, or when their last-seen server instance stopped sending
 * heartbeats. Runs globally across all orgs by design — it is invoked only by
 * internal timers, never from a user-scoped request, so the per-org filter the
 * read paths enforce does not apply. Org isolation on the data these clients
 * belong to is still enforced at the read paths (see `assertClientOwner` /
 * `listClients`).
 */
export async function cleanupStaleClients(db: Database, staleSeconds = 60): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE clients SET status = 'disconnected'
    WHERE status = 'connected'
    AND retired_at IS NULL
    AND (
      last_seen_at < NOW() - make_interval(secs => ${staleSeconds})
      OR instance_id IN (
        SELECT instance_id FROM server_instances
        WHERE last_heartbeat < NOW() - make_interval(secs => ${staleSeconds})
      )
    )
    RETURNING id
  `);

  if (result.length > 0) {
    const staleIds = result.map((r) => r.id);
    await db
      .update(agentPresence)
      .set({ status: "offline", clientId: null, ...runtimeFieldsReset(new Date()) })
      .where(inArray(agentPresence.clientId, staleIds));
  }

  return result.length;
}
