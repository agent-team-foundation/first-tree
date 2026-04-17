import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { runtimeFieldsReset } from "./presence.js";

/**
 * Assert the caller's user owns this client. Throws 404 for both "not found"
 * and "not yours" to prevent UUID enumeration across org/user boundaries.
 * Used by management routes (disconnect, retire, single GET) so a cross-org
 * admin cannot operate on another user's client.
 */
export async function assertClientOwner(db: Database, clientId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ id: clients.id, userId: clients.userId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row || row.userId !== userId) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
}

/**
 * Upsert the clients row for a given `client_id` under an authenticated user.
 *
 * Claim semantics (see proposal M13):
 *   - New client_id → INSERT with the authenticated user_id.
 *   - Existing row with `user_id IS NULL` → claim it (set user_id).
 *   - Existing row with a different user_id → {@link ForbiddenError}; the
 *     operator must pick a different clientId. This is a hard conflict rather
 *     than a silent override because the pinned agents under that client
 *     belong to the original owner.
 */
export async function registerClient(
  db: Database,
  data: {
    clientId: string;
    userId: string;
    instanceId: string;
    hostname?: string;
    os?: string;
    sdkVersion?: string;
  },
) {
  const now = new Date();

  const [existing] = await db
    .select({ id: clients.id, userId: clients.userId })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);

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

export async function listClients(db: Database, userId?: string) {
  const conditions = [eq(clients.status, "connected")];
  if (userId) conditions.push(eq(clients.userId, userId));
  const rows = await db
    .select()
    .from(clients)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions));
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
