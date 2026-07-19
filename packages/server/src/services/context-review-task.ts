import { createHash } from "node:crypto";
import {
  AGENT_STATUSES,
  AGENT_TYPES,
  CONTEXT_REVIEW_TASK_TYPE,
  type ContextReviewTaskCreateMetadata,
  type ContextTreeActiveBinding,
  type ContextTreeWritePreflightErrorCode,
  canonicalGitRepoUrl,
  contextReviewTaskCreateMetadataSchema,
  contextTreeActiveBindingSchema,
} from "@first-tree/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { TaskChatReuseActivity } from "./chat.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import {
  type DeferredSendMessagePostCommitEffects,
  runDeferredSendMessagePostCommitEffects,
  sendMessage,
} from "./message.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";
import { addChatParticipants, recomputeChatWatchers } from "./participant-mode.js";

type RequesterIdentity = {
  userId: string;
  memberId: string;
  humanAgentUuid: string;
};

export type ContextReviewTaskAuthority = {
  repository: string;
  reviewerAgentUuid: string;
  reservationKey: string;
  topic: string;
};

export type ContextTreeWritePreflightAuthority = {
  binding: ContextTreeActiveBinding;
  reviewerAgentUuid: string;
  requesterGithubLogin: string;
};

export class ContextTreeWritePreflightError extends Error {
  constructor(
    readonly code: ContextTreeWritePreflightErrorCode,
    readonly statusCode: 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ContextTreeWritePreflightError";
  }
}

export type ManagedContextReviewWebhookEvent = {
  organizationId: string;
  repository: string;
  pullRequest: number;
  title: string;
  htmlUrl: string;
  eventType: "pull_request" | "issue_comment" | "pull_request_review_comment";
  action: "opened" | "synchronize" | "ready_for_review" | "reopened" | "edited" | "created";
  triggerEvent: string;
  deliveryId: string | null;
  senderLogin: string;
  senderType: string | null;
  headSha: string | null;
  isDraft: boolean | null;
  commentUrl: string | null;
  commentAuthorLogin: string | null;
  commentAuthorType: string | null;
  commentBody: string | null;
};

export type ManagedContextReviewWebhookResult =
  | { outcome: "task_missing" }
  | {
      outcome: "opened_noop" | "projection_reflection" | "delivery_replay";
      chatId: string;
      messageId: string;
    }
  | { outcome: "delivered"; chatId: string; messageId: string; recipients: string[] };

type ContextReviewParticipantReconciliation = {
  reviewerAgentUuid: string;
  previousReviewerAgentUuid: string | null;
  takeoverRequired: boolean;
};

type ManagedContextReviewTaskSeed = {
  chatId: string;
  openingMessageId: string;
  requester: RequesterIdentity;
  metadata: ContextReviewTaskCreateMetadata;
};

const CONTEXT_REVIEW_RESULT_MARKER_PATTERN =
  /<!-- first-tree-context-review-result:v1 chat=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) reviewer=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) head=([0-9a-f]{40}) -->/g;

function canonicalGithubRepository(value: string): string | null {
  const canonical = canonicalGitRepoUrl(`https://github.com/${value}`)?.toLowerCase() ?? null;
  return canonical?.startsWith("github.com/") ? canonical.slice("github.com/".length) : null;
}

function canonicalBoundGithubRepository(value: string | null): string | null {
  const canonical = canonicalGitRepoUrl(value)?.toLowerCase() ?? null;
  return canonical?.startsWith("github.com/") ? canonical.slice("github.com/".length) : null;
}

export function contextReviewTaskReservationKey(input: {
  organizationId: string;
  repository: string;
  pullRequest: number;
}): string {
  const digest = createHash("sha256")
    .update([CONTEXT_REVIEW_TASK_TYPE, input.repository, String(input.pullRequest)].join("\0"))
    .digest("hex");
  return `task:v1:${input.organizationId}:context-review:${digest}`;
}

