import { createHash, randomBytes } from "node:crypto";
import type { GitlabAutomaticActionsAudit, GitlabConnectionSummary, GitlabReviewerMode } from "@first-tree/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabAutomaticActionsAudit } from "../db/schema/gitlab-automatic-actions-audit.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { suspendGitlabLinksForConnection } from "./gitlab-identities.js";

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

type GitlabConnectionInput = {
  organizationId: string;
  memberId: string;
  displayName: string;
  instanceOrigin: string;
};

type AutomaticActionsAuditSnapshot = {
  id: string;
  organizationId: string;
  instanceOrigin: string;
  automaticActionsEnabled: boolean;
};

async function appendAutomaticActionsAudit(
  db: Database,
  connection: AutomaticActionsAuditSnapshot,
  input: { enabled: boolean; actorMemberId: string | null; reason: string; createdAt?: Date },
): Promise<void> {
  await db.insert(gitlabAutomaticActionsAudit).values({
    id: uuidv7(),
    organizationId: connection.organizationId,
    connectionId: connection.id,
    instanceOrigin: connection.instanceOrigin,
    enabled: input.enabled,
    actorMemberId: input.actorMemberId,
    reason: input.reason,
    createdAt: input.createdAt ?? new Date(),
  });
}

async function lockOrganization(db: Database, organizationId: string): Promise<void> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!organization) throw new NotFoundError("Organization not found");
}

async function insertGitlabConnection(db: Database, input: GitlabConnectionInput, bearer: string): Promise<string> {
  const connectionId = uuidv7();
  const now = new Date();
  await db.insert(gitlabConnections).values({
    id: connectionId,
    organizationId: input.organizationId,
    displayName: input.displayName,
    instanceOrigin: normalizeGitlabOrigin(input.instanceOrigin),
    tokenHash: hashGitlabUrlBearer(bearer),
    createdByMemberId: input.memberId,
    updatedByMemberId: input.memberId,
    createdAt: now,
    updatedAt: now,
  });
  return connectionId;
}

export async function createGitlabConnection(
  db: Database,
  input: GitlabConnectionInput,
): Promise<{ connectionId: string; bearer: string }> {
  const bearer = mintGitlabUrlBearer();
  const connectionId = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockOrganization(tx, input.organizationId);
    const [existing] = await tx
      .select({ id: gitlabConnections.id })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.organizationId, input.organizationId))
      .limit(1);
    if (existing) throw new ConflictError("Organization already has a GitLab connection");
    return insertGitlabConnection(tx, input, bearer);
  });
  return { connectionId, bearer };
}

/** Replace the Team's only GitLab binding. Cascades remove stale entity/chat projections. */
export async function replaceGitlabConnection(
  db: Database,
  input: GitlabConnectionInput & { expectedConnectionId: string },
): Promise<{ connectionId: string; bearer: string }> {
  const bearer = mintGitlabUrlBearer();
  const connectionId = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockOrganization(tx, input.organizationId);
    const [current] = await tx
      .select({
        id: gitlabConnections.id,
        organizationId: gitlabConnections.organizationId,
        instanceOrigin: gitlabConnections.instanceOrigin,
        automaticActionsEnabled: gitlabConnections.automaticActionsEnabled,
      })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.organizationId, input.organizationId))
      .for("update")
      .limit(1);
    if (!current || current.id !== input.expectedConnectionId) {
      throw new ConflictError("GitLab connection changed or was removed; refresh before replacing it");
    }
    await suspendGitlabLinksForConnection(tx, current.id, input.memberId);
    if (current.automaticActionsEnabled) {
      await appendAutomaticActionsAudit(tx, current, {
        enabled: false,
        actorMemberId: input.memberId,
        reason: "connection_replaced",
      });
    }
    const [deleted] = await tx
      .delete(gitlabConnections)
      .where(eq(gitlabConnections.id, input.expectedConnectionId))
      .returning({ id: gitlabConnections.id });
    if (!deleted) throw new ConflictError("GitLab connection changed or was removed; refresh before replacing it");
    return insertGitlabConnection(tx, input, bearer);
  });
  return { connectionId, bearer };
}

/** Replace the only active bearer. The old URL stops authenticating as soon as this transaction commits. */
export async function regenerateGitlabConnectionBearer(
  db: Database,
  connectionId: string,
  memberId: string,
): Promise<{ bearer: string }> {
  const bearer = mintGitlabUrlBearer();
  const [updated] = await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: gitlabConnections.id })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
    return tx
      .update(gitlabConnections)
      .set({
        tokenHash: hashGitlabUrlBearer(bearer),
        endpointFirstSeenAt: null,
        lastValidInboundAt: null,
        lastProcessingFailureAt: null,
        lastProcessingFailureCode: null,
        updatedByMemberId: memberId,
        updatedAt: new Date(),
      })
      .where(eq(gitlabConnections.id, connectionId))
      .returning({ id: gitlabConnections.id });
  });
  if (!updated) throw new NotFoundError("GitLab connection not found");
  return { bearer };
}

