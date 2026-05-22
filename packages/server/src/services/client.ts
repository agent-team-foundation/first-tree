import {
  type ClientCapabilities,
  clientCapabilitiesSchema,
  type RuntimeProvider,
  type UpdateAttempt,
  updateAttemptSchema,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, ClientUserMismatchError, ConflictError, NotFoundError } from "../errors.js";
import { runtimeFieldsReset } from "./presence.js";
import { markSupersededByAgents } from "./questions.js";

/**
 * Assert the caller can act on this client. Throws 404 for both "not found"
 * and "not yours" to prevent UUID enumeration. The client is owned by exactly
 * one user; cross-user admin access is no longer supported by this code path
 * (see decouple-client-from-identity-design §4.10.5 option A). Cross-user
 * ownership transfer goes through `claimClient` in PR-B.
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
 *     operator through `first-tree login <token> --override` to take
 *     ownership, which unpins the previous owner's agents from the machine.
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
    .select({ id: clients.id, userId: clients.userId })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);

  if (existing?.userId && existing.userId !== data.userId) {
    throw new ClientUserMismatchError(
      `Client "${data.clientId}" is owned by a different user. ` +
        "Run `first-tree login <token> --override` to transfer ownership.",
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

  await db
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
    });
}

/**
 * Transfer ownership of a client row to a new user, unpinning any agents
 * whose manager belonged to the previous owner. Atomic: caller is guaranteed
 * either a fully-applied ownership flip + bulk unpin, or no change. Idempotent
 * when `newUserId` already owns the row.
 *
 * Manager → user resolution goes through the members JOIN (the agents table
 * carries only `manager_id`); cross-org agents under the same previous owner
 * are unpinned together (decouple-client-from-identity §4.4).
 *
 * Caller is responsible for the caller-side authorization (the new owner must
 * be the authenticated request's user). The structured log
 * `event: client.owner_transfer` is emitted by the caller after the
 * transaction commits, using the returned `previousUserId` /
 * `unpinnedAgentIds`.
 */
export async function claimClient(
  db: Database,
  clientId: string,
  newUserId: string,
): Promise<{ previousUserId: string | null; unpinnedAgentIds: string[]; supersededChatIds: string[] }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ id: string; user_id: string | null }>(
      sql`SELECT id, user_id FROM clients WHERE id = ${clientId} FOR UPDATE`,
    );
    if (!locked) {
      throw new NotFoundError(`Client "${clientId}" not found`);
    }
    const previousUserId = locked.user_id;

    if (previousUserId === newUserId) {
      return { previousUserId, unpinnedAgentIds: [] as string[], supersededChatIds: [] as string[] };
    }

    let unpinnedAgentIds: string[] = [];
    let supersededChatIds: string[] = [];
    if (previousUserId !== null) {
      const rows = await tx
        .select({ uuid: agents.uuid })
        .from(agents)
        .innerJoin(members, eq(agents.managerId, members.id))
        .where(and(eq(agents.clientId, clientId), eq(members.userId, previousUserId)));
      unpinnedAgentIds = rows.map((r) => r.uuid);

      if (unpinnedAgentIds.length > 0) {
        const now = new Date();
        await tx.update(agents).set({ clientId: null, updatedAt: now }).where(inArray(agents.uuid, unpinnedAgentIds));
        await tx
          .update(agentPresence)
          .set({ status: "offline", clientId: null, ...runtimeFieldsReset(now) })
          .where(inArray(agentPresence.agentId, unpinnedAgentIds));
        // Pending ask-user questions on the unpinned agents can no longer be
        // delivered back — their owning client is detaching. Mark superseded
        // in the same transaction so a rollback unwinds it together. The
        // affected chat ids flow back to the caller for a post-commit
        // needs-you refresh (this path emits no session:state change).
        supersededChatIds = await markSupersededByAgents(tx, unpinnedAgentIds, "client_claimed");
      }
    }

    await tx.update(clients).set({ userId: newUserId }).where(eq(clients.id, clientId));

    return { previousUserId, unpinnedAgentIds, supersededChatIds };
  });
}

export async function disconnectClient(db: Database, clientId: string) {
  const now = new Date();

  // Only reset agents still bound to this client.
  await db
    .update(agentPresence)
    .set({ status: "offline", clientId: null, ...runtimeFieldsReset(now) })
    .where(eq(agentPresence.clientId, clientId));

  await db.update(clients).set({ status: "disconnected", lastSeenAt: now }).where(eq(clients.id, clientId));
}

export async function heartbeatClient(db: Database, clientId: string) {
  await db.update(clients).set({ lastSeenAt: new Date() }).where(eq(clients.id, clientId));
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
 * List the active agents currently pinned to a client. Used by the WS
 * registration handshake to backfill `agent:pinned` notifications missed while
 * the client was offline — without it, an admin who pinned an agent during a
 * client outage would still need a manual `first-tree agent add`.
 *
 * Excludes soft-deleted agents (status = "deleted"). Human agents are
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
    .where(and(eq(agents.clientId, clientId), ne(agents.status, "deleted")));
}

