/**
 * Auto-archive chats when one of their bound pull requests is merged.
 *
 * Trigger: GitHub `pull_request.closed` webhook with `merged === true`. The
 * webhook handler calls this service on a bypass branch — the normalize /
 * audience / deliver pipeline is unaffected (PR closed events still drop in
 * Stage 1).
 *
 * Algorithm: a merged PR flips every chat bound to it into the user's
 * archived view, with no inspection of sibling PR state. Multi-PR chats can
 * be temporarily archived while siblings are still open; any later activity
 * on those siblings produces a normal delivery message, which the existing
 * chat-projection auto-revives back to `active`. This trades perfect timing
 * for zero local state, no GitHub API calls, and no schema changes.
 *
 * Per-user safety: writes use an UPSERT guarded with
 * `setWhere = engagement_status = 'active'`, so only the implicit-active or
 * explicitly-active rows flip. User-manually `deleted` and already-`archived`
 * rows are left alone. Idempotent under GitHub webhook retries.
 */

import { CHAT_ENGAGEMENT_STATUSES } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";

const { ACTIVE, ARCHIVED } = CHAT_ENGAGEMENT_STATUSES;

export type ArchiveChatsForMergedPrInput = {
  organizationId: string;
  /** GitHub `repository.full_name`, e.g. `owner/repo`. */
  repoFullName: string;
  /** Pull request number. */
  prNumber: number;
};

export type ArchiveChatsForMergedPrResult = {
  /** Distinct chats touched (a chat can map to multiple humans). */
  chats: number;
  /** Per-(chat, human) UPSERT attempts — equal to the mapping rows considered. */
  rowsConsidered: number;
};

export async function archiveChatsForMergedPr(
  db: Database,
  input: ArchiveChatsForMergedPrInput,
): Promise<ArchiveChatsForMergedPrResult> {
  if (!input.repoFullName || !Number.isFinite(input.prNumber) || input.prNumber <= 0) {
    return { chats: 0, rowsConsidered: 0 };
  }
  const entityKey = `${input.repoFullName}#${input.prNumber}`;

  const rows = await db
    .select({
      chatId: githubEntityChatMappings.chatId,
      humanAgentId: githubEntityChatMappings.humanAgentId,
    })
    .from(githubEntityChatMappings)
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, input.organizationId),
        eq(githubEntityChatMappings.entityType, "pull_request"),
        eq(githubEntityChatMappings.entityKey, entityKey),
      ),
    );

  if (rows.length === 0) {
    return { chats: 0, rowsConsidered: 0 };
  }

  // De-dupe (chat, human) — the mapping table's composite PK includes the
  // delegate, so the same human can show up twice for the same chat if
  // bound through different delegates.
  const seen = new Set<string>();
  const targets: { chatId: string; humanAgentId: string }[] = [];
  for (const row of rows) {
    const key = `${row.chatId}|${row.humanAgentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(row);
  }

  for (const { chatId, humanAgentId } of targets) {
    await db
      .insert(chatUserState)
      .values({
        chatId,
        agentId: humanAgentId,
        unreadMentionCount: 0,
        engagementStatus: ARCHIVED,
      })
      .onConflictDoUpdate({
        target: [chatUserState.chatId, chatUserState.agentId],
        set: { engagementStatus: ARCHIVED },
        setWhere: eq(chatUserState.engagementStatus, ACTIVE),
      });
  }

  const chats = new Set(targets.map((t) => t.chatId)).size;
  return { chats, rowsConsidered: targets.length };
}