function assertMatchingStoredTask(input: {
  chat: typeof chats.$inferSelect;
  openingMessage: typeof messages.$inferSelect;
  organizationId: string;
  requesterAgentUuid: string;
  authority: ContextReviewTaskAuthority;
  metadata: ContextReviewTaskCreateMetadata;
}): void {
  const { chat, openingMessage, organizationId, requesterAgentUuid, authority, metadata } = input;
  if (chat.organizationId !== organizationId || openingMessage.senderId !== requesterAgentUuid) {
    throw new ConflictError("This Agent Review task was already dispatched by another member");
  }

  const storedMetadata = openingMessage.metadata;
  const storedEnvelope = contextReviewTaskCreateMetadataSchema.safeParse({
    taskType: storedMetadata.taskType,
    reviewPacketV1: storedMetadata.reviewPacketV1,
  });
  const storedRepository = storedEnvelope.success
    ? canonicalGithubRepository(storedEnvelope.data.reviewPacketV1.repository)
    : null;
  const storedMentions = storedMetadata.mentions;
  if (
    !storedEnvelope.success ||
    storedRepository !== authority.repository ||
    storedEnvelope.data.reviewPacketV1.pullRequest !== metadata.reviewPacketV1.pullRequest ||
    !Array.isArray(storedMentions) ||
    storedMentions.length !== 1 ||
    typeof storedMentions[0] !== "string"
  ) {
    throw new ConflictError("Agent Review task reservation conflicts with an existing task");
  }
}

async function resolveRecordedReviewerAgentUuid(
  db: Database,
  input: {
    chatId: string;
    openingMessage: typeof messages.$inferSelect;
    requesterAgentUuid: string;
  },
): Promise<string> {
  const initialMentions = input.openingMessage.metadata.mentions;
  const initialReviewerAgentUuid =
    Array.isArray(initialMentions) && initialMentions.length === 1 && typeof initialMentions[0] === "string"
      ? initialMentions[0]
      : null;
  if (!initialReviewerAgentUuid) {
    throw new ConflictError("Agent Review task opening has ambiguous Reviewer history");
  }

  const takeoverRows = await db
    .select({ senderId: messages.senderId, metadata: messages.metadata })
    .from(messages)
    .where(and(eq(messages.chatId, input.chatId), sql`${messages.metadata} ? 'contextReviewTakeoverV1'`))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  let recordedReviewerAgentUuid = initialReviewerAgentUuid;
  for (const row of takeoverRows) {
    const takeover = z
      .object({
        schemaVersion: z.literal(1),
        reviewerAgentUuid: z.string().min(1),
        previousReviewerAgentUuid: z.string().min(1).nullable(),
      })
      .strict()
      .safeParse(row.metadata.contextReviewTakeoverV1);
    if (row.senderId !== input.requesterAgentUuid || !takeover.success) {
      throw new ConflictError("Agent Review task has ambiguous takeover history");
    }
    const continuesAssignment = takeover.data.previousReviewerAgentUuid === recordedReviewerAgentUuid;
    const restoresRecordedMembership =
      takeover.data.previousReviewerAgentUuid === null && takeover.data.reviewerAgentUuid === recordedReviewerAgentUuid;
    if (!continuesAssignment && !restoresRecordedMembership) {
      throw new ConflictError("Agent Review task has ambiguous takeover history");
    }
    recordedReviewerAgentUuid = takeover.data.reviewerAgentUuid;
  }
  return recordedReviewerAgentUuid;
}