/**
 * Member-scoped: every active agent pinned to a client owned by this user.
 * Used by client startup to reconcile its local YAML against the authoritative
 * `agents.runtime_provider`. Cross-org by design — a client is owned by a
 * user, not an org (decouple-client-from-identity §4.1).
 */
export async function listMyPinnedAgents(
  db: Database,
  scope: { userId: string },
): Promise<Array<{ agentId: string; clientId: string; runtimeProvider: RuntimeProvider }>> {
  const rows = await db
    .select({
      agentId: agents.uuid,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
    })
    .from(agents)
    .innerJoin(clients, eq(agents.clientId, clients.id))
    .where(and(eq(clients.userId, scope.userId), ne(agents.status, "deleted")));
  return rows
    .filter((r): r is { agentId: string; clientId: string; runtimeProvider: string } => r.clientId !== null)
    .map((r) => ({
      agentId: r.agentId,
      clientId: r.clientId,
      runtimeProvider: r.runtimeProvider as RuntimeProvider,
    }));
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
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }

  const baseMetadata = (client.metadata ?? {}) as Record<string, unknown>;
  const merged = { ...baseMetadata, capabilities: parsed.data };

  await db.update(clients).set({ metadata: merged }).where(eq(clients.id, clientId));
}

/**
 * Scope-aware client listing. Returns the caller's own clients (cross-org —
 * a client is owned by a user, not an org). The admin route adds a separate
 * `?organizationId=` cross-user view via {@link listClientsForOrgAdmin}.
 */
export async function listClients(db: Database, scope: { userId: string }) {
  const rows = await db.select().from(clients).where(eq(clients.userId, scope.userId));
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
      metadata: clients.metadata,
    })
    .from(clients)
    .innerJoin(members, eq(members.userId, clients.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.status, "active")));
  return attachAgentCounts(db, rows);
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
): Promise<Array<T & { agentCount: number }>> {
  const counts = await db
    .select({
      clientId: agents.clientId,
      count: sql<number>`count(*)::int`,
    })
    .from(agents)
    .where(and(sql`${agents.clientId} IS NOT NULL`, ne(agents.status, "deleted")))
    .groupBy(agents.clientId);

  const countMap = new Map(counts.map((c) => [c.clientId, c.count]));

  return rows.map((row) => ({
    ...row,
    agentCount: countMap.get(row.id) ?? 0,
  }));
}

/**
 * Retire a client row. Refuses while any non-deleted agent is still pinned to
 * it — per proposal M12, the operator must delete the agents first
 * (no reassign in this milestone). Throws {@link ConflictError} with the
 * pinned agent list so the UI can show the exact names.
 *
 * Runs in a single transaction with `SELECT … FOR UPDATE` on the client row
 * so a concurrent `createAgent(clientId=X)` cannot land between the pinned
 * check and the DELETE — otherwise the agents.client_id RESTRICT FK would
 * surface as a raw PG 23503 instead of the ConflictError the caller expects.
 */
export async function retireClient(db: Database, clientId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ id: string }>(sql`SELECT id FROM clients WHERE id = ${clientId} FOR UPDATE`);
    if (!locked) {
      throw new NotFoundError(`Client "${clientId}" not found`);
    }

    const pinned = await tx
      .select({ uuid: agents.uuid, name: agents.name })
      .from(agents)
      .where(and(eq(agents.clientId, clientId), ne(agents.status, "deleted")));

    if (pinned.length > 0) {
      const names = pinned.map((a) => a.name ?? a.uuid).join(", ");
      throw new ConflictError(
        `Cannot retire client "${clientId}" — ${pinned.length} agent(s) still pinned (${names}). ` +
          "Delete the pinned agents first (no reassign is available in this milestone).",
      );
    }

    // Deleted (soft-deleted) agents may still carry the FK → clear it so
    // RESTRICT does not block the client delete. Only the active guard above is
    // a product-level check; tombstones should not veto operator actions.
    await tx
      .update(agents)
      .set({ clientId: null })
      .where(and(eq(agents.clientId, clientId), eq(agents.status, "deleted")));

    await tx.delete(clients).where(eq(clients.id, clientId));
  });
}

/**
 * System-scope sweep: mark clients as disconnected when their last-seen
 * server instance stopped sending heartbeats. Runs globally across all orgs
 * by design — it is invoked only by internal timers, never from a
 * user-scoped request, so the per-org filter the read paths enforce does not
 * apply. Org isolation on the data these clients belong to is still
 * enforced at the read paths (see `assertClientOwner` / `listClients`).
 */
export async function cleanupStaleClients(db: Database, staleSeconds = 60): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE clients SET status = 'disconnected'
    WHERE instance_id IN (
      SELECT instance_id FROM server_instances
      WHERE last_heartbeat < NOW() - make_interval(secs => ${staleSeconds})
    )
    AND status = 'connected'
    RETURNING id
  `);

  if (result.length > 0) {
    const staleIds = result.map((r) => r.id);
    await db
      .update(agentPresence)
      .set({ status: "offline", ...runtimeFieldsReset(new Date()) })
      .where(inArray(agentPresence.clientId, staleIds));
  }

  return result.length;
}
