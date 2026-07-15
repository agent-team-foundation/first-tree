import type { SendMessage } from "@first-tree/shared";
import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "./chat.js";
import { runDeferredSendMessagePostCommitEffects, sendMessage } from "./message.js";

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
  /** Optional trusted metadata for a server-owned bootstrap variant. */
  bootstrapMetadata?: Record<string, unknown>;
  /** Display title for the created chat. */
  topic: string;
  /** Stable idempotency key for this kickoff surface. */
  kickoffKey: string;
  /**
   * How the membership's onboarding state is stamped once the chat exists:
   *   - "completed"    — terminal completion (audit stamp + suppressor,
   *     reason="completed"), the single-chat start-chat default;
   *   - "invitee_skip" — team-agent start: suppress auto-open only
   *     (reason="invitee_skip"), never completion, so the member lands in the
   *     workspace with the standard connect-computer → create-agent journey
   *     still pending and resumable;
   *   - "none"         — stamp nothing (support/background chats that defer
   *     completion until every required chat exists).
   */
  stamp: "completed" | "invitee_skip" | "none";
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

export type TreeSetupRecoveryMessage = {
  content: string;
  fingerprint: string;
};

/**
 * Append the current server-owned recovery diagnosis to an existing setup
 * chat and wake its selected agent. The setup kickoff itself is intentionally
 * sent only into an empty chat, but recovery is a new user turn: returning to
 * an established Phase 1/2 conversation must not silently navigate to stale
 * history.
 *
 * The chat row lock serializes concurrent CTA clicks. Only an immediately
 * repeated identical recovery turn is suppressed; once either participant has
 * replied, the same underlying failure can be raised again as a fresh turn.
 */
export async function appendTreeSetupRecoveryMessage(
  db: Database,
  args: {
    chatId: string;
    humanAgentId: string;
    targetAgentId: string;
    recovery: TreeSetupRecoveryMessage;
  },
): Promise<{ recipients: string[]; messageId: string } | null> {
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [chat] = await txDb
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, args.chatId))
      .for("update")
      .limit(1);
    if (!chat) throw new Error(`Context Tree setup chat "${args.chatId}" disappeared before recovery send`);

    const [latest] = await txDb
      .select({ content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.chatId, args.chatId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    if (
      latest?.metadata.contextTreeRecoveryFingerprint === args.recovery.fingerprint ||
      latest?.content === args.recovery.content
    ) {
      return null;
    }

    const sent = await sendMessage(
      txDb,
      args.chatId,
      args.humanAgentId,
      {
        format: "text",
        content: args.recovery.content,
        metadata: { contextTreeRecoveryFingerprint: args.recovery.fingerprint },
        source: "api",
      },
      { addressedToAgentIds: [args.targetAgentId], deferPostCommitEffects: true },
    );
    if (!sent.deferredPostCommitEffects) {
      throw new Error("Context Tree recovery send did not return deferred post-commit effects");
    }
    return {
      recipients: sent.recipients,
      messageId: sent.message.id,
      postCommitEffects: sent.deferredPostCommitEffects,
    };
  });
  if (!result) return null;
  await runDeferredSendMessagePostCommitEffects(db, result.postCommitEffects);
  return { recipients: result.recipients, messageId: result.messageId };
}

/**
 * Adopt the retired org-keyed setup chat only when its complete participant ACL
 * is exactly the initiating human and selected private agent. Older clients
 * used one org-wide key for an ordinary private task chat; blindly reusing that
 * row can cross administrator ownership boundaries, while always creating a
 * new row discards a safe same-chat Phase 1 history. The row lock + conditional
 * update make the narrow safe migration race-resilient.
 */
export async function adoptSafeLegacyTreeSetupChat(
  db: Database,
  args: { humanAgentId: string; organizationId: string; targetAgentId: string },
): Promise<void> {
  const legacyKey = `${args.organizationId}:tree-setup`;
  const scopedKey = `${args.humanAgentId}:${args.targetAgentId}:tree-setup`;

  await db.transaction(async (tx) => {
    const [scoped] = await tx
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, scopedKey))
      .limit(1);
    if (scoped) return;

    const [legacy] = await tx
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.organizationId, args.organizationId), eq(chats.onboardingKickoffKey, legacyKey)))
      .for("update")
      .limit(1);
    if (!legacy) return;

    const participants = await tx
      .select({ accessMode: chatMembership.accessMode, agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, legacy.id));
    const expected = new Set([args.humanAgentId, args.targetAgentId]);
    const exactPrivateBoundary =
      participants.length === expected.size &&
      participants.every((participant) => participant.accessMode === "speaker" && expected.has(participant.agentId));
    if (!exactPrivateBoundary) return;

    await tx
      .update(chats)
      .set({ onboardingKickoffKey: scopedKey })
      .where(and(eq(chats.id, legacy.id), eq(chats.onboardingKickoffKey, legacyKey)));
  });
}

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
        or(like(chats.onboardingKickoffKey, "%:tree-setup"), like(chats.onboardingKickoffKey, "%:tree")),
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
    ...(args.bootstrapMetadata ? { metadata: args.bootstrapMetadata } : {}),
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

  // 3. Stamp onboarding state now that the chat exists, when requested.
  //    Multi-chat onboarding paths defer this until every required kickoff
  //    chat has succeeded ("none"). Completion mirrors POST
  //    /me/onboarding-completed: the audit stamp AND the suppressor
  //    (reason="completed") are written together. A team-agent start writes
  //    only the suppressor with reason="invitee_skip": the member enters the
  //    workspace through a teammate's org-visible agent, and the standard
  //    connect-computer → create-agent journey stays pending (never stamped
  //    complete) so it remains resumable.
  if (args.stamp === "completed") {
    const now = new Date();
    await db
      .update(members)
      .set({
        onboardingCompletedAt: now,
        onboardingSuppressedAt: now,
        onboardingSuppressedReason: "completed",
      })
      .where(and(eq(members.id, args.memberId), isNull(members.onboardingCompletedAt)));
  } else if (args.stamp === "invitee_skip") {
    // Guarded like PATCH /me/onboarding: only the first suppressor wins, so a
    // retry (or a member who already dismissed/completed) never rewrites an
    // existing stamp or downgrades a completed membership.
    await db
      .update(members)
      .set({
        onboardingSuppressedAt: new Date(),
        onboardingSuppressedReason: "invitee_skip",
      })
      .where(and(eq(members.id, args.memberId), isNull(members.onboardingSuppressedAt)));
  }

  return {
    chatId: created.chat.id,
    ...(created.initialMessageCreated
      ? { sent: { recipients: created.recipients, messageId: created.message.id } }
      : {}),
  };
}