async function reconcileContextReviewTaskParticipants(
  db: Database,
  input: {
    chat: typeof chats.$inferSelect;
    openingMessage: typeof messages.$inferSelect;
    organizationId: string;
    requesterAgentUuid: string;
    authority: ContextReviewTaskAuthority;
    metadata: ContextReviewTaskCreateMetadata;
  },
): Promise<ContextReviewParticipantReconciliation> {
  assertMatchingStoredTask(input);

  const speakerRows = await db
    .select({
      agentId: chatMembership.agentId,
      type: agents.type,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(and(eq(chatMembership.chatId, input.chat.id), eq(chatMembership.accessMode, "speaker")))
    .for("update");

  if (!speakerRows.some((speaker) => speaker.agentId === input.requesterAgentUuid)) {
    throw new ConflictError("Agent Review task requester is no longer a Chat speaker");
  }

  const reviewerAgentUuid = input.authority.reviewerAgentUuid;
  const recordedReviewerAgentUuid = await resolveRecordedReviewerAgentUuid(db, {
    chatId: input.chat.id,
    openingMessage: input.openingMessage,
    requesterAgentUuid: input.requesterAgentUuid,
  });
  const nonHumanSpeakerIds = speakerRows
    .filter((speaker) => speaker.type !== AGENT_TYPES.HUMAN)
    .map((speaker) => speaker.agentId);
  const unexpectedAgentIds = nonHumanSpeakerIds.filter(
    (agentId) => agentId !== reviewerAgentUuid && agentId !== recordedReviewerAgentUuid,
  );
  if (unexpectedAgentIds.length > 0) {
    throw new ConflictError("Agent Review task has ambiguous Reviewer participants");
  }

  const currentReviewerIsSpeaker = speakerRows.some((speaker) => speaker.agentId === reviewerAgentUuid);
  if (currentReviewerIsSpeaker && recordedReviewerAgentUuid === reviewerAgentUuid && nonHumanSpeakerIds.length === 1) {
    return { reviewerAgentUuid, previousReviewerAgentUuid: null, takeoverRequired: false };
  }

  await addChatParticipants(db, input.chat.id, [{ agentId: reviewerAgentUuid }], {
    onConflictDoNothing: true,
    upgradeWatcherToSpeaker: true,
  });

  const recordedReviewerIsSpeaker = speakerRows.some((speaker) => speaker.agentId === recordedReviewerAgentUuid);
  const previousReviewerAgentUuid = recordedReviewerAgentUuid !== reviewerAgentUuid ? recordedReviewerAgentUuid : null;
  if (previousReviewerAgentUuid && recordedReviewerIsSpeaker) {
    await db
      .delete(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, input.chat.id),
          eq(chatMembership.agentId, previousReviewerAgentUuid),
          eq(chatMembership.accessMode, "speaker"),
        ),
      );
    await recomputeChatWatchers(db, input.chat.id);
  }

  return { reviewerAgentUuid, previousReviewerAgentUuid, takeoverRequired: true };
}

/**
 * Reconcile the one live Reviewer speaker for an existing managed PR task.
 * The keyed task transaction already holds the organization/settings lock and
 * the Chat row lock, so membership, silent backfill, takeover message, and
 * watcher projection commit as one unit. The first opening and packet remain
 * immutable; the live assignment is represented only by current membership.
 */
export async function reconcileContextReviewTaskReuse(
  db: Database,
  input: {
    chat: typeof chats.$inferSelect;
    openingMessage: typeof messages.$inferSelect;
    organizationId: string;
    requesterAgentUuid: string;
    authority: ContextReviewTaskAuthority;
    metadata: ContextReviewTaskCreateMetadata;
  },
): Promise<TaskChatReuseActivity | null> {
  const reconciliation = await reconcileContextReviewTaskParticipants(db, input);
  if (!reconciliation.takeoverRequired) return null;

  return sendContextReviewTakeoverMessage(db, {
    chatId: input.chat.id,
    requesterAgentUuid: input.requesterAgentUuid,
    reconciliation,
  });
}

async function sendContextReviewTakeoverMessage(
  db: Database,
  input: {
    chatId: string;
    requesterAgentUuid: string;
    reconciliation: ContextReviewParticipantReconciliation;
  },
): Promise<TaskChatReuseActivity> {
  const sent = await sendMessage(
    db,
    input.chatId,
    input.requesterAgentUuid,
    {
      format: "markdown",
      content:
        "First Tree reassigned this Agent Review to the currently configured Reviewer. Re-read live configuration and review the current PR head using the preserved opening and Chat history.",
      metadata: {
        contextReviewTakeoverV1: {
          schemaVersion: 1,
          reviewerAgentUuid: input.reconciliation.reviewerAgentUuid,
          previousReviewerAgentUuid: input.reconciliation.previousReviewerAgentUuid,
        },
      },
      source: "api",
    },
    {
      addressedToAgentIds: [input.reconciliation.reviewerAgentUuid],
      allowContextReviewRun: true,
      deferPostCommitEffects: true,
    },
  );
  if (!sent.deferredPostCommitEffects) {
    throw new Error("Agent Review takeover did not return deferred post-commit effects");
  }
  return {
    ...sent,
    deferredPostCommitEffects: sent.deferredPostCommitEffects,
  };
}

