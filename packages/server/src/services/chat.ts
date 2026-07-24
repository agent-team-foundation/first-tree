import { randomUUID } from "node:crypto";
import {
  type AddParticipant,
  AGENT_STATUSES,
  AGENT_TYPES,
  CHAT_ENGAGEMENT_STATUSES,
  type LegacyCreateChat,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
  type SendMessage,
} from "@first-tree/shared";
import { and, asc, desc, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { resolveAvatarImageUrl } from "./agent.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { resolveChatTitle } from "./me-chat.js";
import {
  type DeferredSendMessagePostCommitEffects,
  preflightMessageSendIntent,
  runDeferredSendMessagePostCommitEffects,
  type SendIntentParticipant,
  type SendMessageResult,
  sendMessage,
} from "./message.js";
import { WIRE_RECIPIENT_MODE } from "./message-dispatcher.js";
import { inviteParticipantsToChat, rejectedPrivateTargets } from "./participant-invite.js";
import { addChatParticipants, applyMembershipWrite, recomputeChatWatchers } from "./participant-mode.js";
import { extractSummary } from "./session.js";
import { leaveAsParticipant } from "./watcher.js";

const SELF_TARGET_EFFECTIVE_SENDER_REASON = "self_target_manager_human" as const;

type LandingCampaignTrialCreateOptions = {
  allowLandingCampaignTrial?: boolean;
};

export type TaskChatReuseContext = {
  chat: typeof chats.$inferSelect;
  openingMessage: typeof messages.$inferSelect;
};

export type TaskChatReuseActivity = SendMessageResult & {
  deferredPostCommitEffects: DeferredSendMessagePostCommitEffects;
};

export type CreateTaskChatInput = {
  mode: "task";
  initiatorAgentId: string;
  organizationId: string;
  initialRecipientAgentIds: readonly string[];
  contextParticipantAgentIds: readonly string[];
  topic?: string | null;
  description?: string | null;
  onboardingKickoffKey?: string;
  beforeInitialMessage?: () => Promise<void>;
  /** Runs inside every keyed resolution transaction, including reuse. */
  beforeTaskResult?: (db: Database) => Promise<void>;
  /** Reconciles live task state inside the locked keyed-Chat reuse transaction. */
  onTaskReuse?: (db: Database, context: TaskChatReuseContext) => Promise<TaskChatReuseActivity | null>;
  initialMessage: SendMessage;
  /** Trusted internal capability forwarded only for Context Reviewer bootstrap. */
  allowContextReviewRun?: boolean;
  /** Return session/kick effects to a caller that owns a wider transaction. */
  deferPostCommitEffects?: boolean;
  source: "agent" | "manual";
} & LandingCampaignTrialCreateOptions;

export type CreateLegacyEmptyWebChatInput = {
  mode: "legacy-empty-web";
  creatorAgentId: string;
  organizationId: string;
  participantAgentIds: readonly string[];
  topic?: string | null;
  description?: string | null;
} & LandingCampaignTrialCreateOptions;

export type CreateLegacyEmptyAgentChatInput = {
  mode: "legacy-empty-agent";
  creatorAgentId: string;
  participantAgentIds: readonly string[];
  topic?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * When set, the chat is created with this idempotency key written to
   * `chats.onboarding_kickoff_key` and the INSERT becomes
   * `ON CONFLICT DO NOTHING`: a concurrent caller that already inserted the
   * row wins, and we return that existing chat instead of a duplicate. Used by
   * the onboarding kickoff endpoint to make chat creation safe to retry.
   */
  onboardingKickoffKey?: string;
} & LandingCampaignTrialCreateOptions;

export type CreateChatInput = CreateTaskChatInput | CreateLegacyEmptyWebChatInput;

type LegacyCreateChatResult = typeof chats.$inferSelect & { participants: (typeof chatMembership.$inferSelect)[] };

export type CreateTaskChatResult = {
  chat: typeof chats.$inferSelect;
  message: typeof messages.$inferSelect;
  participants: (typeof chatMembership.$inferSelect)[];
  recipients: string[];
  /** Message whose notify=true inbox rows should be signaled after commit. */
  notificationMessageId: string | null;
  initialMessageCreated: boolean;
  effectiveSenderId: string;
  initialRecipientAgentIds: string[];
  contextParticipantAgentIds: string[];
  deferredPostCommitEffects?: DeferredSendMessagePostCommitEffects;
};

type AgentIdentityForCreate = {
  id: string;
  name: string | null;
  displayName: string;
  organizationId: string;
  type: string;
  status: string;
  memberStatus: string | null;
  visibility: string;
  managerId: string;
  metadata: Record<string, unknown>;
};

function assertNoLandingCampaignTrialChatParticipants(
  participants: readonly { id: string; displayName?: string | null; metadata: Record<string, unknown> }[],
  options: LandingCampaignTrialCreateOptions,
): void {
  if (options.allowLandingCampaignTrial === true) return;
  const trial = participants.find((agent) => parseLandingCampaignTrialAgentMetadata(agent.metadata));
  if (trial) {
    throw new ForbiddenError(
      `Agent "${trial.displayName ?? trial.id}" is a single-run landing campaign agent. Start it from the landing page flow.`,
    );
  }
}

export async function createChat(db: Database, input: CreateTaskChatInput): Promise<CreateTaskChatResult>;
export async function createChat(db: Database, input: CreateLegacyEmptyWebChatInput): Promise<LegacyCreateChatResult>;
export async function createChat(db: Database, input: CreateLegacyEmptyAgentChatInput): Promise<LegacyCreateChatResult>;
export async function createChat(
  db: Database,
  input: CreateChatInput,
): Promise<CreateTaskChatResult | LegacyCreateChatResult>;
export async function createChat(
  db: Database,
  creatorId: string,
  data: LegacyCreateChat,
): Promise<LegacyCreateChatResult>;
export async function createChat(
  db: Database,
  inputOrCreatorId: CreateChatInput | CreateLegacyEmptyAgentChatInput | string,
  data?: LegacyCreateChat,
): Promise<CreateTaskChatResult | LegacyCreateChatResult> {
  if (typeof inputOrCreatorId === "string") {
    if (!data) {
      throw new BadRequestError("Legacy chat creation requires a body");
    }
    return createLegacyEmptyChat(db, {
      mode: "legacy-empty-agent",
      creatorAgentId: inputOrCreatorId,
      participantAgentIds: data.participantIds,
      topic: data.topic ?? null,
      metadata: data.metadata ?? {},
    });
  }

  switch (inputOrCreatorId.mode) {
    case "task":
      return createTaskChat(db, inputOrCreatorId);
    case "legacy-empty-web":
    case "legacy-empty-agent":
      return createLegacyEmptyChat(db, inputOrCreatorId);
  }
}

async function createLegacyEmptyChat(
  db: Database,
  input: CreateLegacyEmptyWebChatInput | CreateLegacyEmptyAgentChatInput,
): Promise<LegacyCreateChatResult> {
  const chatId = randomUUID();
  const creatorId = input.creatorAgentId;

  // Ensure creator is included in participants
  const allParticipantIds = new Set([creatorId, ...input.participantAgentIds]);

  // Verify all participants exist and belong to the same organization
  const existingAgents = await db
    .select({
      id: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      memberStatus: members.status,
      visibility: agents.visibility,
      managerId: agents.managerId,
      metadata: agents.metadata,
    })
    .from(agents)
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .where(inArray(agents.uuid, [...allParticipantIds]));

  if (existingAgents.length !== allParticipantIds.size) {
    const found = new Set(existingAgents.map((a) => a.id));
    const missing = [...allParticipantIds].filter((id) => !found.has(id));
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }

  const creator = existingAgents.find((a) => a.id === creatorId);
  if (!creator) throw new Error("Unexpected: creator not in existingAgents");
  const orgId = input.mode === "legacy-empty-web" ? input.organizationId : creator.organizationId;
  if (creator.organizationId !== orgId) {
    throw new BadRequestError(`Creator agent "${creatorId}" is not in organization "${orgId}"`);
  }

  const crossOrg = existingAgents.filter((a) => a.organizationId !== orgId);
  if (crossOrg.length > 0) {
    throw new BadRequestError(`Cross-organization chat not allowed: ${crossOrg.map((a) => a.id).join(", ")}`);
  }
  const inactive = existingAgents.filter(
    (a) => a.status !== AGENT_STATUSES.ACTIVE || (a.type === AGENT_TYPES.HUMAN && a.memberStatus !== "active"),
  );
  if (inactive.length > 0) {
    throw new BadRequestError(`Cannot create chat with inactive participant "${inactive[0]?.id}".`);
  }
  assertNoLandingCampaignTrialChatParticipants(existingAgents, input);

  // Owner-exclusive rule for private targets (RFC §4.5, shared-owner
  // reading): a private agent can only be brought into a chat by another
  // agent owned by the same member (i.e. the creator and the target
  // share `managerId`). Self-add (`a.id === creatorId`) is exempt; we
  // filter the creator out of the target set before running the check
  // so a private agent legitimately creating a chat with itself as a
  // participant isn't tripped up.
  //
  // The predicate lives in `participant-invite.ts::rejectedPrivateTargets`
  // alongside the Layer-2 invite gate so the invariant has exactly one
  // source of truth — see that file's comment for the PR #601 → PR #608
  // strict-vs-shared history.
  const targetsForGate = existingAgents
    .filter((a) => a.id !== creatorId)
    .map((a) => ({ uuid: a.id, visibility: a.visibility, managerId: a.managerId }));
  const rejectedTargets = rejectedPrivateTargets({ agentId: creator.id, memberId: creator.managerId }, targetsForGate);
  if (rejectedTargets.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${rejectedTargets.map((t) => t.uuid).join(", ")}`,
    );
  }

  const kickoffKey = input.mode === "legacy-empty-agent" ? (input.onboardingKickoffKey ?? null) : null;

  return db.transaction(async (tx) => {
    const initialDescription = input.description ?? null;
    const values = {
      id: chatId,
      organizationId: orgId,
      type: "group",
      topic: input.topic ?? null,
      description: initialDescription,
      // A description present at creation is "updated now", so the task summary
      // shows real freshness immediately rather than a blank line until the
      // first `chat update` (mirrors `updateChatMetadata`).
      descriptionUpdatedAt: initialDescription != null ? new Date() : null,
      onboardingKickoffKey: kickoffKey,
      metadata: input.mode === "legacy-empty-agent" ? (input.metadata ?? {}) : {},
    };
    // With a kickoff key, the INSERT is idempotent: a concurrent caller that
    // already created this chat wins, our INSERT no-ops, and we return the
    // existing row (with its participants) rather than a duplicate.
    const [chat] = kickoffKey
      ? await tx.insert(chats).values(values).onConflictDoNothing({ target: chats.onboardingKickoffKey }).returning()
      : await tx.insert(chats).values(values).returning();

    if (!chat) {
      if (!kickoffKey) throw new Error("Unexpected: INSERT RETURNING produced no row");
      const [existing] = await tx.select().from(chats).where(eq(chats.onboardingKickoffKey, kickoffKey)).limit(1);
      if (!existing) throw new Error("Unexpected: kickoff-key conflict but no existing chat row");
      const existingParticipants = await tx
        .select()
        .from(chatMembership)
        .where(and(eq(chatMembership.chatId, existing.id), eq(chatMembership.accessMode, "speaker")));
      return { ...existing, participants: existingParticipants };
    }

    // Mode is derived per-row by `addChatParticipants` from
    // `(chats.type, agents.type)` — `services/participant-mode.ts` is the
    // single authoritative encoder. The helper also encloses the watcher
    // recompute (so every active manager whose managed non-human agent is
    // now in the chat lands in the "Watching" set) and the silent-context
    // backfill (no-op here because the chat has no messages yet). Do NOT
    // pass `mode` and do NOT call `recomputeChatWatchers` again.
    await addChatParticipants(
      tx,
      chatId,
      [...allParticipantIds].map((agentId) => ({
        agentId,
        role: agentId === creatorId ? "owner" : "member",
      })),
    );

    const participants = await tx
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

    if (!chat) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return { ...chat, participants };
  });
}

async function createTaskChat(db: Database, input: CreateTaskChatInput): Promise<CreateTaskChatResult> {
  const initialRecipientAgentIds = [...new Set(input.initialRecipientAgentIds)];
  if (initialRecipientAgentIds.length === 0) {
    throw new BadRequestError("Task chat creation requires at least one initial recipient");
  }
  if (input.initialMessage.receiverNames && input.initialMessage.receiverNames.length > 0) {
    throw new BadRequestError(
      "Task chat creation resolves recipients before message send; receiverNames is not accepted",
    );
  }
  if (input.initialMessage.purpose === "agent-final-text") {
    throw new BadRequestError("Task chat initial message cannot be agent-final-text");
  }
  if (input.initialMessage.inReplyTo !== undefined) {
    throw new BadRequestError("Task chat initial message cannot be a reply");
  }
  if (input.initialMessage.metadata?.resolves !== undefined) {
    throw new BadRequestError("Task chat initial message cannot resolve a request from another chat");
  }

  const contextParticipantAgentIds = [...new Set(input.contextParticipantAgentIds)].filter(
    (id) => !initialRecipientAgentIds.includes(id),
  );
  const participantSeed = [
    ...new Set([input.initiatorAgentId, ...initialRecipientAgentIds, ...contextParticipantAgentIds]),
  ];
  const agentRows = await loadAgentsForCreate(db, participantSeed);
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  const initiator = byId.get(input.initiatorAgentId);
  if (!initiator) throw new Error("Unexpected: initiator missing after loadAgentsForCreate");

  let effectiveSenderId = input.initiatorAgentId;
  let effectiveSenderReason: typeof SELF_TARGET_EFFECTIVE_SENDER_REASON | undefined;
  if (initiator.type !== "human" && initialRecipientAgentIds.includes(input.initiatorAgentId)) {
    const managerHumanAgentId = await resolveManagerHumanAgentId(db, initiator.managerId);
    effectiveSenderId = managerHumanAgentId;
    effectiveSenderReason = SELF_TARGET_EFFECTIVE_SENDER_REASON;
    if (!byId.has(managerHumanAgentId)) {
      const managerRows = await loadAgentsForCreate(db, [managerHumanAgentId]);
      for (const row of managerRows) byId.set(row.id, row);
    }
  }

  const allSpeakerIds = [
    ...new Set([effectiveSenderId, input.initiatorAgentId, ...initialRecipientAgentIds, ...contextParticipantAgentIds]),
  ];
  const missingLoaded = allSpeakerIds.filter((id) => !byId.has(id));
  if (missingLoaded.length > 0) {
    const moreRows = await loadAgentsForCreate(db, missingLoaded);
    for (const row of moreRows) byId.set(row.id, row);
  }
  const allSpeakerRows = allSpeakerIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new BadRequestError(`Agents not found: ${id}`);
    return row;
  });
  validateCreateParticipants({
    organizationId: input.organizationId,
    caller: initiator,
    participants: allSpeakerRows,
    requireActive: true,
    allowLandingCampaignTrial: input.allowLandingCampaignTrial,
    allowContextReviewRun: input.allowContextReviewRun,
  });

  const effectiveSender = byId.get(effectiveSenderId);
  if (!effectiveSender) throw new Error("Unexpected: effective sender missing after validation");
  const provenance =
    effectiveSenderReason !== undefined
      ? {
          initiatedByAgentId: input.initiatorAgentId,
          effectiveSenderReason,
        }
      : {};
  const chatMetadata = input.source === "agent" ? { source: "agent" as const, ...provenance } : {};
  const messageMetadata = {
    ...((input.initialMessage.metadata ?? {}) as Record<string, unknown>),
    ...provenance,
    mentions: initialRecipientAgentIds,
  };
  const initialMessage: SendMessage = {
    ...input.initialMessage,
    metadata: messageMetadata,
  };

  preflightMessageSendIntent({
    chatId: "new-task-chat-preflight",
    senderId: effectiveSenderId,
    senderType: effectiveSender.type,
    data: initialMessage,
    options: {
      normalizeMentionsInContent: input.source === "agent",
      allowContextReviewRun: input.allowContextReviewRun,
    },
    participants: allSpeakerRows.map(toSendIntentParticipant),
  });

  const chatId = randomUUID();
  const kickoffKey = input.onboardingKickoffKey ?? null;
  if (!kickoffKey && input.beforeInitialMessage) {
    throw new Error("Task chat beforeInitialMessage requires an onboardingKickoffKey");
  }
  if (!kickoffKey && input.beforeTaskResult) {
    throw new Error("Task chat beforeTaskResult requires an onboardingKickoffKey");
  }
  if (!kickoffKey && input.onTaskReuse) {
    throw new Error("Task chat onTaskReuse requires an onboardingKickoffKey");
  }
  if (kickoffKey) {
    const result = await db.transaction(async (tx) => {
      if (input.beforeTaskResult) await input.beforeTaskResult(tx as unknown as Database);
      const initialDescription = input.description && input.description.length > 0 ? input.description : null;
      const values = {
        id: chatId,
        organizationId: input.organizationId,
        type: "group",
        topic: input.topic && input.topic.length > 0 ? input.topic : null,
        description: initialDescription,
        descriptionUpdatedAt: initialDescription != null ? new Date() : null,
        onboardingKickoffKey: kickoffKey,
        metadata: chatMetadata,
      };
      const [inserted] = await tx
        .insert(chats)
        .values(values)
        .onConflictDoNothing({ target: chats.onboardingKickoffKey })
        .returning();

      const activeChat = inserted
        ? inserted
        : (await tx.select().from(chats).where(eq(chats.onboardingKickoffKey, kickoffKey)).for("update").limit(1))[0];
      if (!activeChat) throw new Error("Unexpected: kickoff-key conflict but no existing chat row");

      if (inserted) {
        await addChatParticipants(
          tx,
          activeChat.id,
          allSpeakerIds.map((agentId) => ({
            agentId,
            role: agentId === effectiveSenderId ? ("owner" as const) : ("member" as const),
          })),
        );
      }

      const [existingMessage] = await tx
        .select()
        .from(messages)
        .where(eq(messages.chatId, activeChat.id))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(1);
      if (!inserted && !existingMessage) {
        await addChatParticipants(
          tx,
          activeChat.id,
          allSpeakerIds.map((agentId) => ({
            agentId,
            role: agentId === effectiveSenderId ? ("owner" as const) : ("member" as const),
          })),
          { onConflictDoNothing: true },
        );
      }

      if (existingMessage) {
        const reuseActivity = input.onTaskReuse
          ? await input.onTaskReuse(tx as unknown as Database, {
              chat: activeChat,
              openingMessage: existingMessage,
            })
          : null;
        const participants = await tx
          .select()
          .from(chatMembership)
          .where(and(eq(chatMembership.chatId, activeChat.id), eq(chatMembership.accessMode, "speaker")));
        return {
          chat: activeChat,
          message: existingMessage,
          participants,
          recipients: reuseActivity?.recipients ?? ([] as string[]),
          notificationMessageId: reuseActivity?.message.id ?? null,
          initialMessageCreated: false,
          postCommitEffects: reuseActivity?.deferredPostCommitEffects ?? null,
        };
      }

      if (input.beforeInitialMessage) await input.beforeInitialMessage();
      const participants = await tx
        .select()
        .from(chatMembership)
        .where(and(eq(chatMembership.chatId, activeChat.id), eq(chatMembership.accessMode, "speaker")));
      invalidateChatAudience(activeChat.id);
      const sent = await sendMessage(tx as unknown as Database, activeChat.id, effectiveSenderId, initialMessage, {
        deferPostCommitEffects: true,
        normalizeMentionsInContent: input.source === "agent",
        allowContextReviewRun: input.allowContextReviewRun,
      });
      if (!sent.deferredPostCommitEffects) {
        throw new Error("Keyed task-chat bootstrap did not return deferred post-commit effects");
      }
      return {
        chat: activeChat,
        message: sent.message,
        participants,
        recipients: sent.recipients,
        notificationMessageId: sent.message.id,
        initialMessageCreated: true,
        postCommitEffects: sent.deferredPostCommitEffects,
      };
    });
    if (result.postCommitEffects && !input.deferPostCommitEffects) {
      await runDeferredSendMessagePostCommitEffects(db, result.postCommitEffects);
    }
    invalidateChatAudience(result.chat.id);
    const { postCommitEffects: _postCommitEffects, ...taskResult } = result;
    return {
      ...taskResult,
      effectiveSenderId,
      initialRecipientAgentIds,
      contextParticipantAgentIds,
      ...(input.deferPostCommitEffects && result.postCommitEffects
        ? { deferredPostCommitEffects: result.postCommitEffects }
        : {}),
    };
  }

  const chat = await db.transaction(async (tx) => {
    const initialDescription = input.description && input.description.length > 0 ? input.description : null;
    const [inserted] = await tx
      .insert(chats)
      .values({
        id: chatId,
        organizationId: input.organizationId,
        type: "group",
        topic: input.topic && input.topic.length > 0 ? input.topic : null,
        description: initialDescription,
        // Stamp freshness so a task chat created with a description shows a
        // real "X ago" line immediately (mirrors `updateChatMetadata` for later
        // edits).
        descriptionUpdatedAt: initialDescription != null ? new Date() : null,
        metadata: chatMetadata,
      })
      .returning();
    if (!inserted) throw new Error("Unexpected: INSERT RETURNING produced no row");
    await addChatParticipants(
      tx,
      chatId,
      allSpeakerIds.map((agentId) => ({
        agentId,
        role: agentId === effectiveSenderId ? ("owner" as const) : ("member" as const),
      })),
    );
    return inserted;
  });
  invalidateChatAudience(chatId);

  const { message, recipients } = await sendMessage(db, chatId, effectiveSenderId, initialMessage, {
    normalizeMentionsInContent: input.source === "agent",
    allowContextReviewRun: input.allowContextReviewRun,
  });
  const participants = await db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

  return {
    chat,
    message,
    participants,
    recipients,
    notificationMessageId: message.id,
    initialMessageCreated: true,
    effectiveSenderId,
    initialRecipientAgentIds,
    contextParticipantAgentIds,
  };
}

async function loadAgentsForCreate(db: Database, agentIds: readonly string[]): Promise<AgentIdentityForCreate[]> {
  const distinct = [...new Set(agentIds)];
  if (distinct.length === 0) return [];
  const rows = await db
    .select({
      id: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      memberStatus: members.status,
      visibility: agents.visibility,
      managerId: agents.managerId,
      metadata: agents.metadata,
    })
    .from(agents)
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .where(inArray(agents.uuid, distinct));
  if (rows.length !== distinct.length) {
    const found = new Set(rows.map((a) => a.id));
    const missing = distinct.filter((id) => !found.has(id));
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }
  return rows;
}

export async function resolveAgentIdsByNameInOrg(
  db: Database,
  organizationId: string,
  names: readonly string[],
): Promise<string[]> {
  const distinct = [...new Set(names)];
  if (distinct.length === 0) return [];
  const rows = await db
    .select({ uuid: agents.uuid, name: agents.name })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), inArray(agents.name, distinct)));
  const byName = new Map(rows.map((r) => [r.name, r.uuid]));
  const missing = distinct.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new BadRequestError(`Agents not found by name: ${missing.join(", ")}`);
  }
  return distinct.map((name) => {
    const id = byName.get(name);
    if (!id) throw new Error("Unexpected: missing name after validation");
    return id;
  });
}

async function resolveManagerHumanAgentId(db: Database, memberId: string): Promise<string> {
  const [row] = await db.select({ agentId: members.agentId }).from(members).where(eq(members.id, memberId)).limit(1);
  if (!row) {
    throw new BadRequestError(`Manager member "${memberId}" not found for self-target chat creation`);
  }
  return row.agentId;
}

function validateCreateParticipants(input: {
  organizationId: string;
  caller: AgentIdentityForCreate;
  participants: readonly AgentIdentityForCreate[];
  requireActive: boolean;
  allowLandingCampaignTrial?: boolean;
  allowContextReviewRun?: boolean;
}): void {
  const crossOrg = input.participants.filter((a) => a.organizationId !== input.organizationId);
  if (crossOrg.length > 0) {
    throw new BadRequestError(`Cross-organization chat not allowed: ${crossOrg.map((a) => a.id).join(", ")}`);
  }
  if (input.caller.organizationId !== input.organizationId) {
    throw new BadRequestError(`Creator agent "${input.caller.id}" is not in organization "${input.organizationId}"`);
  }
  if (input.requireActive) {
    const inactive = input.participants.filter(
      (a) => a.status !== AGENT_STATUSES.ACTIVE || (a.type === AGENT_TYPES.HUMAN && a.memberStatus !== "active"),
    );
    if (inactive.length > 0) {
      const first = inactive[0];
      if (!first) throw new Error("Unexpected: inactive participant list is empty");
      const status = first.type === AGENT_TYPES.HUMAN && first.memberStatus !== "active" ? "removed" : first.status;
      throw new BadRequestError(
        `Cannot create task chat with inactive participant "${first.displayName ?? first.id}" (${status}).`,
      );
    }
  }
  assertNoLandingCampaignTrialChatParticipants(input.participants, {
    allowLandingCampaignTrial: input.allowLandingCampaignTrial,
  });
  const rejectedTargets = rejectedPrivateTargets(
    { agentId: input.caller.id, memberId: input.caller.managerId },
    input.participants
      .filter((a) => a.id !== input.caller.id)
      .map((a) => ({ uuid: a.id, visibility: a.visibility, managerId: a.managerId })),
  );
  if (rejectedTargets.length > 0 && !input.allowContextReviewRun) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${rejectedTargets.map((t) => t.uuid).join(", ")}`,
    );
  }
}

