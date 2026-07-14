import { createHash, randomBytes } from "node:crypto";
import type { GitlabConnectionSummary } from "@first-tree/shared";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabConnectionAuditEvents } from "../db/schema/gitlab-connection-audit-events.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEndpointGenerations } from "../db/schema/gitlab-endpoint-generations.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

export function mintGitlabUrlBearer(): string {
  return randomBytes(32).toString("base64url");
}

export function hashGitlabUrlBearer(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function normalizeGitlabOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("GitLab origin must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("GitLab origin must not include credentials");
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error("GitLab origin must not include a path, query, or fragment");
  return url.origin;
}

export function buildClaimReadyGitlabDeliveryId(connectionId: string, upstreamId: string): string {
  const digest = createHash("sha256").update(upstreamId).digest("base64url");
  return `${connectionId}:${digest}`;
}

export async function createGitlabConnection(
  db: Database,
  input: { organizationId: string; memberId: string; displayName: string; instanceOrigin: string },
): Promise<{ connectionId: string; bearer: string }> {
  const connectionId = uuidv7();
  const bearer = mintGitlabUrlBearer();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(gitlabConnections).values({
      id: connectionId,
      organizationId: input.organizationId,
      displayName: input.displayName,
      instanceOrigin: normalizeGitlabOrigin(input.instanceOrigin),
      createdByMemberId: input.memberId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(gitlabEndpointGenerations).values({
      id: uuidv7(),
      connectionId,
      generation: 1,
      tokenHash: hashGitlabUrlBearer(bearer),
      status: "current",
      createdAt: now,
    });
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId: input.memberId,
      event: "created",
      createdAt: now,
    });
  });
  return { connectionId, bearer };
}

export async function rotateGitlabConnection(
  db: Database,
  connectionId: string,
  actorMemberId: string,
): Promise<{ bearer: string }> {
  const bearer = mintGitlabUrlBearer();
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({
        id: gitlabConnections.id,
        active: gitlabConnections.active,
        recoveryPending: gitlabConnections.recoveryPending,
      })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .limit(1)
      .for("update");
    if (!connection?.active) throw new NotFoundError("GitLab connection not found");
    if (connection.recoveryPending) throw new ConflictError("Complete GitLab connection recovery before rotating");
    const endpoints = await tx
      .select()
      .from(gitlabEndpointGenerations)
      .where(
        and(
          eq(gitlabEndpointGenerations.connectionId, connectionId),
          inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
        ),
      );
    if (endpoints.some((row) => row.status === "previous")) {
      throw new ConflictError("Complete the existing GitLab endpoint rotation before starting another");
    }
    const current = endpoints.find((row) => row.status === "current");
    if (!current) throw new ConflictError("GitLab connection has no current endpoint");
    const highestRows = await tx
      .select({ value: max(gitlabEndpointGenerations.generation) })
      .from(gitlabEndpointGenerations)
      .where(eq(gitlabEndpointGenerations.connectionId, connectionId));
    const highest = highestRows[0]?.value ?? 0;
    await tx
      .update(gitlabEndpointGenerations)
      .set({ status: "previous" })
      .where(eq(gitlabEndpointGenerations.id, current.id));
    await tx.insert(gitlabEndpointGenerations).values({
      id: uuidv7(),
      connectionId,
      generation: highest + 1,
      tokenHash: hashGitlabUrlBearer(bearer),
      status: "current",
    });
    await tx.update(gitlabConnections).set({ updatedAt: new Date() }).where(eq(gitlabConnections.id, connectionId));
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId,
      event: "rotation_started",
    });
  });
  return { bearer };
}

export async function completeGitlabConnectionRotation(
  db: Database,
  connectionId: string,
  actorMemberId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ active: gitlabConnections.active })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .limit(1)
      .for("update");
    if (!connection?.active) throw new NotFoundError("GitLab connection not found");
    const endpoints = await tx
      .select()
      .from(gitlabEndpointGenerations)
      .where(
        and(
          eq(gitlabEndpointGenerations.connectionId, connectionId),
          inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
        ),
      );
    const current = endpoints.find((row) => row.status === "current");
    const previous = endpoints.find((row) => row.status === "previous");
    if (!current || !previous) throw new ConflictError("No GitLab endpoint rotation is in progress");
    if (!current.firstSeenAt)
      throw new ConflictError("The new GitLab endpoint must receive a valid event before rotation can complete");
    const now = new Date();
    await tx
      .update(gitlabEndpointGenerations)
      .set({ status: "revoked", revokedAt: now, revokedReason: "rotation_completed" })
      .where(eq(gitlabEndpointGenerations.id, previous.id));
    await tx.update(gitlabConnections).set({ updatedAt: now }).where(eq(gitlabConnections.id, connectionId));
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId,
      event: "rotation_completed",
      createdAt: now,
    });
  });
}