async function lockOrganization(db: Database, organizationId: string): Promise<void> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!organization) throw new NotFoundError(`Organization "${organizationId}" not found`);
}

async function readGithubIdentityLogin(db: Database, requester: RequesterIdentity): Promise<string | null> {
  const [identity] = await db
    .select({ login: sql<string | null>`${authIdentities.metadata}->>'login'` })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, requester.userId), eq(authIdentities.provider, "github")))
    .limit(1);
  return identity?.login?.trim() || null;
}

async function requireMatchingGithubIdentity(
  db: Database,
  requester: RequesterIdentity,
  packetLogin: string,
): Promise<void> {
  const login = await readGithubIdentityLogin(db, requester);
  if (!login) {
    throw new ForbiddenError("Connect your GitHub identity to First Tree before dispatching Agent Review");
  }
  if (login.toLowerCase() !== packetLogin.toLowerCase()) {
    throw new ForbiddenError("reviewPacketV1 requesterGithubLogin does not match the signed-in member");
  }
}

async function isActiveContextReviewer(
  db: Database,
  input: { organizationId: string; reviewerAgentUuid: string; lock: boolean },
): Promise<boolean> {
  const reviewerQuery = db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.uuid, input.reviewerAgentUuid))
    .limit(1);
  const reviewerRows = input.lock ? await reviewerQuery.for("update") : await reviewerQuery;
  const [reviewer] = reviewerRows;
  return (
    reviewer !== undefined &&
    reviewer.organizationId === input.organizationId &&
    reviewer.type !== AGENT_TYPES.HUMAN &&
    reviewer.status === AGENT_STATUSES.ACTIVE
  );
}

async function requireActiveRequesterMembership(
  db: Database,
  input: {
    organizationId: string;
    requester: RequesterIdentity;
    lock: boolean;
  },
): Promise<void> {
  const memberQuery = db
    .select({
      id: members.id,
      userId: members.userId,
      organizationId: members.organizationId,
      agentId: members.agentId,
      status: members.status,
    })
    .from(members)
    .where(eq(members.id, input.requester.memberId))
    .limit(1);
  const memberRows = input.lock ? await memberQuery.for("update") : await memberQuery;
  const [member] = memberRows;
  if (
    !member ||
    member.userId !== input.requester.userId ||
    member.organizationId !== input.organizationId ||
    member.agentId !== input.requester.humanAgentUuid ||
    member.status !== "active"
  ) {
    throw new ForbiddenError("Agent Review dispatch requires the requester's active Team membership");
  }

  const humanAgentQuery = db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(eq(agents.uuid, input.requester.humanAgentUuid))
    .limit(1);
  const humanAgentRows = input.lock ? await humanAgentQuery.for("update") : await humanAgentQuery;
  const [humanAgent] = humanAgentRows;
  if (
    !humanAgent ||
    humanAgent.organizationId !== input.organizationId ||
    humanAgent.type !== AGENT_TYPES.HUMAN ||
    humanAgent.status !== AGENT_STATUSES.ACTIVE ||
    humanAgent.managerId !== input.requester.memberId
  ) {
    throw new ForbiddenError("Agent Review dispatch requires the requester's active human identity");
  }
}

/**
 * Check whether a clean BYO writer may start or continue local authoring.
 * This is deliberately stateless: it creates no task key, Chat, PR, review,
 * or merge authority. The keyed dispatch path below remains the only writer
 * of those states and re-resolves this same live Team configuration.
 */