function toSendIntentParticipant(row: AgentIdentityForCreate): SendIntentParticipant {
  return {
    agentId: row.id,
    name: row.name,
    displayName: row.displayName,
    status: row.status,
    type: row.type,
  };
}

export async function getChat(db: Database, chatId: string) {
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  return chat;
}

/**
 * Apply a `topic` / `description` patch to a chat and return the updated row.
 *
 * Freshness: a *real* `description` change — the value actually differs, tested
 * with SQL `IS DISTINCT FROM` so a no-op re-write of identical text does not
 * count — stamps `description_updated_at = now`. A topic-only patch, or a
 * description patch that does not change the value, leaves that column
 * untouched; the whole-row `updated_at` always advances. The `descriptionChanged`
 * flag this returns also gates the caller's realtime `chat:updated` notify.
 */
export async function updateChatMetadata(
  db: Database,
  chatId: string,
  patch: { topic?: string | null; description?: string | null },
): Promise<{ chat: typeof chats.$inferSelect; descriptionChanged: boolean }> {
  const now = new Date();
  let descriptionChanged = false;
  const set: {
    topic?: string | null;
    description?: string | null;
    descriptionUpdatedAt?: Date;
    activityAt?: SQL;
    updatedAt: Date;
  } = { updatedAt: now };
  if (patch.topic !== undefined) {
    set.topic = patch.topic && patch.topic.length > 0 ? patch.topic : null;
  }
  if (patch.description !== undefined) {
    const nextDescription = patch.description && patch.description.length > 0 ? patch.description : null;
    set.description = nextDescription;
    // Detect a real change (null-safe) to gate BOTH the freshness stamp and the
    // realtime `chat:updated` notify the caller fires. A no-op re-write of
    // identical text — or a topic-only edit routed through here — leaves the
    // "X ago · who" line and the notify untouched. The read-then-write window is
    // acceptable: chat descriptions are low-frequency, single-maintainer writes.
    const [current] = await db
      .select({ description: chats.description })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    descriptionChanged = (current?.description ?? null) !== nextDescription;
    if (descriptionChanged) {
      set.descriptionUpdatedAt = now;
      // A genuine description change is real work (an agent updating task
      // state), so it floats the chat in the recency-sorted conversation list.
      // Monotonic via GREATEST so an out-of-order commit can't move it back.
      set.activityAt = sql`GREATEST(${chats.activityAt}, ${now.toISOString()}::timestamptz)`;
    }
  }
  const [updated] = await db.update(chats).set(set).where(eq(chats.id, chatId)).returning();
  if (!updated) throw new Error(`Unexpected: chat "${chatId}" missing after update`);
  return { chat: updated, descriptionChanged };
}

