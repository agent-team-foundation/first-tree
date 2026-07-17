import { createHash } from "node:crypto";
import {
  AGENT_STATUSES,
  AGENT_TYPES,
  CONTEXT_REVIEW_TASK_TYPE,
  type ContextReviewTaskCreateMetadata,
  canonicalGitRepoUrl,
  contextReviewTaskCreateMetadataSchema,
} from "@first-tree/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import type { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { TaskChatReuseActivity } from "./chat.js";
import { sendMessage } from "./message.js";
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
    return null;
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

  const sent = await sendMessage(
    db,
    input.chat.id,
    input.requesterAgentUuid,
    {
      format: "markdown",
      content:
        "First Tree reassigned this Agent Review to the currently configured Reviewer. Re-read live configuration and review the current PR head using the preserved opening and Chat history.",
      metadata: {
        contextReviewTakeoverV1: {
          schemaVersion: 1,
          reviewerAgentUuid,
          previousReviewerAgentUuid,
        },
      },
      source: "api",
    },
    {
      addressedToAgentIds: [reviewerAgentUuid],
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

async function requireMatchingGithubIdentity(
  db: Database,
  requester: RequesterIdentity,
  packetLogin: string,
): Promise<void> {
  const [identity] = await db
    .select({ login: sql<string | null>`${authIdentities.metadata}->>'login'` })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, requester.userId), eq(authIdentities.provider, "github")))
    .limit(1);
  const login = identity?.login?.trim();
  if (!login) {
    throw new ForbiddenError("Connect your GitHub identity to First Tree before dispatching Agent Review");
  }
  if (login.toLowerCase() !== packetLogin.toLowerCase()) {
    throw new ForbiddenError("reviewPacketV1 requesterGithubLogin does not match the signed-in member");
  }
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

  const reviewerQuery = db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.uuid, reviewerAgentUuid))
    .limit(1);
  const reviewerRows = input.lock ? await reviewerQuery.for("update") : await reviewerQuery;
  const [reviewer] = reviewerRows;
  if (
    !reviewer ||
    reviewer.organizationId !== input.organizationId ||
    reviewer.type === AGENT_TYPES.HUMAN ||
    reviewer.status !== AGENT_STATUSES.ACTIVE
  ) {
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