export async function preflightContextTreeWriteAuthority(
  db: Database,
  input: {
    organizationId: string;
    requester: RequesterIdentity;
    requesterGithubLogin: string;
  },
): Promise<ContextTreeWritePreflightAuthority> {
  try {
    await requireActiveRequesterMembership(db, {
      organizationId: input.organizationId,
      requester: input.requester,
      lock: false,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw new ContextTreeWritePreflightError(
        "CONTEXT_TREE_WRITE_AUTHORITY_FAILED",
        403,
        "Context Tree Write requires the requester's current active Team membership and human identity.",
      );
    }
    throw error;
  }

  let runtime: Awaited<ReturnType<typeof getOrgContextReviewRuntime>>;
  try {
    runtime = await getOrgContextReviewRuntime(db, input.organizationId);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ContextTreeWritePreflightError(
        "CONTEXT_TREE_WRITE_CONFIGURATION_INVALID",
        409,
        "The selected Team's Context Tree Write configuration is invalid and must be repaired.",
      );
    }
    throw error;
  }

  const binding = contextTreeActiveBindingSchema.safeParse({ repo: runtime.repo, branch: runtime.branch });
  if (!binding.success) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNAVAILABLE",
      409,
      "The selected Team does not have a valid current Context Tree binding.",
    );
  }
  if (canonicalBoundGithubRepository(binding.data.repo) === null) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED",
      409,
      "Managed Agent Review currently requires the selected Team's Context Tree binding to be on GitHub.",
    );
  }
  if (!runtime.contextReviewer.enabled || !runtime.contextReviewer.agentUuid) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_REVIEW_UNAVAILABLE",
      409,
      "The selected Team does not currently have Agent Review enabled with an assigned Reviewer.",
    );
  }

  const reviewerAgentUuid = runtime.contextReviewer.agentUuid;
  const reviewerActive = await isActiveContextReviewer(db, {
    organizationId: input.organizationId,
    reviewerAgentUuid,
    lock: false,
  });
  if (!reviewerActive) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_REVIEWER_UNAVAILABLE",
      409,
      "The selected Team's current Reviewer is not an active non-human Agent in that Team.",
    );
  }

  const linkedGithubLogin = await readGithubIdentityLogin(db, input.requester);
  if (!linkedGithubLogin) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_REQUIRED",
      403,
      "Connect your GitHub identity to First Tree before starting Context Tree Write.",
    );
  }
  if (linkedGithubLogin.toLowerCase() !== input.requesterGithubLogin.toLowerCase()) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH",
      403,
      "The local GitHub login does not match the signed-in First Tree member.",
    );
  }

  return {
    binding: binding.data,
    reviewerAgentUuid,
    requesterGithubLogin: linkedGithubLogin,
  };
}

/**
 * Resolve the only authority tuple that may receive a Write-created review
 * task. `lock=true` is used inside the keyed chat transaction: requester
 * membership and human-mirror locks serialize leave/removal, settings writes
 * take the same organization-row lock, and the Reviewer row lock serializes a
 * concurrent suspend/delete across this admission check.
 */
export async function resolveContextReviewTaskAuthority(
  db: Database,
  input: {
    organizationId: string;
    requester: RequesterIdentity;
    metadata: ContextReviewTaskCreateMetadata;
    lock?: boolean;
    expectedReviewerAgentUuid?: string;
  },
): Promise<ContextReviewTaskAuthority> {
  if (input.lock) await lockOrganization(db, input.organizationId);

  // Admission and task persistence share one linearization boundary. Member
  // leave/admin removal lock the same member row before suspending its human
  // mirror, so lock in member -> human-Agent order here and hold both through
  // keyed create/reuse. A request that passed route preflight either commits
  // before revocation, or observes the inactive tuple and persists nothing.
  await requireActiveRequesterMembership(db, {
    organizationId: input.organizationId,
    requester: input.requester,
    lock: input.lock === true,
  });

  let runtime: Awaited<ReturnType<typeof getOrgContextReviewRuntime>>;
  try {
    runtime = await getOrgContextReviewRuntime(db, input.organizationId);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConflictError("Context Reviewer configuration is invalid");
    }
    throw error;
  }
  const packet = input.metadata.reviewPacketV1;
  const repository = canonicalGithubRepository(packet.repository);
  const boundRepository = canonicalBoundGithubRepository(runtime.repo);
  if (!repository || !boundRepository || repository !== boundRepository) {
    throw new BadRequestError("reviewPacketV1 repository does not match the live bound Context Tree");
  }
  if (!runtime.branch || packet.baseRef !== runtime.branch) {
    throw new BadRequestError("reviewPacketV1 baseRef does not match the live bound Context Tree branch");
  }
  if (!runtime.contextReviewer.enabled || !runtime.contextReviewer.agentUuid) {
    throw new ConflictError("Agent Review is not enabled with an assigned Reviewer");
  }
  const reviewerAgentUuid = runtime.contextReviewer.agentUuid;
  if (input.expectedReviewerAgentUuid && reviewerAgentUuid !== input.expectedReviewerAgentUuid) {
    throw new ConflictError("The assigned Agent Review Reviewer changed during dispatch; retry the same request");
  }

  const reviewerActive = await isActiveContextReviewer(db, {
    organizationId: input.organizationId,
    reviewerAgentUuid,
    lock: input.lock === true,
  });
  if (!reviewerActive) {
    throw new ConflictError("The assigned Agent Review Reviewer is not an active non-human Agent in this Team");
  }

  await requireMatchingGithubIdentity(db, input.requester, packet.requesterGithubLogin);

  return {
    repository,
    reviewerAgentUuid,
    reservationKey: contextReviewTaskReservationKey({
      organizationId: input.organizationId,
      repository,
      pullRequest: packet.pullRequest,
    }),
    topic: `Agent Review: ${repository}#${packet.pullRequest}`,
  };
}

