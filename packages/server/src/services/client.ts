import {
  type ClientCapabilities,
  clientCapabilitiesSchema,
  type RuntimeProvider,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, ClientOrgMismatchError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { runtimeFieldsReset } from "./presence.js";

/**
 * Assert the caller can act on this client. Throws 404 for both "not found"
 * and "not yours" to prevent UUID enumeration across org/user boundaries.
 *
 * A client is bound to exactly one organization (`clients.organization_id`).
 * Access is granted when:
 *   - member: row.user_id == scope.userId AND row.organization_id == scope.organizationId.
 *   - admin: row.organization_id == scope.organizationId AND the owner is a
 *     member of that same org (defense in depth).
 *
 * Same user across two orgs has two distinct client rows; operating on one
 * while logged into the other is refused by the org filter.
 */
export async function assertClientOwner(
  db: Database,
  clientId: string,
  scope: { userId: string; organizationId: string; role: string },
): Promise<void> {
  const [row] = await db
    .select({ id: clients.id, userId: clients.userId, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
  if (row.organizationId !== scope.organizationId) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
  if (row.userId === scope.userId) return;
  if (scope.role === "admin" && row.userId !== null) {
    const [sibling] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, row.userId), eq(members.organizationId, scope.organizationId)))
      .limit(1);
    if (sibling) return;
  }
  throw new NotFoundError(`Client "${clientId}" not found`);
}

/**
 * Upsert the clients row for a given `client_id` under an authenticated user.
 *
 * Claim semantics (see proposal M13 + multi-tenancy hardening):
 *   - New client_id → INSERT with the authenticated user_id and org_id.
 *   - Existing row with the same user_id + org_id → refresh runtime columns.
 *   - Existing row in a different org → {@link ClientOrgMismatchError}. A
 *     client is bound to one org for its lifetime; the CLI reacts by
 *     abandoning the local clientId and registering a new one.
 *   - Existing row with a different user_id (same org) → {@link ForbiddenError};
 *     the operator must pick a different clientId. Hard conflict because
 *     pinned agents under that client belong to the original owner.
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
  },
) {
  const now = new Date();

  const [existing] = await db
    .select({ id: clients.id, userId: clients.userId, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);

  if (existing && existing.organizationId !== data.organizationId) {
    throw new ClientOrgMismatchError(
      `Client "${data.clientId}" is bound to a different organization. Re-register as a new client under the current org.`,
    );
  }

  if (existing?.userId && existing.userId !== data.userId) {
    throw new ForbiddenError(
      `Client "${data.clientId}" is already claimed by a different user. Pick a unique client_id.`,
    );
  }

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
      },
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
 * List the active agents currently pinned to a client. Used by the WS
 * registration handshake to backfill `agent:pinned` notifications missed while
 * the client was offline — without it, an admin who pinned an agent during a
 * client outage would still need a manual `first-tree-hub agent add`.
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
 * Member-scoped: every active agent pinned to a client owned by this user
 * within the given organization. Used by client startup to reconcile its
 * local YAML against the authoritative `agents.runtime_provider`.
 */
export async function listMyPinnedAgents(
  db: Database,
  scope: { userId: string; organizationId: string },
): Promise<Array<{ agentId: string; clientId: string; runtimeProvider: RuntimeProvider }>> {
  const rows = await db
    .select({
      agentId: agents.uuid,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
    })
    .from(agents)
    .innerJoin(clients, eq(agents.clientId, clients.id))
    .where(
      and(
        eq(clients.userId, scope.userId),
        eq(clients.organizationId, scope.organizationId),
        ne(agents.status, "deleted"),
      ),
    );
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
 * Scope-aware client listing.
 *
 *   - member: rows where `user_id = scope.userId` AND `organization_id = scope.organizationId`
 *     — protects against a user listing their own clients registered under a
 *     different org when they're logged into this one.
 *   - admin: every row in `scope.organizationId`, regardless of owner.
 */
export async function listClients(db: Database, scope: { userId: string; organizationId: string; role: string }) {
  const rows =
    scope.role === "admin"
      ? await db
          .select({
            id: clients.id,
            userId: clients.userId,
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
          .where(eq(clients.organizationId, scope.organizationId))
      : await db
          .select()
          .from(clients)
          .where(and(eq(clients.userId, scope.userId), eq(clients.organizationId, scope.organizationId)));

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
