import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { pendingQuestions } from "../db/schema/pending-questions.js";

/**
 * Pending-question lifecycle helpers.
 *
 * NHA M0 cleanup removed the chat-internal ask-user write path (the
 * `format=question` SDK bridge + `submitAnswer` route + the `recordPending…`
 * / `assertSenderMayEmit…` defenders that fed it). What remains here is the
 * supersede surface — claim / archive transitions still need to invalidate
 * any historical pending rows so they don't keep contributing to the
 * chat-list "needs-you" signal. The downstream needs-you UI + the
 * `pending_questions` table stay in place because the NHA primitive
 * (M1 末) will rewire the same signal to a new attentions backing store.
 */

type TxLike = Pick<PostgresJsDatabase<Record<string, never>>, "select" | "insert" | "update">;

/**
 * Mark every pending row whose chat is `chatId` as superseded. Used when a
 * chat session is archived so a historical pending row doesn't keep the
 * chat pinned in the needs-you bucket forever.
 */
export async function markSupersededByChat(tx: TxLike, chatId: string, reason = "chat_archived"): Promise<number> {
  const rows = await tx
    .update(pendingQuestions)
    .set({ status: "superseded", supersededAt: new Date(), supersededReason: reason })
    .where(and(eq(pendingQuestions.chatId, chatId), eq(pendingQuestions.status, "pending")))
    .returning({ id: pendingQuestions.id });
  return rows.length;
}

/**
 * Mark every pending row owned by any of `agentIds` as superseded. Used when
 * the client carrying these agents is claimed by a new user so a historical
 * pending row doesn't keep the chat pinned in the needs-you bucket forever.
 *
 * Returns the DISTINCT chat ids that had a row superseded, so the caller can
 * fire a post-commit `notifyChatMessage(chatId)` to clear any stale needs-you
 * indicator (this path, unlike chat-archive, emits no session:state change
 * that would otherwise refresh the chat list).
 */
export async function markSupersededByAgents(
  tx: TxLike,
  agentIds: string[],
  reason = "client_claimed",
): Promise<string[]> {
  if (agentIds.length === 0) return [];
  const rows = await tx
    .update(pendingQuestions)
    .set({ status: "superseded", supersededAt: new Date(), supersededReason: reason })
    .where(and(inArray(pendingQuestions.agentId, agentIds), eq(pendingQuestions.status, "pending")))
    .returning({ id: pendingQuestions.id, chatId: pendingQuestions.chatId });
  return [...new Set(rows.map((r) => r.chatId))];
}
