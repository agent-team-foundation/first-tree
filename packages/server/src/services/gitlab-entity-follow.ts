import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { BadRequestError, NotFoundError } from "../errors.js";
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
    if (!connection) throw new NotFoundError("GitLab connection not found");
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
        projectId: null,
        projectPath: parsed.projectPath,
        projectPathNormalized: normalizedPath,
        entityUrl: parsed.entityUrl,
        title: null,
        entityState: "open",
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

/** Refresh observed mappings, resolve path-matched pending declarations, and return current followers. */
export async function observeGitlabEntityAndResolveFollowers(
  db: Database,
  connectionId: string,
  entity: GitlabEntityIdentity,
) {
  const normalizedPath = normalizeGitlabProjectPath(entity.projectPath);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, connectionId),
          eq(gitlabEntityChatMappings.entityType, entity.entityType),
          eq(gitlabEntityChatMappings.entityIid, entity.entityIid),
          or(
            eq(gitlabEntityChatMappings.projectId, entity.projectId),
            and(
              isNull(gitlabEntityChatMappings.projectId),
              eq(gitlabEntityChatMappings.projectPathNormalized, normalizedPath),
            ),
          ),
        ),
      );
    const resolved: Array<(typeof candidates)[number]> = [];
    const byChat = new Map<string, typeof candidates>();
    for (const row of candidates) {
      const rows = byChat.get(row.chatId);
      if (rows) rows.push(row);
      else byChat.set(row.chatId, [row]);
    }
    for (const rows of byChat.values()) {
      const observed = rows.find((row) => row.projectId === entity.projectId);
      const winner = observed ?? rows.find((row) => row.projectId === null);
      if (!winner) continue;
      for (const duplicate of rows) {
        if (duplicate.id !== winner.id && duplicate.projectId === null) {
          await tx.delete(gitlabEntityChatMappings).where(eq(gitlabEntityChatMappings.id, duplicate.id));
        }
      }
      const [updated] = await tx
        .update(gitlabEntityChatMappings)
        .set({
          projectId: entity.projectId,
          projectPath: entity.projectPath,
          projectPathNormalized: normalizedPath,
          entityUrl: entity.entityUrl,
          title: entity.title,
          entityState: entity.entityState,
          updatedAt: new Date(),
        })
        .where(eq(gitlabEntityChatMappings.id, winner.id))
        .returning();
      if (updated) resolved.push(updated);
    }
    return resolved;
  });
}