async function loadManagedContextReviewTaskSeed(
  db: Database,
  reservationKey: string,
): Promise<ManagedContextReviewTaskSeed | null> {
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.onboardingKickoffKey, reservationKey))
    .limit(1);
  if (!chat) return null;

  const [openingMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chat.id))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(1);
  if (!openingMessage) {
    throw new ConflictError("Managed Agent Review task is missing its immutable opening");
  }

  const parsedMetadata = contextReviewTaskCreateMetadataSchema.safeParse({
    taskType: openingMessage.metadata.taskType,
    reviewPacketV1: openingMessage.metadata.reviewPacketV1,
  });
  if (!parsedMetadata.success) {
    throw new ConflictError("Managed Agent Review task opening metadata is invalid");
  }

  const [requester] = await db
    .select({
      userId: members.userId,
      memberId: members.id,
      humanAgentUuid: agents.uuid,
    })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .where(eq(agents.uuid, openingMessage.senderId))
    .limit(1);
  if (!requester) {
    throw new ConflictError("Managed Agent Review task requester identity is invalid");
  }

  return {
    chatId: chat.id,
    openingMessageId: openingMessage.id,
    requester,
    metadata: parsedMetadata.data,
  };
}

function parseContextReviewResultMarker(
  value: string,
): { chatId: string; reviewerAgentUuid: string; headSha: string } | null {
  const matches = [...value.matchAll(CONTEXT_REVIEW_RESULT_MARKER_PATTERN)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const chatId = match?.[1];
  const reviewerAgentUuid = match?.[2];
  const headSha = match?.[3];
  return chatId && reviewerAgentUuid && headSha ? { chatId, reviewerAgentUuid, headSha } : null;
}

async function findMatchingManagedProjectionMessageId(
  db: Database,
  input: {
    chatId: string;
    reviewerAgentUuid: string;
    commentAuthorLogin: string | null;
    commentBody: string | null;
  },
): Promise<string | null> {
  const commentAuthorLogin = input.commentAuthorLogin?.trim().toLowerCase();
  if (!commentAuthorLogin || !input.commentBody) return null;

  const reviewerManagerGithubIdentities = await db
    .select({ login: sql<string | null>`${authIdentities.metadata}->>'login'` })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .innerJoin(authIdentities, and(eq(authIdentities.userId, members.userId), eq(authIdentities.provider, "github")))
    .where(eq(agents.uuid, input.reviewerAgentUuid));
  if (!reviewerManagerGithubIdentities.some(({ login }) => login?.trim().toLowerCase() === commentAuthorLogin)) {
    return null;
  }

  const marker = parseContextReviewResultMarker(input.commentBody);
  if (!marker || marker.chatId !== input.chatId || marker.reviewerAgentUuid !== input.reviewerAgentUuid) {
    return null;
  }

  const reviewerMessages = await db
    .select({ id: messages.id, content: messages.content, metadata: messages.metadata })
    .from(messages)
    .where(and(eq(messages.chatId, input.chatId), eq(messages.senderId, input.reviewerAgentUuid)))
    .orderBy(desc(messages.createdAt), desc(messages.id));
  for (const message of reviewerMessages) {
    if (typeof message.content !== "string") continue;
    const candidate = parseContextReviewResultMarker(message.content);
    if (
      !candidate ||
      candidate.chatId !== marker.chatId ||
      candidate.reviewerAgentUuid !== marker.reviewerAgentUuid ||
      candidate.headSha !== marker.headSha
    ) {
      continue;
    }
    if (Object.hasOwn(message.metadata, "editedAt")) return null;
    return message.content === input.commentBody ? message.id : null;
  }
  return null;
}

async function findManagedWebhookDeliveryMessageId(
  db: Database,
  input: { chatId: string; deliveryId: string | null },
): Promise<string | null> {
  if (!input.deliveryId) return null;
  const [message] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, input.chatId),
        sql`${messages.metadata}->'contextReviewManagedEventV1'->>'deliveryId' = ${input.deliveryId}`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return message?.id ?? null;
}