export async function disableGitlabConnection(
  db: Database,
  connectionId: string,
  mode: "normal" | "incident",
  actorMemberId: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: gitlabConnections.id })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
    await tx
      .update(gitlabConnections)
      .set({
        active: false,
        recoveryPending: false,
        automaticActionsEnabled: false,
        disabledAt: now,
        disabledMode: mode,
        updatedAt: now,
      })
      .where(eq(gitlabConnections.id, connectionId));
    await tx
      .update(gitlabEndpointGenerations)
      .set({ status: "revoked", revokedAt: now, revokedReason: mode === "incident" ? "incident" : "disabled" })
      .where(
        and(
          eq(gitlabEndpointGenerations.connectionId, connectionId),
          inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
        ),
      );
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId,
      event: mode === "incident" ? "disabled_incident" : "disabled_normal",
      createdAt: now,
    });
  });
}

/** Issue a fresh endpoint after disable. It accepts Test/events but suppresses cards until recovery is completed. */
export async function rearmGitlabConnection(
  db: Database,
  connectionId: string,
  actorMemberId: string,
): Promise<{ bearer: string }> {
  const bearer = mintGitlabUrlBearer();
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ active: gitlabConnections.active })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
    if (connection.active) throw new ConflictError("Only disabled GitLab connections can be re-armed");
    const [highestRow] = await tx
      .select({ value: max(gitlabEndpointGenerations.generation) })
      .from(gitlabEndpointGenerations)
      .where(eq(gitlabEndpointGenerations.connectionId, connectionId));
    const now = new Date();
    await tx.insert(gitlabEndpointGenerations).values({
      id: uuidv7(),
      connectionId,
      generation: (highestRow?.value ?? 0) + 1,
      tokenHash: hashGitlabUrlBearer(bearer),
      status: "current",
      createdAt: now,
    });
    await tx
      .update(gitlabConnections)
      .set({
        active: true,
        recoveryPending: true,
        automaticActionsEnabled: false,
        lastValidInboundAt: null,
        lastProcessingFailureAt: null,
        lastProcessingFailureCode: null,
        updatedAt: now,
      })
      .where(eq(gitlabConnections.id, connectionId));
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId,
      event: "rearmed",
      createdAt: now,
    });
  });
  return { bearer };
}

export async function completeGitlabConnectionRecovery(
  db: Database,
  connectionId: string,
  actorMemberId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ active: gitlabConnections.active, recoveryPending: gitlabConnections.recoveryPending })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .for("update")
      .limit(1);
    if (!connection?.active || !connection.recoveryPending) {
      throw new ConflictError("GitLab connection recovery is not pending");
    }
    const [current] = await tx
      .select({ firstSeenAt: gitlabEndpointGenerations.firstSeenAt })
      .from(gitlabEndpointGenerations)
      .where(
        and(eq(gitlabEndpointGenerations.connectionId, connectionId), eq(gitlabEndpointGenerations.status, "current")),
      )
      .limit(1);
    if (!current?.firstSeenAt) throw new ConflictError("The fresh endpoint must receive a valid event first");
    const now = new Date();
    await tx
      .update(gitlabConnections)
      .set({ recoveryPending: false, disabledAt: null, disabledMode: null, updatedAt: now })
      .where(eq(gitlabConnections.id, connectionId));
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId,
      event: "recovery_completed",
      createdAt: now,
    });
  });
}

export async function setGitlabAutomaticActions(
  db: Database,
  connectionId: string,
  memberId: string,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(gitlabConnections)
      .set({
        automaticActionsEnabled: enabled,
        ...(enabled ? { automaticActionsAcceptedAt: now, automaticActionsAcceptedByMemberId: memberId } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(gitlabConnections.id, connectionId),
          eq(gitlabConnections.active, true),
          eq(gitlabConnections.recoveryPending, false),
        ),
      )
      .returning({ id: gitlabConnections.id });
    if (updated.length === 0) {
      throw new ConflictError("Disabled or recovering GitLab connections cannot change automatic actions");
    }
    await tx.insert(gitlabConnectionAuditEvents).values({
      id: uuidv7(),
      connectionId,
      actorMemberId: memberId,
      event: enabled ? "automatic_actions_accepted" : "automatic_actions_revoked",
      createdAt: now,
    });
  });
}

