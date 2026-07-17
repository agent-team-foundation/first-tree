import { createHash, randomBytes } from "node:crypto";
import type { GitlabConnectionSummary, GitlabReviewerMode } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { organizations } from "../db/schema/organizations.js";
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

export type DeclaredGitlabVersion = {
  value: string;
  supportsReviewerWebhooks: boolean;
};

/** Parse GitLab's documented `User-Agent: GitLab/<VERSION>` compatibility hint. */
export function parseDeclaredGitlabVersion(userAgent: string | undefined): DeclaredGitlabVersion | null {
  if (!userAgent) return null;
  const match = /^gitlab\/((\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?)$/i.exec(userAgent.trim());
  if (!match) return null;
  const major = Number(match[2]);
  const minor = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return {
    value: match[1] ?? `${major}.${minor}`,
    supportsReviewerWebhooks: major > 15 || (major === 15 && minor >= 3),
  };
}

export function resolveGitlabReviewerMode(input: {
  currentMode: GitlabReviewerMode;
  declaredVersion: DeclaredGitlabVersion | null;
  reviewerField: "valid" | "missing" | "invalid" | "not_applicable";
}): GitlabReviewerMode {
  if (input.currentMode === "reviewers" || input.reviewerField === "valid") return "reviewers";
  if (input.declaredVersion?.supportsReviewerWebhooks) return "reviewers";
  if (input.declaredVersion) return "assignee";
  return input.currentMode;
}

type GitlabConnectionInput = {
  organizationId: string;
  memberId: string;
  displayName: string;
  instanceOrigin: string;
};

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

/**
 * Serialize current-connection work with create/replace/delete using the
 * canonical organization -> connection lock order.
 */
export async function withCurrentGitlabConnectionFence<T>(
  db: Database,
  input: { organizationId: string; expectedConnectionId?: string },
  callback: (tx: Database, connection: typeof gitlabConnections.$inferSelect) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockOrganization(tx, input.organizationId);
    const [connection] = await tx
      .select()
      .from(gitlabConnections)
      .where(eq(gitlabConnections.organizationId, input.organizationId))
      .for("update")
      .limit(1);
    if (!connection || (input.expectedConnectionId && connection.id !== input.expectedConnectionId)) {
      throw new NotFoundError(
        input.expectedConnectionId
          ? "GitLab connection not found"
          : "GitLab connection is not configured for this Team",
      );
    }
    return callback(tx, connection);
  });
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
      })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.organizationId, input.organizationId))
      .for("update")
      .limit(1);
    if (!current || current.id !== input.expectedConnectionId) {
      throw new ConflictError("GitLab connection changed or was removed; refresh before replacing it");
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
        reviewerMode: "unknown",
        lastObservedVersion: null,
        lastReviewerSchemaAnomalyAt: null,
        lastReviewerSchemaAnomalyCode: null,
        updatedByMemberId: memberId,
        updatedAt: new Date(),
      })
      .where(eq(gitlabConnections.id, connectionId))
      .returning({ id: gitlabConnections.id });
  });
  if (!updated) throw new NotFoundError("GitLab connection not found");
  return { bearer };
}

export async function deleteGitlabConnection(db: Database, connectionId: string): Promise<void> {
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
      })
      .from(gitlabConnections)
      .where(
        and(eq(gitlabConnections.id, connectionId), eq(gitlabConnections.organizationId, candidate.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!connection) throw new NotFoundError("GitLab connection not found");
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

/** Persist the declared version and one-way reviewer compatibility latch under the ingress fence. */
export async function observeGitlabCompatibility(
  db: Database,
  connectionId: string,
  input: { declaredVersion: string | null; reviewerMode: GitlabReviewerMode; reviewersValid: boolean },
): Promise<void> {
  await db
    .update(gitlabConnections)
    .set({
      ...(input.declaredVersion ? { lastObservedVersion: input.declaredVersion } : {}),
      reviewerMode: input.reviewerMode,
      ...(input.reviewersValid ? { lastReviewerSchemaAnomalyAt: null, lastReviewerSchemaAnomalyCode: null } : {}),
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
    reviewerCapability: {
      mode: connection.reviewerMode as GitlabReviewerMode,
      lastObservedVersion: connection.lastObservedVersion,
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