/**
 * Read a chat row + speaker participants + server-resolved display
 * metadata (`title`, `firstMessagePreview`) so the agent route can return
 * a payload that matches the wire `chatDetailSchema` contract.
 *
 * `selfAgentId` only affects the participant-join fallback in
 * `resolveChatTitle` (e.g. `"alice, bob"` excluding self when topic + first
 * message are both empty). Callers that don't have a self agent (admin
 * paths) can pass `null` — the fallback degrades to "all displayNames".
 */
export async function getChatDetail(db: Database, chatId: string, selfAgentId: string | null = null) {
  const chat = await getChat(db, chatId);
  // Participants JOIN `agents` so each row carries `name / displayName /
  // type` — needed by the wire chatDetailSchema (PR #402 identity-
  // rendering fix) and by `resolveChatTitle`'s participant-join fallback
  // (PR #393 v1.7 server-resolved title). Identity rendering inside a
  // chat is membership-derived; we do NOT apply `agentVisibilityCondition`
  // here — see `docs/agent-space-and-mention-visibility-design.zh-CN.md`
  // §4.3.3.
  // v2: chat_membership.mode is decision-inert; the wire `mode` field is
  // populated below from the WIRE_RECIPIENT_MODE constant (mirrors the
  // strategy in services/message-dispatcher.ts), so we no longer SELECT
  // the column. Drop together with the wire field in v3 — see
  // proposals/hub-chat-message-v2-simplify-mode.20260520.md §七.
  const participantRows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
      joinedAt: chatMembership.joinedAt,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

  // Compute server-resolved `title` + `firstMessagePreview` so the agent
  // route returns a payload that matches the wire contract. Without this,
  // the client's chat-context injection cannot render a chat label when
  // the creator never set an explicit topic — see PR #393 dogfood report.
  const [firstMessageRow] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.createdAt, messages.id)
    .limit(1);
  const firstMessagePreview = firstMessageRow ? extractSummary(firstMessageRow.content) : null;
  const title = resolveChatTitle(chat.topic, firstMessagePreview, participantRows, selfAgentId ?? "");

  // Preserve the resolved name / displayName / type / avatar fields on
  // the wire (PR #402 identity-rendering contract; avatar fields added
  // so the chat-detail surface renders manager-configured hue + image
  // — see `meChatParticipantSchema` for the matching field on the rail).
  const participants = participantRows.map((p) => ({
    chatId,
    agentId: p.agentId,
    role: p.role,
    // v2: wire `mode` is reserved for v3 cleanup; write the constant
    // `WIRE_RECIPIENT_MODE` so existing clients that still parse the field
    // see a stable value. No consumer reads this today.
    mode: WIRE_RECIPIENT_MODE,
    joinedAt: p.joinedAt,
    name: p.name,
    displayName: p.displayName,
    type: p.type,
    avatarColorToken: p.avatarColorToken ?? null,
    avatarImageUrl: resolveAvatarImageUrl({
      uuid: p.agentId,
      type: p.type,
      avatarImageUpdatedAt: p.avatarImageUpdatedAt,
      userAvatarUrl: p.userAvatarUrl,
    }),
  }));

  // Match the chatDetailSchema wire contract — the chat-first workspace
  // reads this field instead of round-tripping `/orgs/:orgId/chats` just to
  // distinguish speaker vs watcher view. Agent-SDK callers always reach
  // this code with their own uuid as `selfAgentId`, and the SDK only sees
  // chats it is a speaker in, so the lookup is cheap and almost always
  // resolves to `"participant"`; the admin / supervisor `null` shape still
  // matters for the alternate route (`api/chats.ts`).
  const viewerMembershipKind = await resolveViewerMembershipKind(db, chatId, selfAgentId);

  return { ...chat, participants, title, firstMessagePreview, viewerMembershipKind };
}

