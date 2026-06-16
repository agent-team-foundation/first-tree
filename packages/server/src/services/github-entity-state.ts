/**
 * Persist upstream GitHub entity lifecycle on `github_entity_chat_mappings`.
 *
 * Replaces the immediate-archive bypass that lived in the webhook handler
 * (deleted with `github-archive-on-merge.ts`). The webhook now only records
 * "is this PR/Issue still open" — the chat-archive sweeper
 * (`services/chat-archive.ts`) decides when a chat actually flips into a
 * user's archived view.
 *
 * Behaviour:
 *
 *   - PR `opened/reopened` while draft → `entity_state = 'draft'`
 *   - PR `opened/reopened` otherwise   → `entity_state = 'open'`
 *   - PR `converted_to_draft`          → `entity_state = 'draft'`
 *   - PR `ready_for_review`            → `entity_state = 'open'`
 *   - PR `closed` + merged             → `entity_state = 'merged'`
 *   - PR `closed` + un-merged          → `entity_state = 'closed'`
 *   - Issue `opened/reopened`          → `entity_state = 'open'`
 *   - Issue `closed`                   → `entity_state = 'closed'`
 *
 * Idempotent under webhook retries: writes are scoped to
 * `(organization_id, entity_type, entity_key)`, the mapping table's natural
 * cluster key.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";

export type EntityState = "open" | "draft" | "closed" | "merged";

export type EntityStateSeed = {
  entityType: "pull_request" | "issue";
  entityKey: string;
  state: EntityState;
};

export type SetEntityStateInput = {
  organizationId: string;
  /** Must match `entityType` on the mapping table, e.g. `"pull_request"` / `"issue"`. */
  entityType: string;
  /** Stable cluster key, e.g. `"owner/repo#42"`. */
  entityKey: string;
  state: EntityState;
};

export async function setEntityState(db: Database, input: SetEntityStateInput): Promise<{ updated: number }> {
  if (!input.organizationId || !input.entityType || !input.entityKey) {
    return { updated: 0 };
  }
  const updated = await db
    .update(githubEntityChatMappings)
    .set({ entityState: input.state, entityStateUpdatedAt: sql`NOW()` })
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, input.organizationId),
        eq(githubEntityChatMappings.entityType, input.entityType),
        eq(githubEntityChatMappings.entityKey, input.entityKey),
      ),
    )
    .returning({ chatId: githubEntityChatMappings.chatId });
  return { updated: updated.length };
}
