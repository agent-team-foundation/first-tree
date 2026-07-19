import type {
  ChatGitlabEntity,
  ChatGitlabEntityListResponse,
  FollowChatGitlabEntityResponse,
  ScmEntityState,
  UnfollowChatGitlabEntityResponse,
} from "@first-tree/shared";
import { chatMetadataSchema, normalizeScmEntityState } from "@first-tree/shared";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { BadRequestError, ConflictError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { withCurrentGitlabConnectionFence } from "./gitlab-connections.js";
import { executeScmFollowLine } from "./scm-attention-line.js";
import { refreshGitlabEntityTopic } from "./scm-entity-chat-topic.js";

export type GitlabEntityIdentity = {
  entityType: "issue" | "pull_request";
  entityIid: number;
  projectId: number;
  projectPath: string;
  entityUrl: string;
  title: string | null;
  entityState: ScmEntityState | null;
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
  // GitLab instances and clients emit both route shapes. Treat them as the
  // same identity, but preserve the submitted shape for the user-facing link.
  const match = /^\/(.+?)\/(?:-\/)?(issues|merge_requests)\/(\d+)\/?$/.exec(url.pathname);
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

export function projectChatGitlabEntity(row: GitlabEntityMapping): ChatGitlabEntity {
  if (row.entityType !== "issue" && row.entityType !== "pull_request") {
    throw new Error(`Unsupported persisted GitLab entity type: ${row.entityType}`);
  }
  if (!isExplicitGitlabDeclaration(row.boundVia) && row.boundVia !== "identity_target") {
    throw new Error(`Unsupported persisted GitLab binding provenance: ${row.boundVia}`);
  }
  return {
    entityType: row.entityType,
    entityUrl: row.entityUrl,
    projectPath: row.projectPath,
    entityIid: row.entityIid,
    title: row.title,
    state: row.projectId === null ? null : normalizeScmEntityState(row.entityState),
    status: row.projectId === null ? "pending" : "active",
    boundVia: row.boundVia,
  };
}

export async function declareGitlabEntityFollowWithStatus(
  db: Database,
  input: {
    organizationId: string;
    connectionId?: string;
    chatId: string;
    declaredByAgentId: string;
    humanAgentId: string;
    delegateAgentId: string;
    boundVia?: "agent_declared" | "human_declared";
    entityUrl: string;
    rebind: boolean;
  },
): Promise<
  | { outcome: "created" | "already_following" | "rebound"; row: GitlabEntityMapping }
  | { outcome: "conflict"; conflict: { chatId: string; topic: string | null } }
> {
  return withCurrentGitlabConnectionFence(
    db,
    { organizationId: input.organizationId, expectedConnectionId: input.connectionId },
    async (rawTx, connection) => {
      const parsed = parseGitlabEntityUrl(connection.instanceOrigin, input.entityUrl);
      const boundVia = input.boundVia ?? "agent_declared";
      const normalizedPath = normalizeGitlabProjectPath(parsed.projectPath);
      const entityMatch = and(
        eq(gitlabEntityChatMappings.connectionId, connection.id),
        eq(gitlabEntityChatMappings.projectPathNormalized, normalizedPath),
        eq(gitlabEntityChatMappings.entityType, parsed.entityType),
        eq(gitlabEntityChatMappings.entityIid, parsed.entityIid),
        eq(gitlabEntityChatMappings.active, true),
      );
      const pairMatch = and(
        entityMatch,
        eq(gitlabEntityChatMappings.humanAgentId, input.humanAgentId),
        eq(gitlabEntityChatMappings.delegateAgentId, input.delegateAgentId),
      );
      const listLines = () =>
        rawTx
          .select()
          .from(gitlabEntityChatMappings)
          .where(pairMatch)
          .orderBy(asc(gitlabEntityChatMappings.createdAt), asc(gitlabEntityChatMappings.id));

      const result = await executeScmFollowLine({
        targetChatId: input.chatId,
        rebind: input.rebind,
        storage: {
          listLines,
          removeLines: async (rows) => {
            const ids = rows.map((row) => row.id);
            if (ids.length > 0) {
              await rawTx.delete(gitlabEntityChatMappings).where(inArray(gitlabEntityChatMappings.id, ids));
            }
          },
          getChatTopic: async (chatId) => {
            const [chat] = await rawTx.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
            return chat?.topic ?? null;
          },
          moveLine: async (row) => {
            const [moved] = await rawTx
              .update(gitlabEntityChatMappings)
              .set({
                chatId: input.chatId,
                declaredByAgentId: input.declaredByAgentId,
                boundVia,
                identityLinkId: null,
                attentionMode: "paired",
                attentionBackfillVersion: 1,
                updatedAt: new Date(),
              })
              .where(eq(gitlabEntityChatMappings.id, row.id))
              .returning();
            return moved ?? null;
          },
          createLine: async () => {
            // A legacy route in the destination chat can be upgraded only
            // when the caller supplies the complete pair.
            const [legacySameChat] = await rawTx
              .select()
              .from(gitlabEntityChatMappings)
              .where(
                and(
                  entityMatch,
                  eq(gitlabEntityChatMappings.chatId, input.chatId),
                  isNull(gitlabEntityChatMappings.humanAgentId),
                  isNull(gitlabEntityChatMappings.delegateAgentId),
                  explicitGitlabDeclarationPredicate(),
                ),
              )
              .orderBy(asc(gitlabEntityChatMappings.createdAt), asc(gitlabEntityChatMappings.id))
              .limit(1);
            if (legacySameChat) {
              const [upgraded] = await rawTx
                .update(gitlabEntityChatMappings)
                .set({
                  declaredByAgentId: input.declaredByAgentId,
                  boundVia,
                  humanAgentId: input.humanAgentId,
                  delegateAgentId: input.delegateAgentId,
                  attentionMode: "paired",
                  attentionBackfillVersion: 1,
                  updatedAt: new Date(),
                })
                .where(eq(gitlabEntityChatMappings.id, legacySameChat.id))
                .returning();
              if (upgraded) return { record: upgraded, inserted: true };
            }

            const [inserted] = await rawTx
              .insert(gitlabEntityChatMappings)
              .values({
                id: uuidv7(),
                organizationId: input.organizationId,
                connectionId: connection.id,
                chatId: input.chatId,
                declaredByAgentId: input.declaredByAgentId,
                boundVia,
                humanAgentId: input.humanAgentId,
                delegateAgentId: input.delegateAgentId,
                attentionMode: "paired",
                attentionBackfillVersion: 1,
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
            if (inserted) return { record: inserted, inserted: true };
            const [concurrent] = await listLines();
            if (!concurrent) throw new Error("GitLab follow declaration conflicted without a surviving mapping");
            return { record: concurrent, inserted: false };
          },
        },
      });
      if (result.outcome === "conflict") return result;
      if (result.record.entityUrl !== parsed.entityUrl) {
        const [updated] = await rawTx
          .update(gitlabEntityChatMappings)
          .set({
            projectPath: parsed.projectPath,
            projectPathNormalized: normalizedPath,
            entityUrl: parsed.entityUrl,
            updatedAt: new Date(),
          })
          .where(eq(gitlabEntityChatMappings.id, result.record.id))
          .returning();
        if (updated) return { outcome: result.outcome, row: updated };
      }
      return { outcome: result.outcome, row: result.record };
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
    humanAgentId: string;
    delegateAgentId: string;
    boundVia?: "agent_declared" | "human_declared";
    entityUrl: string;
    rebind?: boolean;
  },
): Promise<GitlabEntityMapping> {
  const result = await declareGitlabEntityFollowWithStatus(db, { ...input, rebind: input.rebind ?? false });
  if (result.outcome === "conflict") {
    throw new ConflictError(`GitLab attention line already belongs to chat ${result.conflict.chatId}`);
  }
  return result.row;
}

/** Agent/CLI contract: resolve the Team's only current connection and return a stable public DTO. */
export async function declareCurrentGitlabEntityFollow(
  db: Database,
  input: {
    organizationId: string;
    chatId: string;
    declaredByAgentId: string;
    humanAgentId: string;
    delegateAgentId: string;
    entityUrl: string;
    rebind: boolean;
  },
): Promise<
  | { outcome: "success"; response: FollowChatGitlabEntityResponse }
  | { outcome: "conflict"; conflict: { chatId: string; topic: string | null } }
> {
  const result = await declareGitlabEntityFollowWithStatus(db, {
    ...input,
    boundVia: "agent_declared",
  });
  if (result.outcome === "conflict") return result;
  return {
    outcome: "success",
    response: {
      status: result.outcome,
      entity: projectChatGitlabEntity(result.row),
    },
  };
}

/**
 * Deprecated v1 Web alias. Preserve the original persisted-row shape,
 * including `id`, so existing consumers can still issue mappingId deletes.
 * New consumers must use the safe `items` projection.
 */
export async function listChatGitlabEntities(db: Database, chatId: string): Promise<GitlabEntityMapping[]> {
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

/**
 * Public Web projection of every active GitLab binding in a chat.
 *
 * Unlike agent-facing `gitlab following`, this includes automatic
 * `identity_target` rows so a webhook-created chat shows the MR/Issue it is
 * already routing. Rows are deduplicated by the provider-visible project path,
 * entity type, and IID because an explicit declaration and an identity route
 * may independently bind the same entity to one chat.
 */
export async function listVisibleChatGitlabEntities(
  db: Database,
  chatId: string,
): Promise<ChatGitlabEntityListResponse> {
  const rows = await db
    .select()
    .from(gitlabEntityChatMappings)
    .where(and(eq(gitlabEntityChatMappings.chatId, chatId), eq(gitlabEntityChatMappings.active, true)))
    .orderBy(asc(gitlabEntityChatMappings.createdAt));
  const selected = new Map<string, GitlabEntityMapping>();
  for (const row of rows) {
    const key = `${row.projectPathNormalized}:${row.entityType}:${row.entityIid}`;
    const current = selected.get(key);
    if (
      !current ||
      (current.projectId === null && row.projectId !== null) ||
      (current.title === null && row.title !== null)
    ) {
      selected.set(key, row);
    }
  }
  return { items: [...selected.values()].map(projectChatGitlabEntity) };
}

export async function listCurrentChatGitlabEntities(
  db: Database,
  chatId: string,
): Promise<ChatGitlabEntityListResponse> {
  return listVisibleChatGitlabEntities(db, chatId);
}

type GitlabEntityDeleteTarget = {
  connectionId: string;
  chatId: string;
} & (
  | {
      scope: "entity";
      projectPathNormalized: string;
      entityType: GitlabEntityIdentity["entityType"];
      entityIid: number;
    }
  | { scope: "explicit_mapping"; mappingId: string }
);

async function deleteGitlabEntityMappingsInChat(db: Database, target: GitlabEntityDeleteTarget): Promise<number> {
  const removed = await db
    .delete(gitlabEntityChatMappings)
    .where(
      and(
        eq(gitlabEntityChatMappings.connectionId, target.connectionId),
        eq(gitlabEntityChatMappings.chatId, target.chatId),
        eq(gitlabEntityChatMappings.active, true),
        target.scope === "explicit_mapping"
          ? and(eq(gitlabEntityChatMappings.id, target.mappingId), explicitGitlabDeclarationPredicate())
          : and(
              eq(gitlabEntityChatMappings.projectPathNormalized, target.projectPathNormalized),
              eq(gitlabEntityChatMappings.entityType, target.entityType),
              eq(gitlabEntityChatMappings.entityIid, target.entityIid),
            ),
      ),
    )
    .returning({ id: gitlabEntityChatMappings.id });
  return removed.length;
}

/** Legacy mapping-id wire adapter delegated to the canonical fenced deletion primitive. */
export async function removeGitlabEntityFollow(
  db: Database,
  input: { organizationId: string; chatId: string; mappingId: string },
): Promise<number> {
  return withCurrentGitlabConnectionFence(db, { organizationId: input.organizationId }, async (tx, connection) => {
    return deleteGitlabEntityMappingsInChat(tx, {
      scope: "explicit_mapping",
      connectionId: connection.id,
      chatId: input.chatId,
      mappingId: input.mappingId,
    });
  });
}

/** Agent/CLI URL contract: remove every active binding for this entity in this chat. */
export async function removeCurrentGitlabEntityFollow(
  db: Database,
  input: { organizationId: string; chatId: string; entityUrl: string },
): Promise<UnfollowChatGitlabEntityResponse> {
  return withCurrentGitlabConnectionFence(db, { organizationId: input.organizationId }, async (tx, connection) => {
    const parsed = parseGitlabEntityUrl(connection.instanceOrigin, input.entityUrl);
    const removed = await deleteGitlabEntityMappingsInChat(tx, {
      scope: "entity",
      connectionId: connection.id,
      chatId: input.chatId,
      projectPathNormalized: normalizeGitlabProjectPath(parsed.projectPath),
      entityType: parsed.entityType,
      entityIid: parsed.entityIid,
    });
    return { removed };
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
    const byAttentionLine = new Map<string, typeof candidates>();
    for (const row of candidates) {
      const ownerKey =
        row.boundVia === "identity_target"
          ? `identity:${row.identityLinkId ?? row.id}`
          : row.humanAgentId && row.delegateAgentId
            ? `pair:${row.humanAgentId}:${row.delegateAgentId}`
            : `legacy:${row.chatId}`;
      const rows = byAttentionLine.get(ownerKey);
      if (rows) rows.push(row);
      else byAttentionLine.set(ownerKey, [row]);
    }
    for (const rows of byAttentionLine.values()) {
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
              ...(entity.entityState ? { entityState: entity.entityState } : {}),
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
            ...(entity.entityState ? { entityState: entity.entityState } : {}),
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

/** Refresh only GitLab-owned anchor chats whose topic still matches the automatic grammar. */
export async function refreshGitlabChatTopics(
  db: Database,
  connectionId: string,
  entity: GitlabEntityIdentity,
): Promise<void> {
  if (!entity.title) return;
  const rows = await db
    .select({
      chatId: gitlabEntityChatMappings.chatId,
      topic: chats.topic,
      metadata: chats.metadata,
    })
    .from(gitlabEntityChatMappings)
    .innerJoin(chats, eq(chats.id, gitlabEntityChatMappings.chatId))
    .where(
      and(
        eq(gitlabEntityChatMappings.connectionId, connectionId),
        eq(gitlabEntityChatMappings.projectId, entity.projectId),
        eq(gitlabEntityChatMappings.entityType, entity.entityType),
        eq(gitlabEntityChatMappings.entityIid, entity.entityIid),
        eq(gitlabEntityChatMappings.active, true),
      ),
    );
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.chatId) || !row.topic) continue;
    seen.add(row.chatId);
    const metadata = chatMetadataSchema.safeParse(row.metadata);
    if (
      !metadata.success ||
      metadata.data.source !== "gitlab" ||
      metadata.data.entityKey !== `${entity.projectId}:${entity.entityType}:${entity.entityIid}`
    ) {
      continue;
    }
    const nextTopic = refreshGitlabEntityTopic(row.topic, entity);
    if (!nextTopic || nextTopic === row.topic) continue;
    await db.update(chats).set({ topic: nextTopic, updatedAt: new Date() }).where(eq(chats.id, row.chatId));
  }
}
