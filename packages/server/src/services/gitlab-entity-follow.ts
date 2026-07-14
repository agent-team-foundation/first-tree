import { and, eq, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntities } from "../db/schema/gitlab-entities.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

export type GitlabEntityIdentity = {
  entityType: "issue" | "pull_request";
  entityIid: number;
  projectId: number;
  projectPath: string;
  entityUrl: string;
  title: string | null;
  entityState: string;
};

export function normalizeGitlabProjectPath(path: string): string {
  return path
    .normalize("NFKC")
    .replace(/^\/+|\/+$/g, "")
    .toLocaleLowerCase("en-US");
}

export function parseGitlabEntityUrl(
  instanceOrigin: string,
  raw: string,
): Pick<GitlabEntityIdentity, "entityType" | "entityIid" | "projectPath" | "entityUrl"> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("Invalid GitLab entity URL");
  }
  if (url.origin !== instanceOrigin)
    throw new BadRequestError("GitLab entity URL must use the connection's instance origin");
  if (url.username || url.password || url.search || url.hash) {
    throw new BadRequestError("GitLab entity URL must not include credentials, query, or fragment");
  }
  const match = /^\/(.+)\/-\/(issues|merge_requests)\/(\d+)\/?$/.exec(url.pathname);
  if (!match) throw new BadRequestError("GitLab entity URL must point to an issue or merge request");
  let projectPath: string;
  try {
    projectPath = decodeURIComponent(match[1] ?? "");
  } catch {
    throw new BadRequestError("Invalid GitLab entity URL encoding");
  }
  const entityIid = Number(match[3]);
  if (!projectPath || !Number.isSafeInteger(entityIid) || entityIid <= 0)
    throw new BadRequestError("Invalid GitLab entity URL");
  return {
    entityType: match[2] === "issues" ? "issue" : "pull_request",
    entityIid,
    projectPath,
    entityUrl: url.toString().replace(/\/$/, ""),
  };
}