function renderManagedContextReviewEvent(
  input: ManagedContextReviewWebhookEvent,
  reconciliation: ContextReviewParticipantReconciliation,
): string {
  const lines: string[] = [];
  if (reconciliation.takeoverRequired) {
    lines.push(
      "First Tree reassigned this Agent Review to the currently configured Reviewer in the existing task Chat.",
      "",
    );
  }
  lines.push(
    "GitHub reported meaningful follow-up activity for this managed Agent Review task.",
    "",
    `Repository: ${input.repository}`,
    `Pull request: #${input.pullRequest}`,
    `Title: ${input.title}`,
    `URL: ${input.htmlUrl}`,
    `Trigger event: ${input.triggerEvent}`,
    `Event sender: ${input.senderLogin}`,
  );
  if (input.headSha) lines.push(`Head from webhook: ${input.headSha}`);
  if (input.isDraft !== null) lines.push(`Draft status from webhook: ${input.isDraft ? "draft" : "ready for review"}`);
  if (input.commentAuthorLogin) lines.push(`Comment author: ${input.commentAuthorLogin}`);
  if (input.commentUrl) lines.push(`Comment URL: ${input.commentUrl}`);
  lines.push(
    "",
    "Treat this webhook only as a trigger. Re-read live Reviewer assignment, the current PR head and body, complete GitHub discussion, and the preserved Chat history before choosing or reusing any result.",
  );
  return lines.join("\n");
}

function managedContextReviewEventMetadata(
  input: ManagedContextReviewWebhookEvent,
  reconciliation: ContextReviewParticipantReconciliation,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    schemaVersion: 1,
    eventType: input.eventType,
    action: input.action,
    triggerEvent: input.triggerEvent,
    repository: input.repository,
    pullRequest: input.pullRequest,
    senderLogin: input.senderLogin,
  };
  if (input.deliveryId) event.deliveryId = input.deliveryId;
  if (input.headSha) event.headSha = input.headSha;
  if (input.isDraft !== null) event.isDraft = input.isDraft;
  if (input.commentAuthorLogin) event.commentAuthorLogin = input.commentAuthorLogin;
  if (input.commentUrl) event.commentUrl = input.commentUrl;

  return {
    source: "github",
    systemSender: "github",
    contextReviewManagedEventV1: event,
    ...(reconciliation.takeoverRequired
      ? {
          contextReviewTakeoverV1: {
            schemaVersion: 1,
            reviewerAgentUuid: reconciliation.reviewerAgentUuid,
            previousReviewerAgentUuid: reconciliation.previousReviewerAgentUuid,
          },
        }
      : {}),
  };
}

type ManagedContextReviewWebhookTransactionResult =
  | Exclude<ManagedContextReviewWebhookResult, { outcome: "task_missing" | "delivered" }>
  | {
      outcome: "delivered";
      chatId: string;
      messageId: string;
      recipients: string[];
      effects: DeferredSendMessagePostCommitEffects;
    };

/**
 * Route a meaningful GitHub event into an already-created member-authored
 * Agent Review task. The stable keyed Chat remains the identity and the App
 * never creates a task, changes the first packet, or publishes a result.
 */
