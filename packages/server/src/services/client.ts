import {
  type ClientCapabilities,
  clientCapabilitiesSchema,
  type RuntimeProvider,
  type UpdateAttempt,
  updateAttemptSchema,
} from "@first-tree/shared";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
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
  // Archived rows are 404 from the user's perspective — they were
  // sweep-soft-deleted, so admin actions against them must go through
  // SQL recovery, not the regular owner-scoped routes.
  const [row] = await db
    .select({ id: clients.id, userId: clients.userId, archivedAt: clients.archivedAt })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row || row.userId !== scope.userId || row.archivedAt !== null) {
    throw new NotFoundError(`Client "${clientId}" not found`);
  }
}

/**
 * Outcome of {@link registerClient}.
 *
 * - `canonicalClientId` — the id the WS handler must use to track this
 *   session going forward. Differs from the caller's `data.clientId` only
 *   on the soft-dedup redirect path (B).
 * - `redirected` — true iff soft-dedup picked an existing row to merge
 *   the new connection into. The WS handler tells the CLI by setting
 *   the `client:registered` frame's `clientId` to `canonicalClientId`;
 *   a new-protocol CLI compares and updates yaml.
 */
export type RegisterClientResult = {
  canonicalClientId: string;
  redirected: boolean;
};

/**
 * Soft-dedup refused because the canonical row is currently held by
 * another live socket. The WS handler maps this to
 * `client:register:rejected { code: "CLIENT_DEDUP_CONFLICT" }` and
 * closes 4403 so the offending CLI does not silently steal the slot
 * every reconnect. CLI side: error class lives in
 * `packages/client/src/client-connection.ts` for protocol symmetry.
 */
export class ClientDedupConflictError extends Error {
  readonly code = "CLIENT_DEDUP_CONFLICT";
  constructor(canonicalId: string) {
    super(`Another client is currently connected as canonical "${canonicalId}". Retry later.`);
    this.name = "ClientDedupConflictError";
  }
}