export async function declareGitlabEntityFollow(
  db: Database,
  input: { organizationId: string; connectionId: string; chatId: string; declaredByAgentId: string; entityUrl: string },
) {
  return db.transaction(async (rawTx) => {
    const [connection] = await rawTx
      .select()
      .from(gitlabConnections)
      .where(
        and(eq(gitlabConnections.id, input.connectionId), eq(gitlabConnections.organizationId, input.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!connection?.active || connection.recoveryPending) throw new NotFoundError("GitLab connection not found");
    const parsed = parseGitlabEntityUrl(connection.instanceOrigin, input.entityUrl);
    const normalizedPath = normalizeGitlabProjectPath(parsed.projectPath);
    const baseMatch = and(
      eq(gitlabEntityChatMappings.connectionId, input.connectionId),
      eq(gitlabEntityChatMappings.chatId, input.chatId),
      eq(gitlabEntityChatMappings.projectPathNormalized, normalizedPath),
      eq(gitlabEntityChatMappings.entityType, parsed.entityType),
      eq(gitlabEntityChatMappings.entityIid, parsed.entityIid),
    );
    const [existing] = await rawTx.select().from(gitlabEntityChatMappings).where(baseMatch).limit(1);
    if (existing) return existing;
    const [projection] = await rawTx
      .select()
      .from(gitlabEntities)
      .where(
        and(
          eq(gitlabEntities.connectionId, input.connectionId),
          eq(gitlabEntities.projectPathNormalized, normalizedPath),
          eq(gitlabEntities.entityType, parsed.entityType),
          eq(gitlabEntities.entityIid, parsed.entityIid),
        ),
      )
      .limit(1);
    const [row] = await rawTx
      .insert(gitlabEntityChatMappings)
      .values({
        id: uuidv7(),
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        chatId: input.chatId,
        declaredByAgentId: input.declaredByAgentId,
        entityType: parsed.entityType,
        entityIid: parsed.entityIid,
        entityId: projection?.id ?? null,
        projectId: projection?.projectId ?? null,
        projectPath: projection?.projectPath ?? parsed.projectPath,
        projectPathNormalized: projection?.projectPathNormalized ?? normalizedPath,
        entityUrl: projection?.entityUrl ?? parsed.entityUrl,
        title: projection?.title ?? null,
        entityState: projection?.entityState ?? "open",
        status: projection ? "observed" : "pending",
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [concurrent] = await rawTx.select().from(gitlabEntityChatMappings).where(baseMatch).limit(1);
    return concurrent;
  });
}

export async function listChatGitlabEntities(db: Database, chatId: string) {
  return db.select().from(gitlabEntityChatMappings).where(eq(gitlabEntityChatMappings.chatId, chatId));
}

export async function removeGitlabEntityFollow(db: Database, chatId: string, mappingId: string): Promise<number> {
  const removed = await db
    .delete(gitlabEntityChatMappings)
    .where(and(eq(gitlabEntityChatMappings.id, mappingId), eq(gitlabEntityChatMappings.chatId, chatId)))
    .returning({ id: gitlabEntityChatMappings.id });
  return removed.length;
}

/** Upsert inbound identity SSOT, resolve pending declarations, and return existing follow rows only. */
export async function observeGitlabEntityAndResolveFollowers(
  db: Database,
  organizationId: string,
  connectionId: string,
  entity: GitlabEntityIdentity,
) {
  const normalizedPath = normalizeGitlabProjectPath(entity.projectPath);
  return db.transaction(async (tx) => {
    const [pathOwner] = await tx
      .select({ id: gitlabEntities.id, projectId: gitlabEntities.projectId })
      .from(gitlabEntities)
      .where(
        and(
          eq(gitlabEntities.connectionId, connectionId),
          eq(gitlabEntities.projectPathNormalized, normalizedPath),
          eq(gitlabEntities.entityType, entity.entityType),
          eq(gitlabEntities.entityIid, entity.entityIid),
        ),
      )
      .limit(1);
    if (pathOwner && pathOwner.projectId !== entity.projectId) {
      throw new ConflictError("GitLab entity path conflicts with a different numeric project identity");
    }
    const [known] = await tx
      .select()
      .from(gitlabEntities)
      .where(
        and(
          eq(gitlabEntities.connectionId, connectionId),
          eq(gitlabEntities.projectId, entity.projectId),
          eq(gitlabEntities.entityType, entity.entityType),
          eq(gitlabEntities.entityIid, entity.entityIid),
        ),
      )
      .limit(1);
    const now = new Date();
    const [projection] = known
      ? await tx
          .update(gitlabEntities)
          .set({
            projectPath: entity.projectPath,
            projectPathNormalized: normalizedPath,
            entityUrl: entity.entityUrl,
            title: entity.title,
            entityState: entity.entityState,
            observedAt: now,
            updatedAt: now,
          })
          .where(eq(gitlabEntities.id, known.id))
          .returning()
      : await tx
          .insert(gitlabEntities)
          .values({
            id: uuidv7(),
            organizationId,
            connectionId,
            entityType: entity.entityType,
            entityIid: entity.entityIid,
            projectId: entity.projectId,
            projectPath: entity.projectPath,
            projectPathNormalized: normalizedPath,
            entityUrl: entity.entityUrl,
            title: entity.title,
            entityState: entity.entityState,
            observedAt: now,
            updatedAt: now,
          })
          .returning();
    if (!projection) throw new ConflictError("Failed to persist GitLab entity identity");
    const candidates = await tx
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, connectionId),
          eq(gitlabEntityChatMappings.entityType, entity.entityType),
          eq(gitlabEntityChatMappings.entityIid, entity.entityIid),
          or(
            eq(gitlabEntityChatMappings.entityId, projection.id),
            and(
              eq(gitlabEntityChatMappings.projectPathNormalized, normalizedPath),
              eq(gitlabEntityChatMappings.status, "pending"),
            ),
          ),
        ),
      );
    const resolved: Array<(typeof candidates)[number]> = [];
    for (const row of candidates) {
      if (row.entityId !== null && row.entityId !== projection.id) {
        await tx
          .update(gitlabEntityChatMappings)
          .set({
            lastConflictAt: new Date(),
            lastConflictReason: "numeric_project_identity_mismatch",
            updatedAt: new Date(),
          })
          .where(eq(gitlabEntityChatMappings.id, row.id));
        continue;
      }
      const [observed] = await tx
        .select()
        .from(gitlabEntityChatMappings)
        .where(
          and(
            eq(gitlabEntityChatMappings.connectionId, connectionId),
            eq(gitlabEntityChatMappings.chatId, row.chatId),
            eq(gitlabEntityChatMappings.entityId, projection.id),
            eq(gitlabEntityChatMappings.status, "observed"),
          ),
        )
        .limit(1);
      if (observed && observed.id !== row.id && observed.entityId === projection.id) {
        await tx.delete(gitlabEntityChatMappings).where(eq(gitlabEntityChatMappings.id, row.id));
        if (!resolved.some((candidate) => candidate.id === observed.id)) resolved.push(observed);
        continue;
      }
      const [updated] = await tx
        .update(gitlabEntityChatMappings)
        .set({
          entityId: projection.id,
          projectId: entity.projectId,
          projectPath: entity.projectPath,
          projectPathNormalized: normalizedPath,
          entityUrl: entity.entityUrl,
          title: entity.title,
          entityState: entity.entityState,
          status: "observed",
          lastConflictAt: null,
          lastConflictReason: null,
          updatedAt: new Date(),
        })
        .where(eq(gitlabEntityChatMappings.id, row.id))
        .returning();
      if (updated && !resolved.some((candidate) => candidate.id === updated.id)) resolved.push(updated);
    }
    return resolved;
  });
}