export async function findActiveGitlabEndpoint(db: Database, token: string) {
  const [row] = await db
    .select({ connection: gitlabConnections, endpoint: gitlabEndpointGenerations })
    .from(gitlabEndpointGenerations)
    .innerJoin(gitlabConnections, eq(gitlabEndpointGenerations.connectionId, gitlabConnections.id))
    .where(
      and(
        eq(gitlabEndpointGenerations.tokenHash, hashGitlabUrlBearer(token)),
        inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
        eq(gitlabConnections.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Serialize inbound processing and all of its durable side effects against disable/revoke. */
export async function withGitlabIngressFence<T>(
  db: Database,
  connectionId: string,
  endpointId: string,
  callback: (tx: Database, connection: typeof gitlabConnections.$inferSelect) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [connection] = await rawTx
      .select()
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .for("update")
      .limit(1);
    if (!connection?.active) throw new NotFoundError("GitLab webhook endpoint not found");
    const [endpoint] = await rawTx
      .select({ id: gitlabEndpointGenerations.id })
      .from(gitlabEndpointGenerations)
      .where(
        and(
          eq(gitlabEndpointGenerations.id, endpointId),
          eq(gitlabEndpointGenerations.connectionId, connectionId),
          inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
        ),
      )
      .limit(1);
    if (!endpoint) throw new NotFoundError("GitLab webhook endpoint not found");
    return callback(tx, connection);
  });
}

export async function markGitlabInboundSeen(db: Database, connectionId: string, endpointId: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(gitlabEndpointGenerations)
      .set({ firstSeenAt: sql`coalesce(${gitlabEndpointGenerations.firstSeenAt}, now())`, lastSeenAt: now })
      .where(
        and(
          eq(gitlabEndpointGenerations.id, endpointId),
          eq(gitlabEndpointGenerations.connectionId, connectionId),
          inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
        ),
      );
    await tx
      .update(gitlabConnections)
      .set({ lastValidInboundAt: now, lastProcessingFailureAt: null, lastProcessingFailureCode: null, updatedAt: now })
      .where(and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.active, true)));
  });
}

export async function markGitlabProcessingFailure(db: Database, connectionId: string, code: string): Promise<void> {
  await db
    .update(gitlabConnections)
    .set({ lastProcessingFailureAt: new Date(), lastProcessingFailureCode: code, updatedAt: new Date() })
    .where(and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.active, true)));
}

export async function getGitlabConnectionSummary(db: Database, connectionId: string): Promise<GitlabConnectionSummary> {
  const [connection] = await db.select().from(gitlabConnections).where(eq(gitlabConnections.id, connectionId)).limit(1);
  if (!connection) throw new NotFoundError("GitLab connection not found");
  const endpoints = await db
    .select()
    .from(gitlabEndpointGenerations)
    .where(
      and(
        eq(gitlabEndpointGenerations.connectionId, connectionId),
        inArray(gitlabEndpointGenerations.status, ["current", "previous"]),
      ),
    )
    .orderBy(asc(gitlabEndpointGenerations.generation));
  const current = endpoints.find((row) => row.status === "current");
  const previous = endpoints.find((row) => row.status === "previous");
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    displayName: connection.displayName,
    instanceOrigin: connection.instanceOrigin,
    active: connection.active,
    recoveryPending: connection.recoveryPending,
    automaticActionsEnabled: connection.automaticActionsEnabled,
    reviewerMode: connection.reviewerMode as GitlabConnectionSummary["reviewerMode"],
    endpoint: {
      currentGeneration: current?.generation ?? null,
      previousGeneration: previous?.generation ?? null,
      currentSeen: current?.firstSeenAt != null,
    },
    health: {
      lastValidInboundAt: connection.lastValidInboundAt?.toISOString() ?? null,
      lastProcessingFailureAt: connection.lastProcessingFailureAt?.toISOString() ?? null,
      lastProcessingFailureCode: connection.lastProcessingFailureCode,
    },
    disabledAt: connection.disabledAt?.toISOString() ?? null,
    disabledMode: connection.disabledMode as "normal" | "incident" | null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export async function listGitlabConnections(db: Database, organizationId: string): Promise<GitlabConnectionSummary[]> {
  const rows = await db
    .select({ id: gitlabConnections.id })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, organizationId))
    .orderBy(asc(gitlabConnections.createdAt));
  return Promise.all(rows.map((row) => getGitlabConnectionSummary(db, row.id)));
}