/**
 * Upsert / soft-dedup the clients row for a given `client_id` under an
 * authenticated user.
 *
 * Three branches:
 *
 *   (A) **Same-id path** — a row with the caller's `clientId` already
 *       exists. Runs the existing user-mismatch + upsert logic.
 *       `archived_at` is cleared so a returning install (rare: archived
 *       row whose owner kept yaml) auto-resurrects. Returns the caller's
 *       id, `redirected: false`.
 *
 *   (B) **Dedup path** — caller's id is brand new AND both `hostname`
 *       and `os` are present. Acquires a transaction-scoped advisory
 *       lock on `hash(user_id | hostname | os)` so two concurrent
 *       first-time registers from the same machine serialize. Then
 *       picks a canonical row via {@link pickCanonical}; if one is
 *       found, the new connection's runtime info is merged onto the
 *       canonical row (clearing `archived_at` on the way) and the
 *       caller's id is never inserted. If the canonical slot is held by
 *       a different live socket, {@link ClientDedupConflictError} is
 *       thrown so the offending CLI bounces instead of stealing.
 *
 *   (C) **Plain insert** — caller's id is new and there is no anchor
 *       (no hostname/os, or no canonical match). Inserts a fresh row.
 *
 * Cross-user same-id still raises {@link ClientUserMismatchError} (WS
 * close 4403); the CLI guides the operator through `first-tree login
 * <token> --override`.
 *
 * @param isCanonicalSlotLive Injected by the WS handler. Returns true
 *   iff the canonical id currently has a live socket held by
 *   `connectionManager` that is NOT this caller. Defaults to `() =>
 *   false` for unit tests / service-layer callers that don't have a
 *   `connectionManager` in scope; bypassing the guard outside the WS
 *   handler is safe because there's no real socket to steal.
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
  isCanonicalSlotLive: (canonicalId: string) => boolean = () => false,
): Promise<RegisterClientResult> {
  const now = new Date();

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

  return db.transaction(async (tx) => {
    // (A) Same-id path. No dedup query, no advisory lock — normal
    // reconnect stays O(1).
    const [existing] = await tx
      .select({ id: clients.id, userId: clients.userId, archivedAt: clients.archivedAt })
      .from(clients)
      .where(eq(clients.id, data.clientId))
      .limit(1);

    if (existing) {
      if (existing.userId && existing.userId !== data.userId) {
        throw new ClientUserMismatchError(
          `Client "${data.clientId}" is owned by a different user. ` +
            "Run `first-tree login <token> --override` to transfer ownership.",
        );
      }
      // Refuse to first-time-claim an archived legacy (user_id NULL) row.
      // The archival sweep already judged this row abandoned; allowing any
      // user who learns the client_id to claim it (the existing legacy-
      // claim path) would open an attack window since `client.id` may end
      // up in server logs, screenshots, or shared filesystems. Returning
      // users with their own row (existing.userId === data.userId) hit
      // the same-user branch above and are NOT affected — they retain
      // their identity and the row unarchives below.
      if (existing.userId === null && existing.archivedAt !== null) {
        throw new ClientUserMismatchError(
          `Client "${data.clientId}" is archived and cannot be claimed. ` +
            "Generate a fresh connect token and let the server assign a new identity.",
        );
      }
      await tx
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
            // Unarchive on reconnect — if this row was previously
            // archived by the sweep, returning the user to the same
            // identity should resurrect it transparently.
            archivedAt: null,
            ...(metadataMerge ? { metadata: metadataMerge } : {}),
          },
        });
      return { canonicalClientId: data.clientId, redirected: false };
    }

    // (C) Plain-insert path when there's no anchor to dedup on.
    if (!data.hostname || !data.os) {
      await tx.insert(clients).values({
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
      });
      return { canonicalClientId: data.clientId, redirected: false };
    }

    // (B) Dedup path. Acquire an advisory lock keyed on the dedup tuple
    // BEFORE the candidate SELECT — `SELECT ... FOR UPDATE` would not
    // serialize concurrent first-time registers because an empty result
    // set locks nothing. The advisory lock is transaction-scoped (auto-
    // released at COMMIT/ROLLBACK) and survives empty SELECTs.
    //
    // `hashtextextended` (64-bit, seed 0) instead of `hashtext` (32-bit):
    // PG's int4 advisory keyspace lands ~50% collision odds around 65k
    // distinct active tuples, causing unrelated `(user, host, os)` triples
    // to serialize for no semantic reason. int8 keyspace is 2^64 — same
    // protocol, ~zero false sharing.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${data.userId} || '|' || ${data.hostname} || '|' || ${data.os}, 0))`,
    );

    // Re-check after acquiring the lock: a concurrent register that won
    // the race may have just INSERTed the caller's id (unlikely — caller
    // ids are freshly generated UUIDs — but the cost of a defensive
    // re-check is one indexed lookup).
    const [insertedConcurrently] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, data.clientId))
      .limit(1);
    if (insertedConcurrently) {
      // Fall through to the same-id upsert path that the (A) branch
      // takes. Easier than re-implementing: do another tiny upsert here.
      await tx
        .update(clients)
        .set({
          userId: data.userId,
          status: "connected",
          instanceId: data.instanceId,
          hostname: data.hostname,
          os: data.os,
          sdkVersion: data.sdkVersion ?? null,
          connectedAt: now,
          lastSeenAt: now,
          archivedAt: null,
          ...(metadataMerge ? { metadata: metadataMerge } : {}),
        })
        .where(eq(clients.id, data.clientId));
      return { canonicalClientId: data.clientId, redirected: false };
    }

    const candidateRows = await tx
      .select({
        id: clients.id,
        status: clients.status,
        lastSeenAt: clients.lastSeenAt,
        archivedAt: clients.archivedAt,
      })
      .from(clients)
      .where(and(eq(clients.userId, data.userId), eq(clients.hostname, data.hostname), eq(clients.os, data.os)));

    // Two-step agent-count: GROUP BY + FOR UPDATE is invalid in PG
    // (cannot lock through an aggregate). The advisory lock scopes ONLY
    // to other concurrent `registerClient`s on the same (user, host, os) —
    // it does NOT cover the `agents` table, so an admin PATCH that
    // rebinds `agents.client_id` while we read may shift the count.
    // Worst case: pickCanonical picks the wrong canonical (priority
    // delta), no data loss. Acceptable under soft-dedup semantics.
    const candidateIds = candidateRows.map((r) => r.id);
    const agentCounts =
      candidateIds.length > 0
        ? await tx
            .select({ clientId: agents.clientId, count: sql<number>`count(*)::int` })
            .from(agents)
            .where(
              and(
                sql`${agents.clientId} IS NOT NULL`,
                inArray(agents.clientId, candidateIds),
                ne(agents.status, "deleted"),
              ),
            )
            .groupBy(agents.clientId)
        : [];
    const counts = new Map(agentCounts.map((c) => [c.clientId, c.count]));

    const canonical = pickCanonical(
      candidateRows.map((r) => ({
        id: r.id,
        status: r.status as "connected" | "disconnected",
        lastSeenAt: r.lastSeenAt,
        agentCount: counts.get(r.id) ?? 0,
        archivedAt: r.archivedAt,
      })),
    );

    if (!canonical) {
      // No canonical to merge into — plain INSERT with the caller's id.
      await tx.insert(clients).values({
        id: data.clientId,
        userId: data.userId,
        organizationId: data.organizationId,
        status: "connected",
        instanceId: data.instanceId,
        hostname: data.hostname,
        os: data.os,
        sdkVersion: data.sdkVersion ?? null,
        connectedAt: now,
        lastSeenAt: now,
        ...(data.lastUpdateAttempt ? { metadata: { lastUpdateAttempt: data.lastUpdateAttempt } } : {}),
      });
      return { canonicalClientId: data.clientId, redirected: false };
    }

    // Connection-stealing guard: a different live socket is currently
    // registered as canonical. Refuse the dedup; offending CLI gets a
    // `CLIENT_DEDUP_CONFLICT` error and bounces with reconnect backoff.
    if (isCanonicalSlotLive(canonical.id)) {
      throw new ClientDedupConflictError(canonical.id);
    }

    // Redirect-merge: take the caller's connection info onto the canonical
    // row. `archivedAt: null` resurrects archived canonicals on return.
    await tx
      .update(clients)
      .set({
        status: "connected",
        instanceId: data.instanceId,
        sdkVersion: data.sdkVersion ?? null,
        connectedAt: now,
        lastSeenAt: now,
        archivedAt: null,
        ...(metadataMerge ? { metadata: metadataMerge } : {}),
      })
      .where(eq(clients.id, canonical.id));
    return { canonicalClientId: canonical.id, redirected: true };
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
  // Filter out archived rows — they're soft-deleted from the user's
  // perspective (sweep gave up on them). Admin SQL can resurrect by
  // clearing `archived_at`; this read path stays simple.
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), isNull(clients.archivedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * One candidate row in the soft-dedup canonical decision. Mirrors the
 * column subset `registerClient` actually consults — kept separate from
 * `Client` (the full DTO) so {@link pickCanonical} stays a pure function
 * over plain data, testable without a DB.
 */
