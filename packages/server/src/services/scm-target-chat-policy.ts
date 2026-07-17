import type { InvolveReason } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chatMembership } from "../db/schema/chat-membership.js";

export type ScmTargetChatDecision = { kind: "reuse"; chatId: string } | { kind: "strict_new_line" };

/**
 * Only reviewer routing may reuse chat membership without writing a line.
 * Mentions and assignments are directed calls and always establish a strict
 * new attention home.
 */
export async function decideScmPersonnelTargetChat(
  db: Database,
  input: {
    reason: InvolveReason;
    candidateChatIds: string[];
    humanAgentId: string;
    wakeAgentId: string;
  },
): Promise<ScmTargetChatDecision> {
  if (input.reason !== "review_requested") return { kind: "strict_new_line" };
  const reusable: string[] = [];
  for (const chatId of [...new Set(input.candidateChatIds)]) {
    const speakers = await db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chatId),
          eq(chatMembership.accessMode, "speaker"),
          inArray(chatMembership.agentId, [input.humanAgentId, input.wakeAgentId]),
        ),
      );
    const ids = new Set(speakers.map((speaker) => speaker.agentId));
    if (ids.has(input.humanAgentId) && ids.has(input.wakeAgentId)) reusable.push(chatId);
    if (reusable.length > 1) return { kind: "strict_new_line" };
  }
  return reusable.length === 1 && reusable[0] ? { kind: "reuse", chatId: reusable[0] } : { kind: "strict_new_line" };
}