/**
 * Runtime active-set projection for one agent and the human user operating the
 * current client. This is intentionally smaller than "all chats where the
 * agent is a speaker": archived/deleted rows are not part of the user's active
 * working set, so clean idle local sessions for those chats do not need
 * periodic runtime projection.
 */
export async function listActiveRuntimeChatIds(
  db: Database,
  agentId: string,
  humanAgentId: string,
  organizationId: string,
): Promise<string[]> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    SELECT DISTINCT agent_membership.chat_id
      FROM ${chatMembership} AS agent_membership
      JOIN ${chats}
        ON ${chats.id} = agent_membership.chat_id
      JOIN ${chatMembership} AS viewer_membership
        ON viewer_membership.chat_id = agent_membership.chat_id
       AND viewer_membership.agent_id = ${humanAgentId}
      LEFT JOIN ${chatUserState}
        ON ${chatUserState.chatId} = agent_membership.chat_id
       AND ${chatUserState.agentId} = ${humanAgentId}
     WHERE agent_membership.agent_id = ${agentId}
       AND agent_membership.access_mode = 'speaker'
       AND ${chats.organizationId} = ${organizationId}
       AND COALESCE(${chatUserState.engagementStatus}, ${CHAT_ENGAGEMENT_STATUSES.ACTIVE}) = ${CHAT_ENGAGEMENT_STATUSES.ACTIVE}
     ORDER BY agent_membership.chat_id ASC
  `);
  return rows.map((row) => row.chat_id);
}

async function resolveViewerMembershipKind(
  db: Database,
  chatId: string,
  viewerAgentId: string | null,
): Promise<"participant" | "watching" | null> {
  if (!viewerAgentId) return null;
  const [row] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, viewerAgentId)))
    .limit(1);
  if (!row) return null;
  return row.accessMode === "speaker" ? "participant" : "watching";
}

export async function listChats(db: Database, agentId: string, limit: number, cursor?: string) {
  // Find all chat IDs where agent is a speaker (watcher rows excluded
  // by access_mode filter — admin agent-scoped chats list shows only
  // chats the agent actually speaks in, matching pre-refactor behaviour).
  const participantRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(eq(chatMembership.agentId, agentId), eq(chatMembership.accessMode, "speaker")));

  const chatIds = participantRows.map((r) => r.chatId);
  if (chatIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const where = cursor
    ? and(inArray(chats.id, chatIds), lt(chats.updatedAt, new Date(cursor)))
    : inArray(chats.id, chatIds);

  const query = db
    .select()
    .from(chats)
    .where(where)
    .orderBy(desc(chats.updatedAt))
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.updatedAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * List participants of a chat with their agent names — used by the client
 * runtime to resolve `@<name>` mentions against the authoritative participant
 * set (see proposals/hub-agent-messaging-reply-and-mentions §4).
 */
export async function listChatParticipantsWithNames(db: Database, chatId: string) {
  // v2: chat_membership.mode is decision-inert; we no longer SELECT it. The
  // route layer projects the wire `mode` field from the WIRE_RECIPIENT_MODE
  // constant — see api/agent/chats.ts. Drop together with the wire field
  // in v3 (proposals/hub-chat-message-v2-simplify-mode.20260520.md §七).
  const rows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
      joinedAt: chatMembership.joinedAt,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
  return rows.map((r) => ({
    agentId: r.agentId,
    role: r.role,
    joinedAt: r.joinedAt,
    name: r.name,
    displayName: r.displayName,
    type: r.type,
    avatarColorToken: r.avatarColorToken,
    avatarImageUrl: resolveAvatarImageUrl({
      uuid: r.agentId,
      type: r.type,
      avatarImageUpdatedAt: r.avatarImageUpdatedAt,
      userAvatarUrl: r.userAvatarUrl,
    }),
  }));
}

export async function assertParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  const [row] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError("Not a participant of this chat");
  }
}

/**
 * Assert the agent counts as the chat's **owner** for metadata writes
 * (topic / description). Topic and description are chat-level
 * self-description that the owning side maintains, so the agent-scope
 * PATCH route gates on ownership rather than mere participation.
 *
 * Two ways to qualify:
 *
 *  1. The caller's own membership row carries `role == "owner"` — the
 *     agent that created the chat.
 *  2. **Delegate relaxation:** the chat has no *agent-type owner who is
 *     still a speaker*, and the caller is an agent-type speaker. This
 *     covers the common creation paths for work chats — Web console
 *     `createMeChat` and GitHub-minted entity chats both write the
 *     *human* agent as owner and the worker/delegate agent as a member —
 *     and the lifecycle holes around them: the human owner leaving the
 *     chat (their row is downgraded to watcher or deleted by
 *     `leaveAsParticipant`) and an agent owner being removed from its
 *     own chat. In all of these the worker agents act on the owner's
 *     behalf, so for chat self-description they count as the owner;
 *     without this, such chats would have no practical description
 *     writer at all — Web is read-only for description by design.
 *
 * A non-owner agent speaker in an agent-created chat whose creator still
 * speaks — and any non-participant — is refused. This is the agent route
 * only; the human/web route stays participation-gated so a managing
 * human can still rename from the console.
 */
export async function assertOwner(db: Database, chatId: string, agentId: string): Promise<void> {
  // All membership rows (not just speakers): the owner row must be found
  // even when the owner has been downgraded to a watcher, while the
  // caller itself is required to be a speaker.
  const rows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
      accessMode: chatMembership.accessMode,
      type: agents.type,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(eq(chatMembership.chatId, chatId));

  const caller = rows.find((r) => r.agentId === agentId && r.accessMode === "speaker");
  if (caller) {
    if (caller.role === "owner") return;
    const agentOwnerStillSpeaks = rows.some(
      (r) => r.role === "owner" && r.type === "agent" && r.accessMode === "speaker",
    );
    if (!agentOwnerStillSpeaks && caller.type === "agent") return;
  }
  throw new ForbiddenError(
    "Only the chat owner can change a chat's topic or description (worker agents count as the owner when no agent owner is present)",
  );
}

/**
 * Non-throwing membership check. Used by callers that need a boolean
 * "is this agent a speaker of this chat?" answer without raising.
 */
export async function isParticipant(db: Database, chatId: string, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Idempotent "ensure this agent is a speaker of this chat" admit.
 *

 * **Caller-responsibility contract — read before using.** This helper does
 * NO authorisation. It is a Layer-1.5 wrapper for `applyMembershipWrite`
 * whose only job is the short-circuit "already a speaker → return without
 * opening a tx". Use it only when the caller has already verified that the
 * given agent has a legitimate reason to be in the chat. The legitimate
 * caller today is:
 *
 *   1. `api/chats.ts` HTTP message routes — the `scope` middleware has
 *      already gated the request through `requireChatAccess` before reaching
 *      the handler that calls this.
 *
 * Do NOT call this from new code paths to "lightly join" an agent — for
 * speaker-invokes-invite use `inviteParticipantsToChat`; for manager
 * self-join use `joinAsParticipant`. Adding a new legitimate caller? Append
 * it to the list above and document the external authorisation step in your
 * PR — reviewers should see it.
 *
 * Behaviour:
 *   - If already a speaker → 1-SELECT short-circuit, no tx opened. This is
 *     the hot path for the IM bridge (every inbound message hits this).
 *   - Otherwise → `applyMembershipWrite`, which encloses backfill, watcher
 *     recompute, and post-commit audience invalidation.
 */
export async function ensureParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  // Short-circuit if already a speaker. Read outside the tx — if a race
  // adds this agent concurrently, the UPSERT inside `applyMembershipWrite`
  // is the authoritative dedupe.
  const [existing] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)))
    .limit(1);
  if (existing?.accessMode === "speaker") return;

  await applyMembershipWrite(db, chatId, [{ agentId }], { upgradeWatcherToSpeaker: true });
}

/**
 * Agent-JWT entrypoint: `POST /agent/.../chats/:id/participants`.
 *
 * Thin shell over `inviteParticipantsToChat`:
 *   1. Resolve the wire target (by uuid OR by name) to a uuid — name lookup
 *      is the only Layer-3 surface specific to this entrypoint.
 *   2. Delegate to the invite service with `errorOnAlreadySpeaker: true`
 *      (agent-SDK contract: already-in is a 409, not a silent skip).
 *   3. Return the resulting speaker list (the wire shape this entrypoint
 *      has always returned).
 */
export async function addParticipant(db: Database, chatId: string, requesterId: string, data: AddParticipant) {
  // Resolve the wire target. Name lookup is scoped to the chat's
  // organization so an agent in another org can never be pulled in by name
  // collision. Resolving in the shell (vs. inside the invite service) keeps
  // the Layer-2 contract uniform on uuid inputs.
  const chat = await getChat(db, chatId);
  const targetSelector = data.agentId
    ? eq(agents.uuid, data.agentId)
    : and(eq(agents.organizationId, chat.organizationId), eq(agents.name, data.agentName ?? ""));
  const [targetAgent] = await db.select({ id: agents.uuid }).from(agents).where(targetSelector).limit(1);
  if (!targetAgent) {
    const ref = data.agentId ?? data.agentName ?? "(unknown)";
    throw new NotFoundError(`Participant "${ref}" not found`);
  }

  await inviteParticipantsToChat(db, {
    chatId,
    callerAgentId: requesterId,
    targetAgentIds: [targetAgent.id],
    errorOnAlreadySpeaker: true,
  });

  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}

export async function removeParticipant(db: Database, chatId: string, requesterId: string, targetAgentId: string) {
  const chat = await getChat(db, chatId);
  if (parseLandingCampaignTrialChatMetadata(chat.metadata)) {
    throw new ForbiddenError("Landing campaign trial chats are managed by First Tree.");
  }

  // Verify requester is a participant
  await assertParticipant(db, chatId, requesterId);

  // Cannot remove self (use leave instead, if implemented)
  if (requesterId === targetAgentId) {
    throw new BadRequestError("Cannot remove yourself from a chat");
  }

  // Only target the speaker row — leaving any watcher row to be handled
  // by `recomputeChatWatchers` below (it will be dropped if its anchor
  // condition no longer holds, or kept otherwise).
  const [removed] = await db
    .delete(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, targetAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .returning();

  if (!removed) {
    throw new NotFoundError(`Agent "${targetAgentId}" is not a participant of this chat`);
  }
  // Reconcile watchers: a manager who was previously anchored to the
  // removed agent may need their watcher row dropped (if no other
  // managed agent remains in chat) or re-created (if the removed agent
  // was a speaker but their manager is now eligible to watch).
  await recomputeChatWatchers(db, chatId);
  invalidateChatAudience(chatId);

  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}

/**
 * List chats visible to a member, grouped by agent.
 * A member sees chats where:
 *   1. Their human agent is a participant, OR
 *   2. Any agent they manage (managerId = memberId) is a participant (supervision)
 */
// TODO: consolidate the three sequential queries (managedAgents, participations, chatRows)
// into a single JOIN query for better performance at scale
export async function listChatsForMember(db: Database, memberId: string, humanAgentId: string) {
  // Find all agent UUIDs this member can see chats for:
  // their own human agent + all agents they manage
  const managedAgents = await db
    .select({ uuid: agents.uuid, name: agents.name, type: agents.type, displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.managerId, memberId));

  // Ensure human agent is included (it should be, but be safe)
  // displayName is non-null post-Phase 2 (migration 0024 enforces it).
  const agentMap = new Map<string, { uuid: string; name: string | null; type: string; displayName: string }>();
  for (const a of managedAgents) {
    agentMap.set(a.uuid, a);
  }
  if (!agentMap.has(humanAgentId)) {
    const [ha] = await db
      .select({ uuid: agents.uuid, name: agents.name, type: agents.type, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, humanAgentId))
      .limit(1);
    if (ha) agentMap.set(ha.uuid, ha);
  }

  const agentIds = [...agentMap.keys()];
  if (agentIds.length === 0) return [];

  // Find all chat participations (speaker rows) for these agents.
  // Watcher rows are intentionally excluded — this admin endpoint
  // surfaces "who is actively in the chat", not "who is observing".
  const participations = await db
    .select({
      chatId: chatMembership.chatId,
      agentId: chatMembership.agentId,
      role: chatMembership.role,
    })
    .from(chatMembership)
    .where(and(inArray(chatMembership.agentId, agentIds), eq(chatMembership.accessMode, "speaker")));

  if (participations.length === 0) return [];

  // Collect unique chat IDs and build agent → chatIds mapping
  const chatIds = [...new Set(participations.map((p) => p.chatId))];
  const agentChatMap = new Map<string, string[]>();
  for (const p of participations) {
    const list = agentChatMap.get(p.agentId) ?? [];
    list.push(p.chatId);
    agentChatMap.set(p.agentId, list);
  }

  // Fetch chat details
  const chatRows = await db
    .select({
      id: chats.id,
      type: chats.type,
      topic: chats.topic,
      metadata: chats.metadata,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      participantCount: sql<number>`(SELECT count(*)::int FROM chat_membership WHERE chat_id = ${chats.id} AND access_mode = 'speaker')`,
    })
    .from(chats)
    .where(inArray(chats.id, chatIds))
    .orderBy(desc(chats.updatedAt));

  const chatMap = new Map(chatRows.map((c) => [c.id, c]));

  // Determine which chats the member's human agent is actually a participant in (vs supervise-only)
  const humanParticipantChatIds = new Set(
    participations.filter((p) => p.agentId === humanAgentId).map((p) => p.chatId),
  );

  // Build grouped result: per agent, list of chats
  const result: Array<{
    agent: { uuid: string; name: string | null; type: string; displayName: string };
    chats: Array<{
      id: string;
      type: string | null;
      topic: string | null;
      participantCount: number;
      isSupervisionOnly: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  }> = [];

  for (const [agentId, agentChatIds] of agentChatMap) {
    const agentInfo = agentMap.get(agentId);
    if (!agentInfo) continue;

    const agentChats = agentChatIds
      .map((chatId) => {
        const chat = chatMap.get(chatId);
        if (!chat) return null;
        // A chat is supervision-only if the member's human agent is NOT a participant
        // AND the chat is visible only because a managed agent is in it
        const isSupervisionOnly = agentId !== humanAgentId && !humanParticipantChatIds.has(chatId);
        return {
          id: chat.id,
          type: chat.type,
          topic: chat.topic,
          participantCount: chat.participantCount,
          isSupervisionOnly,
          createdAt: chat.createdAt.toISOString(),
          updatedAt: chat.updatedAt.toISOString(),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (agentChats.length > 0) {
      result.push({ agent: agentInfo, chats: agentChats });
    }
  }

  return result;
}

/**
 * Manager leaves a chat. Removes their human agent from participants.
 * Only allowed if the human agent is a participant.
 *
 * Delegates the participant→watcher transition to `leaveAsParticipant`
 * so admin-side and `/me/chats/:id/leave` share one canonical path. The
 * earlier "recompute then UPDATE-back state" variant violated the design
 * rule that recompute is only for set rebuild — never on a transition
 * path (review #228 issue #2). The returned participant list is fetched
 * after the tx commits, matching the admin route's existing contract.
 *
 * `leaveAsParticipant` itself runs the post-commit `invalidateChatAudience`,
 * so this shell doesn't need to.
 */
export async function leaveChat(db: Database, chatId: string, humanAgentId: string) {
  await leaveAsParticipant(db, chatId, humanAgentId);
  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}
