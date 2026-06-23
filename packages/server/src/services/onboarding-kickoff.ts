import type { KickoffKind, SendMessage } from "@first-tree/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "./chat.js";
import { sendMessage } from "./message.js";

export type KickoffOnboardingArgs = {
  /** The membership whose completion is stamped once the chat exists. */
  memberId: string;
  /** The caller's human agent in the org — the chat creator and message sender. */
  humanAgentId: string;
  /** The bootstrap agent the kickoff chat is opened with. */
  targetAgentId: string;
  /** The First Tree-authored system trigger body sent into the kickoff chat. */
  bootstrap: string;
  /**
   * Separates intro, value-first work, and tree-building kickoffs for the same
   * (human, agent) pair so they get distinct idempotency keys — see
   * `kickoffKindSchema`. An "intro" chat must not absorb a later "tree"
   * (`/build-tree`) kickoff, and a value-first "work" chat must stay separate
   * from the heavier Context Tree setup chat.
   */
  kind: KickoffKind;
  /** Whether this kickoff should stamp onboarding completion after the chat exists. */
  complete: boolean;
};

export type KickoffOnboardingResult = {
  chatId: string;
  /** Present only when this call actually sent the bootstrap message — the
   *  route uses it to notify recipients. Absent on a retry that found the
   *  message already there. */
  sent?: { recipients: string[]; messageId: string };
};

/**
 * Idempotent server-side tail of onboarding. Folds the three steps the browser
 * used to orchestrate (create the first chat → send the bootstrap → stamp
 * completion) into one resumable operation:
 *
 *   1. find-or-create the kickoff chat, keyed by `<humanAgentId>:<targetAgentId>:<kind>`
 *      (race-safe via the unique index on `chats.onboarding_kickoff_key`);
 *   2. send the bootstrap message only if the chat has no messages yet, under a
 *      row lock so concurrent requests can't both send;
 *   3. optionally stamp `onboarding_completed_at` (+ suppressed/reason) only
 *      after the chat exists, and only if not already stamped.
 *
 * Re-running it — a reopened tab, a network retry, or the build-tree recovery
 * surface — converges on the same chat. Single-chat onboarding paths keep
 * `complete: true`; multi-chat paths use `complete: false` and stamp completion
 * only after all required chats exist. The `kind` is part of the key so an
 * "intro", value-first "work", and later "tree" (`/build-tree`) kickoff for the
 * same agent stay distinct chats.
 */
export async function kickoffOnboarding(db: Database, args: KickoffOnboardingArgs): Promise<KickoffOnboardingResult> {
  const kickoffKey = `${args.humanAgentId}:${args.targetAgentId}:${args.kind}`;

  // 1. Find-or-create the kickoff chat. The fast path (existing chat) skips
  //    participant re-validation; only a first run pays for createChat, whose
  //    ON CONFLICT DO NOTHING absorbs a concurrent first run.
  let chatId: string;
  const [existing] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.onboardingKickoffKey, kickoffKey))
    .limit(1);
  if (existing) {
    chatId = existing.id;
  } else {
    const created = await createChat(db, {
      mode: "legacy-empty-agent",
      creatorAgentId: args.humanAgentId,
      participantAgentIds: [args.targetAgentId],
      onboardingKickoffKey: kickoffKey,
    });
    chatId = created.id;
  }

  // 2. Send the bootstrap only if the chat is still empty — under a row lock on
  //    the chat so concurrent kickoffs (double-click, two tabs, retry mid-flight)
  //    serialize: the second waits for the first to commit, then sees the message
  //    and skips. Without the lock both could read empty and both send. sendMessage
  //    opens its own (now nested → savepoint) transaction; passing the tx as the
  //    db is the established cross-service pattern for tx-scoped writes.
  let sent: KickoffOnboardingResult["sent"];
  await db.transaction(async (tx) => {
    await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for("update");
    const [firstMessage] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .limit(1);
    if (firstMessage) return;
    const message: SendMessage = {
      format: "text",
      content: args.bootstrap,
      source: "api",
      metadata: { systemSender: "first_tree_onboarding" },
    };
    // tx → Database: drizzle transaction handles aren't structurally Database;
    // the `as unknown as` bridge is the same pattern used in member.ts /
    // resources.ts / org-settings.ts for tx-scoped service calls.
    const result = await sendMessage(tx as unknown as Database, chatId, args.humanAgentId, message, {
      addressedToAgentIds: [args.targetAgentId],
      allowSystemSender: true,
    });
    sent = { recipients: result.recipients, messageId: result.message.id };
  });

  // 3. Stamp completion now that the chat exists, when requested. Multi-chat
  //    onboarding paths defer this until every required kickoff chat has
  //    succeeded. Mirrors POST /me/onboarding-completed: completion writes the
  //    audit stamp AND the suppressor (reason="completed") together.
  if (args.complete) {
    const now = new Date();
    await db
      .update(members)
      .set({
        onboardingCompletedAt: now,
        onboardingSuppressedAt: now,
        onboardingSuppressedReason: "completed",
      })
      .where(and(eq(members.id, args.memberId), isNull(members.onboardingCompletedAt)));
  }

  return { chatId, sent };
}