export async function dispatchManagedContextReviewWebhookEvent(
  db: Database,
  input: ManagedContextReviewWebhookEvent,
): Promise<ManagedContextReviewWebhookResult> {
  const repository = canonicalGithubRepository(input.repository);
  if (!repository) throw new BadRequestError("Managed Agent Review webhook repository is invalid");
  const reservationKey = contextReviewTaskReservationKey({
    organizationId: input.organizationId,
    repository,
    pullRequest: input.pullRequest,
  });
  const seed = await loadManagedContextReviewTaskSeed(db, reservationKey);
  if (!seed) return { outcome: "task_missing" };
  if (input.eventType === "pull_request" && input.action === "opened") {
    return { outcome: "opened_noop", chatId: seed.chatId, messageId: seed.openingMessageId };
  }

  const result = await db.transaction(async (tx): Promise<ManagedContextReviewWebhookTransactionResult> => {
    const transactionDb = tx as unknown as Database;
    const authority = await resolveContextReviewTaskAuthority(transactionDb, {
      organizationId: input.organizationId,
      requester: seed.requester,
      metadata: seed.metadata,
      lock: true,
    });
    if (authority.reservationKey !== reservationKey) {
      throw new ConflictError("Managed Agent Review webhook task identity changed during admission");
    }

    const [chat] = await tx
      .select()
      .from(chats)
      .where(eq(chats.onboardingKickoffKey, reservationKey))
      .for("update")
      .limit(1);
    if (!chat) throw new ConflictError("Managed Agent Review task disappeared during webhook admission");
    const [openingMessage] = await tx
      .select()
      .from(messages)
      .where(eq(messages.chatId, chat.id))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(1);
    if (!openingMessage || chat.id !== seed.chatId || openingMessage.id !== seed.openingMessageId) {
      throw new ConflictError("Managed Agent Review task opening changed during webhook admission");
    }

    const reconciliation = await reconcileContextReviewTaskParticipants(transactionDb, {
      chat,
      openingMessage,
      organizationId: input.organizationId,
      requesterAgentUuid: seed.requester.humanAgentUuid,
      authority,
      metadata: seed.metadata,
    });
    const replayedMessageId = await findManagedWebhookDeliveryMessageId(transactionDb, {
      chatId: chat.id,
      deliveryId: input.deliveryId,
    });
    if (replayedMessageId) {
      if (!reconciliation.takeoverRequired) {
        return { outcome: "delivery_replay", chatId: chat.id, messageId: replayedMessageId };
      }
      const takeover = await sendContextReviewTakeoverMessage(transactionDb, {
        chatId: chat.id,
        requesterAgentUuid: seed.requester.humanAgentUuid,
        reconciliation,
      });
      return {
        outcome: "delivered",
        chatId: chat.id,
        messageId: takeover.message.id,
        recipients: takeover.recipients,
        effects: takeover.deferredPostCommitEffects,
      };
    }
    if (!reconciliation.takeoverRequired && input.eventType === "issue_comment" && input.action === "created") {
      const reflectedMessageId = await findMatchingManagedProjectionMessageId(transactionDb, {
        chatId: chat.id,
        reviewerAgentUuid: reconciliation.reviewerAgentUuid,
        commentAuthorLogin: input.commentAuthorLogin,
        commentBody: input.commentBody,
      });
      if (reflectedMessageId) {
        return { outcome: "projection_reflection", chatId: chat.id, messageId: reflectedMessageId };
      }
    }

    const sent = await sendMessage(
      transactionDb,
      chat.id,
      seed.requester.humanAgentUuid,
      {
        format: "markdown",
        content: renderManagedContextReviewEvent({ ...input, repository }, reconciliation),
        metadata: managedContextReviewEventMetadata({ ...input, repository }, reconciliation),
        source: "github",
      },
      {
        addressedToAgentIds: [reconciliation.reviewerAgentUuid],
        allowContextReviewRun: true,
        allowSystemSender: true,
        deferPostCommitEffects: true,
      },
    );
    if (!sent.deferredPostCommitEffects) {
      throw new Error("Managed Agent Review webhook send did not return deferred post-commit effects");
    }
    return {
      outcome: "delivered",
      chatId: chat.id,
      messageId: sent.message.id,
      recipients: sent.recipients,
      effects: sent.deferredPostCommitEffects,
    };
  });

  if (result.outcome !== "delivered") return result;
  await runDeferredSendMessagePostCommitEffects(db, result.effects);
  invalidateChatAudience(result.chatId);
  return {
    outcome: "delivered",
    chatId: result.chatId,
    messageId: result.messageId,
    recipients: result.recipients,
  };
}
