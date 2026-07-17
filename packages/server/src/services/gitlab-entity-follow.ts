import type {
  ChatGitlabEntity,
  ChatGitlabEntityListResponse,
  FollowChatGitlabEntityResponse,
  UnfollowChatGitlabEntityResponse,
} from "@first-tree/shared";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { BadRequestError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { withCurrentGitlabConnectionFence } from "./gitlab-connections.js";

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
  if (/\p{Cc}/u.test(projectPath)) {
    throw new BadRequestError("GitLab entity URL project path must not contain control characters");
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

type GitlabEntityMapping = typeof gitlabEntityChatMappings.$inferSelect;

function isExplicitGitlabDeclaration(boundVia: string): boundVia is "agent_declared" | "human_declared" {
  return boundVia === "agent_declared" || boundVia === "human_declared";
}

function explicitGitlabDeclarationPredicate() {
  return or(
    eq(gitlabEntityChatMappings.boundVia, "agent_declared"),
    eq(gitlabEntityChatMappings.boundVia, "human_declared"),
  );
}

function projectChatGitlabEntity(row: GitlabEntityMapping): ChatGitlabEntity {
  if (row.entityType !== "issue" && row.entityType !== "pull_request") {
    throw new Error(`Unsupported persisted GitLab entity type: ${row.entityType}`);
  }
  if (!isExplicitGitlabDeclaration(row.boundVia)) {
    throw new Error(`GitLab identity target is not an explicit chat follow: ${row.boundVia}`);
  }
  return {
    entityType: row.entityType,
    entityUrl: row.entityUrl,
    projectPath: row.projectPath,
    entityIid: row.entityIid,
    title: row.title,
    state: row.projectId === null ? null : row.entityState,
    status: row.projectId === null ? "pending" : "active",
    boundVia: row.boundVia,
  };
}

async function declareGitlabEntityFollowWithStatus(
  db: Database,
  input: {
    organizationId: string;
    connectionId?: string;
    chatId: string;
    declaredByAgentId: string;
    boundVia?: "agent_declared" | "human_declared";
    entityUrl: string;
  },
): Promise<{ row: GitlabEntityMapping; created: boolean }> {
  return withCurrentGitlabConnectionFence(
    db,
    { organizationId: input.organizationId, expectedConnectionId: input.connectionId },
    async (rawTx, connection) => {
      const parsed = parseGitlabEntityUrl(connection.instanceOrigin, input.entityUrl);
      const boundVia = input.boundVia ?? "agent_declared";
      const normalizedPath = normalizeGitlabProjectPath(parsed.projectPath);
      const baseMatch = and(
        eq(gitlabEntityChatMappings.connectionId, connection.id),
        eq(gitlabEntityChatMappings.chatId, input.chatId),
        eq(gitlabEntityChatMappings.projectPathNormalized, normalizedPath),
        eq(gitlabEntityChatMappings.entityType, parsed.entityType),
        eq(gitlabEntityChatMappings.entityIid, parsed.entityIid),
        eq(gitlabEntityChatMappings.active, true),
        explicitGitlabDeclarationPredicate(),
      );
      const [existing] = await rawTx.select().from(gitlabEntityChatMappings).where(baseMatch).limit(1);
      if (existing) return { row: existing, created: false };
      const [row] = await rawTx
        .insert(gitlabEntityChatMappings)
        .values({
          id: uuidv7(),
          organizationId: input.organizationId,
          connectionId: connection.id,
          chatId: input.chatId,
          declaredByAgentId: input.declaredByAgentId,
          boundVia,
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
      if (row) return { row, created: true };
      const [concurrent] = await rawTx.select().from(gitlabEntityChatMappings).where(baseMatch).limit(1);
      if (!concurrent) throw new Error("GitLab follow declaration conflicted without a surviving mapping");
      return { row: concurrent, created: false };
    },
  );
}

/** Existing human/Web contract: caller supplies the connection and receives the persisted row. */
export async function declareGitlabEntityFollow(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    chatId: string;
    declaredByAgentId: string;
    boundVia?: "agent_declared" | "human_declared";
    entityUrl: string;
  },
): Promise<GitlabEntityMapping> {
  return (await declareGitlabEntityFollowWithStatus(db, input)).row;
}

/** Agent/CLI contract: resolve the Team's only current connection and return a stable public DTO. */
export async function declareCurrentGitlabEntityFollow(
  db: Database,
  input: {
    organizationId: string;
    chatId: string;
    declaredByAgentId: string;
    entityUrl: string;
  },
): Promise<FollowChatGitlabEntityResponse> {
  const result = await declareGitlabEntityFollowWithStatus(db, {
    ...input,
    boundVia: "agent_declared",
  });
  return {
    status: result.created ? "created" : "already_following",
    entity: projectChatGitlabEntity(result.row),
  };
}

/** Existing human/Web projection retained for response compatibility. */
export async function listChatGitlabEntities(db: Database, chatId: string) {
  return db
    .select()
    .from(gitlabEntityChatMappings)
    .where(
      and(
        eq(gitlabEntityChatMappings.chatId, chatId),
        eq(gitlabEntityChatMappings.active, true),
        explicitGitlabDeclarationPredicate(),
      ),
    )
    .orderBy(asc(gitlabEntityChatMappings.createdAt));
}

export async function listDeclaredChatGitlabEntities(
  db: Database,
  chatId: string,
): Promise<ChatGitlabEntityListResponse> {
  const rows = await listChatGitlabEntities(db, chatId);
  return { items: rows.map(projectChatGitlabEntity) };
}

/** Existing mapping-id human/Web removal contract. */
export async function removeGitlabEntityFollow(db: Database, chatId: string, mappingId: string): Promise<number> {
  const removed = await db
    .delete(gitlabEntityChatMappings)
    .where(
      and(
        eq(gitlabEntityChatMappings.id, mappingId),
        eq(gitlabEntityChatMappings.chatId, chatId),
        eq(gitlabEntityChatMappings.active, true),
        explicitGitlabDeclarationPredicate(),
      ),
    )
    .returning({ id: gitlabEntityChatMappings.id });
  return removed.length;
}

/** Agent/CLI URL contract: remove only explicit declarations in this chat. */
export async function removeCurrentGitlabEntityFollow(
  db: Database,
  input: { organizationId: string; chatId: string; entityUrl: string },
): Promise<UnfollowChatGitlabEntityResponse> {
  return withCurrentGitlabConnectionFence(db, { organizationId: input.organizationId }, async (tx, connection) => {
    const parsed = parseGitlabEntityUrl(connection.instanceOrigin, input.entityUrl);
    const removed = await tx
      .delete(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, connection.id),
          eq(gitlabEntityChatMappings.chatId, input.chatId),
          eq(gitlabEntityChatMappings.projectPathNormalized, normalizeGitlabProjectPath(parsed.projectPath)),
          eq(gitlabEntityChatMappings.entityType, parsed.entityType),
          eq(gitlabEntityChatMappings.entityIid, parsed.entityIid),
          eq(gitlabEntityChatMappings.active, true),
          explicitGitlabDeclarationPredicate(),
        ),
      )
      .returning({ id: gitlabEntityChatMappings.id });
    return { removed: removed.length };
  });
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
          eq(gitlabEntityChatMappings.active, true),
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
      const explicitRows = rows.filter((row) => isExplicitGitlabDeclaration(row.boundVia));
      if (explicitRows.length > 0) {
        const observed = explicitRows.find((row) => row.projectId === entity.projectId);
        const winner = observed ?? explicitRows.find((row) => row.projectId === null);
        if (winner) {
          for (const duplicate of explicitRows) {
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
      }
      for (const identityRow of rows.filter((row) => row.boundVia === "identity_target")) {
        const [updated] = await tx
          .update(gitlabEntityChatMappings)
          .set({
            projectPath: entity.projectPath,
            projectPathNormalized: normalizedPath,
            entityUrl: entity.entityUrl,
            title: entity.title,
            entityState: entity.entityState,
            updatedAt: new Date(),
          })
          .where(eq(gitlabEntityChatMappings.id, identityRow.id))
          .returning();
        if (updated) resolved.push(updated);
      }
    }
    return resolved;
  });
}
