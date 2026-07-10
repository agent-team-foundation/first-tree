import type { SendMessage } from "@first-tree/shared";
import { and, eq, isNull, like, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "./chat.js";

/**
 * Idempotency key for a production-scan fix launcher, shared by BOTH entry
 * paths so re-entering the fix link cannot create a second launcher:
 * the not-yet-onboarded path (`POST /me/onboarding/kickoff`) and the
 * already-onboarded direct path (`POST /orgs/:orgId/chats` task mode) both
 * compose it from the same `members.agentId` and repo slug, so the shared
 * `chats.onboarding_kickoff_key` unique constraint dedups them.
 */
export function scanFixKickoffKey(humanAgentId: string, repoSlug: string): string {
  // GitHub owner/repo are case-insensitive, and the two paths derive the slug
  // from separate parses of the fix link — lowercasing here (the single shared
  // composition point) keeps the key identical even if the URLs differ in case.
  return `${humanAgentId}:scan-fix:${repoSlug.toLowerCase()}`;
}

export type KickoffOnboardingArgs = {
  /** The membership whose completion is stamped once the chat exists. */
  memberId: string;
  /** The caller's human agent in the org — the chat creator and message sender. */
  humanAgentId: string;
  /** Organization that owns the kickoff chat. */
  organizationId: string;
  /** The bootstrap agent the kickoff chat is opened with. */
  targetAgentId: string;
  /** The user-visible first message body sent into the kickoff chat. */
  bootstrap: string;
  /** Display title for the created chat. */
  topic: string;
  /** Stable idempotency key for this kickoff surface. */
  kickoffKey: string;
  /** Whether this kickoff should stamp onboarding completion after the chat exists. */
  complete: boolean;
  /**
   * Optional side effect to run once the kickoff chat exists AND its
   * participants are validated — createChat enforces the cross-org / active /
   * private-target checks on first creation; an existing chat was validated
   * when it was created — but BEFORE the bootstrap is sent. Running it earlier
   * would let an unauthorized kickoff mutate another org/agent's resources
   * before the chat is rejected.
   */
  onChatReady?: () => Promise<void>;
};

export type KickoffOnboardingResult = {
  chatId: string;
  /** Present only when this call actually sent the bootstrap message — the
   *  route uses it to notify recipients. Absent on a retry that found the
   *  message already there. */
  sent?: { recipients: string[]; messageId: string };
};

/**
 * True only after a tree setup kickoff has a bootstrap message. A chat row by
 * itself is not enough: `kickoffOnboarding` creates the chat before sending the
 * message, so a send failure can leave an empty idempotency-keyed chat that a
 * later Context setup retry should still fill.
 */
export async function hasTreeSetupKickoffMessage(db: Database, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(chats)
    .innerJoin(messages, eq(messages.chatId, chats.id))
    .where(
      and(
        eq(chats.organizationId, organizationId),
        or(eq(chats.onboardingKickoffKey, `${organizationId}:tree-setup`), like(chats.onboardingKickoffKey, "%:tree")),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Idempotent server-side tail of onboarding. Folds the three steps the browser
 * used to orchestrate (create the first chat → send the bootstrap → stamp
 * completion) into one resumable operation:
 *
 *   1. find-or-create the kickoff chat, keyed by the caller-supplied stable
 *      onboarding key (race-safe via the unique index on
 *      `chats.onboarding_kickoff_key`);
 *   2. send the bootstrap message only if the chat has no messages yet;
 *   3. optionally stamp `onboarding_completed_at` (+ suppressed/reason) only
 *      after the chat exists, and only if not already stamped.
 *
 * Re-running it — a reopened tab, a network retry, or the tree setup recovery
 * surface — converges on the same chat. Single-chat onboarding paths keep
 * `complete: true`; support/background paths use `complete: false` and stamp
 * completion only after all required chats exist.
 */
export async function kickoffOnboarding(db: Database, args: KickoffOnboardingArgs): Promise<KickoffOnboardingResult> {
  const initialMessage: SendMessage = {
    format: "text",
    content: args.bootstrap,
    source: "api",
  };
  const created = await createChat(db, {
    mode: "task",
    initiatorAgentId: args.humanAgentId,
    organizationId: args.organizationId,
    initialRecipientAgentIds: [args.targetAgentId],
    contextParticipantAgentIds: [],
    topic: args.topic,
    initialMessage,
    source: "manual",
    onboardingKickoffKey: args.kickoffKey,
    beforeInitialMessage: args.onChatReady,
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

  return {
    chatId: created.chat.id,
    ...(created.initialMessageCreated
      ? { sent: { recipients: created.recipients, messageId: created.message.id } }
      : {}),
  };
}