export type DedupCandidate = {
  id: string;
  status: "connected" | "disconnected";
  lastSeenAt: Date;
  agentCount: number;
  archivedAt: Date | null;
};

/**
 * Pick the canonical row for a `(user_id, hostname, os)` candidate set
 * during soft-dedup. Pure — sorts a copy of the input, never mutates.
 *
 * Priority (most preferred first):
 *   1. Non-archived rows beat archived. An archived row was abandoned
 *      long enough ago that the sweep gave up on it; a live row should
 *      take over the identity instead of resurrecting a dead one.
 *   2. Higher `agentCount` beats lower. A row with pinned work is the
 *      one that holds the user's state — losing its identity would
 *      orphan their agents.
 *   3. More-recent `lastSeenAt` beats older.
 *   4. Lexicographically smaller `id` beats larger. UUID v7 sorts ≈
 *      ascending creation time, so this stable tie-break prefers the
 *      oldest row — keeping identity continuity for the longest-lived
 *      install.
 *
 * Returns null only when the candidate set is empty.
 */
export function pickCanonical(candidates: DedupCandidate[]): DedupCandidate | null {
  if (candidates.length === 0) return null;
  return (
    [...candidates].sort((a, b) => {
      const aArchived = a.archivedAt !== null;
      const bArchived = b.archivedAt !== null;
      if (aArchived !== bArchived) return aArchived ? 1 : -1;
      if (a.agentCount !== b.agentCount) return b.agentCount - a.agentCount;
      const aMs = a.lastSeenAt.getTime();
      const bMs = b.lastSeenAt.getTime();
      if (aMs !== bMs) return bMs - aMs;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    })[0] ?? null
  );
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
    .where(and(eq(clients.userId, scope.userId), ne(agents.status, "deleted"), isNull(clients.archivedAt)));
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
  const rows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.userId, scope.userId), isNull(clients.archivedAt)));
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
    .where(and(eq(members.organizationId, orgId), eq(members.status, "active"), isNull(clients.archivedAt)));
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

/**
 * Default threshold for the orphan-row archival sweep. A `clients` row
 * is auto-archived when ALL of the following hold:
 *   1. `status = 'disconnected'`
 *   2. `last_seen_at < NOW() - ORPHAN_ARCHIVAL_STALE_DAYS days`
 *   3. zero non-deleted agents are pinned to it
 *   4. it is not already archived (idempotency guard)
 *
 * 30 days is a deliberate product decision (2026-05-27): long enough to
 * survive a typical vacation / contractor cycle, short enough that
 * abandoned `client.yaml` regenerations clear within a month. Decoupled
 * from the auth refresh-token TTL — even if a row's creds are still
 * mintable, an unused machine for 30 days with no pinned work is
 * treated as abandoned.
 *
 * Returns become recoverable via admin SQL: `UPDATE clients SET
 * archived_at = NULL WHERE id = '...'`. Or transparent unarchive when
 * the same yaml id reconnects — see `registerClient` (A) path.
 */
export const ORPHAN_ARCHIVAL_STALE_DAYS = 30;

/**
 * Sweep abandoned `clients` rows: set `archived_at = NOW()` on rows
 * meeting all four conditions above. Read paths exclude `archived_at IS
 * NOT NULL` so the row stops surfacing in the UI / API; the row stays
 * in the table for audit and recovery.
 *
 * Returns the number of rows archived. Cheap: a single indexed UPDATE
 * via `idx_clients_sweep` (status, last_seen_at) WHERE archived_at IS
 * NULL. Idempotent on the second sweep within the same window — the
 * `archived_at IS NULL` guard skips rows we already archived.
 *
 * Driven by `services/background-tasks.ts` on an hourly timer.
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