export async function deleteGitlabConnection(
  db: Database,
  connectionId: string,
  actorMemberId: string | null = null,
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [candidate] = await tx
      .select({ organizationId: gitlabConnections.organizationId })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .limit(1);
    if (!candidate) throw new NotFoundError("GitLab connection not found");

    await lockOrganization(tx, candidate.organizationId);
    const [connection] = await tx
      .select({
        id: gitlabConnections.id,
        organizationId: gitlabConnections.organizationId,
        instanceOrigin: gitlabConnections.instanceOrigin,
        automaticActionsEnabled: gitlabConnections.automaticActionsEnabled,
      })
      .from(gitlabConnections)
      .where(
        and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.organizationId, candidate.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
    await suspendGitlabLinksForConnection(tx, connection.id, actorMemberId);
    if (connection.automaticActionsEnabled) {
      await appendAutomaticActionsAudit(tx, connection, {
        enabled: false,
        actorMemberId,
        reason: "connection_deleted",
      });
    }
    const [deleted] = await tx
      .delete(gitlabConnections)
      .where(eq(gitlabConnections.id, connectionId))
      .returning({ id: gitlabConnections.id });
    if (!deleted) throw new NotFoundError("GitLab connection not found");
  });
}

export async function findActiveGitlabEndpoint(db: Database, token: string) {
  const [connection] = await db
    .select()
    .from(gitlabConnections)
    .where(eq(gitlabConnections.tokenHash, hashGitlabUrlBearer(token)))
    .limit(1);
  return connection ? { connection } : null;
}

/** Serialize inbound durable effects against bearer regeneration, replacement, and deletion. */
export async function withGitlabIngressFence<T>(
  db: Database,
  connectionId: string,
  tokenHash: string,
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
    if (!connection || connection.tokenHash !== tokenHash) throw new NotFoundError("GitLab webhook endpoint not found");
    return callback(tx, connection);
  });
}

export async function markGitlabInboundSeen(db: Database, connectionId: string, tokenHash: string): Promise<void> {
  const now = new Date();
  await db
    .update(gitlabConnections)
    .set({
      endpointFirstSeenAt: sql`coalesce(${gitlabConnections.endpointFirstSeenAt}, now())`,
      lastValidInboundAt: now,
      lastProcessingFailureAt: null,
      lastProcessingFailureCode: null,
      updatedAt: now,
    })
    .where(and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.tokenHash, tokenHash)));
}

