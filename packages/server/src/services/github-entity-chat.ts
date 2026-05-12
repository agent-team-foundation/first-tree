import { chatMetadataSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq } from "drizzle-orm";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { formatEntityTitle } from "../api/webhooks/github-entity.js";
import type { Database } from "../db/connection.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { createChat } from "./chat.js";

/**
 * Resolve which chat a GitHub event for (human, delegate, entity) belongs to.
 *
 * Three-step strategy from docs/webhook-routing-design.md §4.4:
 *   a. Direct hit — entity already bound; reuse that chat.
 *   b. Fixes-link — any related entity (parsed from `Fixes #N` in a PR body)
 *      already bound; write a `fixes_link` row for this entity pointing at
 *      the same chat, return it.
 *   c. Miss — create a fresh chat via the canonical `createChat` entrypoint
 *      and write a `direct` mapping row.
 *
 * Concurrent webhook deliveries for a never-before-seen entity race on (c);
 * the composite primary key + ON CONFLICT DO NOTHING ensures only one row
 * survives. The losing caller falls back to a re-read so the chat stays
 * unique.
 */
export async function resolveTargetChat(
  db: Database,
  params: {
    organizationId: string;
    humanAgentId: string;
    delegateAgentId: string;
    entity: GithubEntity;
    relatedEntities: GithubEntity[];
  },
): Promise<{ chatId: string; created: boolean; boundVia: "direct" | "fixes_link" }> {
  const { organizationId, humanAgentId, delegateAgentId, entity, relatedEntities } = params;

  // (a) Direct hit.
  const direct = await lookupMapping(db, organizationId, humanAgentId, delegateAgentId, entity);
  if (direct) {
    return { chatId: direct.chatId, created: false, boundVia: direct.boundVia };
  }

  // (b) Fixes-link reuse.
  for (const ref of relatedEntities) {
    const linked = await lookupMapping(db, organizationId, humanAgentId, delegateAgentId, ref);
    if (!linked) continue;
    const inserted = await insertMappingIfAbsent(db, {
      organizationId,
      humanAgentId,
      delegateAgentId,
      entity,
      chatId: linked.chatId,
      boundVia: "fixes_link",
    });
    // If the insert lost a race, our re-read returns the winner's row.
    return { chatId: inserted.chatId, created: false, boundVia: inserted.boundVia };
  }

  // (c) Miss — create a fresh chat. Two concurrent (c)-path callers for the
  // same (org, human, delegate, entity) tuple cause two chats; the second one
  // is unreachable because the primary key on the mapping row points at the
  // first chat. The orphan chat is harmless (no participants beyond the two
  // agents, no messages — we have not yet written one) and the design accepts
  // it as the cost of avoiding a serialisable transaction on every webhook.
  const chat = await createEntityChat(db, humanAgentId, delegateAgentId, entity);
  const inserted = await insertMappingIfAbsent(db, {
    organizationId,
    humanAgentId,
    delegateAgentId,
    entity,
    chatId: chat.id,
    boundVia: "direct",
  });
  return { chatId: inserted.chatId, created: inserted.chatId === chat.id, boundVia: inserted.boundVia };
}

async function lookupMapping(
  db: Database,
  organizationId: string,
  humanAgentId: string,
  delegateAgentId: string,
  entity: GithubEntity,
): Promise<{ chatId: string; boundVia: "direct" | "fixes_link" } | null> {
  const [row] = await db
    .select({ chatId: githubEntityChatMappings.chatId, boundVia: githubEntityChatMappings.boundVia })
    .from(githubEntityChatMappings)
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.humanAgentId, humanAgentId),
        eq(githubEntityChatMappings.delegateAgentId, delegateAgentId),
        eq(githubEntityChatMappings.entityType, entity.type),
        eq(githubEntityChatMappings.entityKey, entity.key),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { chatId: row.chatId, boundVia: row.boundVia === "fixes_link" ? "fixes_link" : "direct" };
}

async function insertMappingIfAbsent(
  db: Database,
  params: {
    organizationId: string;
    humanAgentId: string;
    delegateAgentId: string;
    entity: GithubEntity;
    chatId: string;
    boundVia: "direct" | "fixes_link";
  },
): Promise<{ chatId: string; boundVia: "direct" | "fixes_link" }> {
  const [inserted] = await db
    .insert(githubEntityChatMappings)
    .values({
      organizationId: params.organizationId,
      humanAgentId: params.humanAgentId,
      delegateAgentId: params.delegateAgentId,
      entityType: params.entity.type,
      entityKey: params.entity.key,
      chatId: params.chatId,
      boundVia: params.boundVia,
    })
    .onConflictDoNothing({
      target: [
        githubEntityChatMappings.organizationId,
        githubEntityChatMappings.humanAgentId,
        githubEntityChatMappings.delegateAgentId,
        githubEntityChatMappings.entityType,
        githubEntityChatMappings.entityKey,
      ],
    })
    .returning({
      chatId: githubEntityChatMappings.chatId,
      boundVia: githubEntityChatMappings.boundVia,
    });
  if (inserted) {
    return { chatId: inserted.chatId, boundVia: inserted.boundVia === "fixes_link" ? "fixes_link" : "direct" };
  }
  // Lost the race — read the winning row.
  const winner = await lookupMapping(
    db,
    params.organizationId,
    params.humanAgentId,
    params.delegateAgentId,
    params.entity,
  );
  if (!winner) {
    throw new Error("Unexpected: mapping insert conflicted but row not visible on re-read");
  }
  return winner;
}

/**
 * Create a fresh chat for a (human, delegate, entity) tuple. Goes through the
 * canonical `createChat` so:
 *   - cross-org participants are rejected (BadRequestError)
 *   - direct agent-only chats automatically get `mode=mention_only`
 *   - watcher rows are recomputed
 *   - a future addParticipant call would upgrade the chat to `group` via
 *     `maybeUpgradeDirectToGroup` instead of raw INSERT shortcuts
 */
async function createEntityChat(
  db: Database,
  humanAgentId: string,
  delegateAgentId: string,
  entity: GithubEntity,
): Promise<{ id: string }> {
  // Symmetric with the feishu raw-INSERT path in
  // `services/adapter-mapping.ts::findOrCreateChatForChannel`: parse the
  // metadata via the shared discriminated union BEFORE handing it to
  // `createChat`. TS narrowing already catches a malformed literal at
  // compile time, so the runtime cost here is the defensive bound against
  // a future refactor accidentally widening the inferred type back to
  // `Record<string, unknown>` and letting a colliding key slip through.
  const metadata = chatMetadataSchema.parse({
    source: "github",
    entityType: entity.type,
    entityKey: entity.key,
    ...(entity.url ? { entityUrl: entity.url } : {}),
  });
  const chat = await createChat(db, humanAgentId, {
    type: "direct",
    participantIds: [delegateAgentId],
    topic: formatEntityTitle(entity),
    metadata,
  });
  return { id: chat.id };
}