export async function markGitlabStableDeliveryObserved(db: Database, connectionId: string): Promise<void> {
  await db
    .update(gitlabConnections)
    .set({
      stableDeliveryObservedAt: sql`coalesce(${gitlabConnections.stableDeliveryObservedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(eq(gitlabConnections.id, connectionId));
}

export async function setGitlabAutomaticActions(
  db: Database,
  input: {
    connectionId: string;
    organizationId: string;
    actorMemberId: string;
    enabled: boolean;
    acceptTeamWideForgeryRisk?: boolean;
    reason?: string;
  },
): Promise<GitlabConnectionSummary> {
  if (input.enabled && input.acceptTeamWideForgeryRisk !== true) {
    throw new BadRequestError("Enabling automatic actions requires accepting the Team-wide URL bearer forgery risk");
  }
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [connection] = await tx
      .select()
      .from(gitlabConnections)
      .where(
        and(eq(gitlabConnections.id, input.connectionId), eq(gitlabConnections.organizationId, input.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
    if (connection.automaticActionsEnabled === input.enabled) return;
    const now = new Date();
    await tx
      .update(gitlabConnections)
      .set({
        automaticActionsEnabled: input.enabled,
        automaticActionsAcceptedAt: input.enabled ? now : null,
        automaticActionsAcceptedByMemberId: input.enabled ? input.actorMemberId : null,
        updatedByMemberId: input.actorMemberId,
        updatedAt: now,
      })
      .where(eq(gitlabConnections.id, connection.id));
    await appendAutomaticActionsAudit(tx, connection, {
      enabled: input.enabled,
      actorMemberId: input.actorMemberId,
      reason: input.reason ?? (input.enabled ? "team_risk_accepted" : "team_risk_withdrawn"),
      createdAt: now,
    });
  });
  return getGitlabConnectionSummary(db, input.connectionId);
}

export async function confirmGitlabAssigneeMode(
  db: Database,
  input: { connectionId: string; organizationId: string; actorMemberId: string },
): Promise<GitlabConnectionSummary> {
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ mode: gitlabConnections.reviewerMode })
      .from(gitlabConnections)
      .where(
        and(eq(gitlabConnections.id, input.connectionId), eq(gitlabConnections.organizationId, input.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
    if (connection.mode === "reviewers") {
      throw new ConflictError("Reviewer capability has already been observed and cannot downgrade to assignee mode");
    }
    if (connection.mode === "assignee") return;
    const now = new Date();
    await tx
      .update(gitlabConnections)
      .set({
        reviewerMode: "assignee",
        assigneeModeConfirmedAt: now,
        assigneeModeConfirmedByMemberId: input.actorMemberId,
        updatedByMemberId: input.actorMemberId,
        updatedAt: now,
      })
      .where(eq(gitlabConnections.id, input.connectionId));
  });
  return getGitlabConnectionSummary(db, input.connectionId);
}

/** One-way capability latch. Must run under the connection ingress fence. */
export async function observeGitlabReviewersCapability(db: Database, connectionId: string): Promise<void> {
  await db
    .update(gitlabConnections)
    .set({
      reviewerMode: "reviewers",
      lastReviewerSchemaAnomalyAt: null,
      lastReviewerSchemaAnomalyCode: null,
      updatedAt: new Date(),
    })
    .where(eq(gitlabConnections.id, connectionId));
}

/** Actionable Settings signal; malformed payload never changes the reviewer mode. */
export async function markGitlabReviewerSchemaAnomaly(db: Database, connectionId: string, code: string): Promise<void> {
  await db
    .update(gitlabConnections)
    .set({ lastReviewerSchemaAnomalyAt: new Date(), lastReviewerSchemaAnomalyCode: code, updatedAt: new Date() })
    .where(eq(gitlabConnections.id, connectionId));
}

export async function listGitlabAutomaticActionsAudit(
  db: Database,
  organizationId: string,
  limit = 50,
): Promise<GitlabAutomaticActionsAudit[]> {
  const rows = await db
    .select()
    .from(gitlabAutomaticActionsAudit)
    .where(eq(gitlabAutomaticActionsAudit.organizationId, organizationId))
    .orderBy(desc(gitlabAutomaticActionsAudit.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    instanceOrigin: row.instanceOrigin,
    enabled: row.enabled,
    actorMemberId: row.actorMemberId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function markGitlabProcessingFailure(
  db: Database,
  connectionId: string,
  tokenHash: string,
  code: string,
): Promise<void> {
  await db
    .update(gitlabConnections)
    .set({ lastProcessingFailureAt: new Date(), lastProcessingFailureCode: code, updatedAt: new Date() })
    .where(and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.tokenHash, tokenHash)));
}

export async function getGitlabConnectionSummary(db: Database, connectionId: string): Promise<GitlabConnectionSummary> {
  const [connection] = await db.select().from(gitlabConnections).where(eq(gitlabConnections.id, connectionId)).limit(1);
  if (!connection) throw new NotFoundError("GitLab connection not found");
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    displayName: connection.displayName,
    instanceOrigin: connection.instanceOrigin,
    endpointSeen: connection.endpointFirstSeenAt != null,
    stableDeliveryObserved: connection.stableDeliveryObservedAt != null,
    automaticActions: {
      enabled: connection.automaticActionsEnabled,
      acceptedAt: connection.automaticActionsAcceptedAt?.toISOString() ?? null,
      acceptedByMemberId: connection.automaticActionsAcceptedByMemberId,
    },
    reviewerCapability: {
      mode: connection.reviewerMode as GitlabReviewerMode,
      assigneeConfirmedAt: connection.assigneeModeConfirmedAt?.toISOString() ?? null,
      assigneeConfirmedByMemberId: connection.assigneeModeConfirmedByMemberId,
      lastSchemaAnomalyAt: connection.lastReviewerSchemaAnomalyAt?.toISOString() ?? null,
      lastSchemaAnomalyCode: connection.lastReviewerSchemaAnomalyCode,
    },
    health: {
      lastValidInboundAt: connection.lastValidInboundAt?.toISOString() ?? null,
      lastProcessingFailureAt: connection.lastProcessingFailureAt?.toISOString() ?? null,
      lastProcessingFailureCode: connection.lastProcessingFailureCode,
    },
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export async function listGitlabConnections(db: Database, organizationId: string): Promise<GitlabConnectionSummary[]> {
  const [row] = await db
    .select({ id: gitlabConnections.id })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, organizationId))
    .limit(1);
  return row ? [await getGitlabConnectionSummary(db, row.id)] : [];
}
