import {
  addMeChatParticipantsSchema,
  paginationQuerySchema,
  patchChatEngagementSchema,
  sendMessageSchema,
  submitQuestionAnswerSchema,
  updateChatSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { assertAllAgentsVisibleInOrg, requireChatAccess } from "../scope/require-resource.js";
import { agentAvatarImageUrl } from "../services/agent.js";
import { ensureParticipant, joinChat, leaveChat } from "../services/chat.js";
import { prepareImageOutbound } from "../services/image-broadcast.js";
import {
  addMeChatParticipants,
  getCallerEngagement,
  joinMeChat,
  leaveMeChat,
  markMeChatRead,
  markMeChatUnread,
  resolveChatTitle,
  setChatEngagement,
} from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { notifyRecipients } from "../services/notifier.js";
import { submitAnswer } from "../services/questions.js";
import { extractSummary } from "../services/session.js";

/**
 * Class C — resource-scoped chat routes. Mounted at
 * `/api/v1/chats/:chatId/...`. The chat's `organizationId` locates its
 * org; `requireChatAccess` resolves the caller's membership in that org
 * and gates participation/supervision.
 */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const { chat, scope } = await requireChatAccess(request, app.db);

    // Participants are resolved via INNER JOIN `agents` so each row
    // already carries `name / displayName / type`. The trust boundary
    // for chat-scoped identity is `chat_membership`, not org-level
    // discovery — we deliberately do **not** apply
    // `agentVisibilityCondition` here. See
    // `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.3.3.
    const participants = await app.db
      .select({
        agentId: chatMembership.agentId,
        role: chatMembership.role,
        mode: chatMembership.mode,
        joinedAt: chatMembership.joinedAt,
        name: agents.name,
        displayName: agents.displayName,
        type: agents.type,
        avatarColorToken: agents.avatarColorToken,
        avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      })
      .from(chatMembership)
      .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.accessMode, "speaker")));

    const firstMsgRows = (await app.db.execute<{ content: unknown }>(sql`
      SELECT content FROM messages
       WHERE chat_id = ${chat.id}
       ORDER BY created_at ASC
       LIMIT 1
    `)) as unknown as Array<{ content: unknown }>;
    const firstMessagePreview = firstMsgRows[0] ? extractSummary(firstMsgRows[0].content) : null;

    const participantsForTitle = participants.map((p) => ({
      agentId: p.agentId,
      displayName: p.displayName,
      type: p.type,
      avatarColorToken: p.avatarColorToken ?? null,
      avatarImageUrl: agentAvatarImageUrl(p.agentId, p.avatarImageUpdatedAt ?? null),
    }));
    const title = resolveChatTitle(chat.topic, firstMessagePreview, participantsForTitle, scope.humanAgentId);

    const engagementStatus = await getCallerEngagement(app.db, chat.id, scope.humanAgentId);

    return {
      ...chat,
      title,
      firstMessagePreview,
      engagementStatus,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        name: p.name,
        displayName: p.displayName,
        type: p.type,
        joinedAt: p.joinedAt.toISOString(),
      })),
    };
  });

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/engagement",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const { scope } = await requireChatAccess(request, app.db);
      const body = patchChatEngagementSchema.parse(request.body);
      await setChatEngagement(app.db, request.params.chatId, scope.humanAgentId, body.status);
      return reply.status(200).send({ chatId: request.params.chatId, engagementStatus: body.status });
    },
  );

  app.patch<{ Params: { chatId: string } }>("/:chatId", { config: { otelRecordBody: true } }, async (request) => {
    await requireChatAccess(request, app.db);
    const body = updateChatSchema.parse(request.body);
    const nextTopic = body.topic && body.topic.length > 0 ? body.topic : null;

    const [updated] = await app.db
      .update(chats)
      .set({ topic: nextTopic, updatedAt: new Date() })
      .where(eq(chats.id, request.params.chatId))
      .returning();
    if (!updated) throw new Error("Unexpected: chat missing after update");
    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    await requireChatAccess(request, app.db);
    const query = paginationQuerySchema.parse(request.query);

    const where = query.cursor
      ? and(eq(messages.chatId, request.params.chatId), lt(messages.createdAt, new Date(query.cursor)))
      : eq(messages.chatId, request.params.chatId);

    const rows = await app.db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        format: messages.format,
        content: messages.content,
        metadata: messages.metadata,
        replyToInbox: messages.replyToInbox,
        replyToChat: messages.replyToChat,
        inReplyTo: messages.inReplyTo,
        source: messages.source,
        createdAt: messages.createdAt,
        deliveryStatus: sql<string>`(
          SELECT CASE
            WHEN EXISTS (SELECT 1 FROM ${inboxEntries} ie WHERE ie.message_id = "messages"."id" AND ie.status = 'acked') THEN 'acked'
            WHEN EXISTS (SELECT 1 FROM ${inboxEntries} ie WHERE ie.message_id = "messages"."id" AND ie.status = 'delivered') THEN 'delivered'
            WHEN EXISTS (SELECT 1 FROM ${inboxEntries} ie WHERE ie.message_id = "messages"."id") THEN 'pending'
            ELSE 'sent'
          END
        )`,
      })
      .from(messages)
      .where(where)
      .orderBy(desc(messages.createdAt))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

    return {
      items: items.map((m) => ({
        id: m.id,
        chatId: m.chatId,
        senderId: m.senderId,
        format: m.format,
        content: m.content,
        metadata: m.metadata,
        replyToInbox: m.replyToInbox,
        replyToChat: m.replyToChat,
        inReplyTo: m.inReplyTo,
        source: m.source,
        deliveryStatus: m.deliveryStatus,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/join", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    const participants = await joinChat(app.db, request.params.chatId, scope.memberId, scope.humanAgentId);
    return reply.status(200).send({
      chatId: request.params.chatId,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/leave", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    const participants = await leaveChat(app.db, request.params.chatId, scope.humanAgentId);
    return reply.status(200).send({
      chatId: request.params.chatId,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  /** POST /chats/:chatId/messages — caller speaks as their HUMAN agent in the chat's org. */
  app.post<{ Params: { chatId: string } }>("/:chatId/messages", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    const body = sendMessageSchema.parse(request.body);

    await ensureParticipant(app.db, request.params.chatId, scope.humanAgentId);

    const prepared = await prepareImageOutbound(app.db, app.notifier, request.params.chatId, {
      ...body,
      source: "hub_ui",
    });

    const result = await sendMessage(app.db, request.params.chatId, scope.humanAgentId, prepared, {
      enforceGroupMention: true,
    });

    notifyRecipients(app.notifier, result.recipients, result.message.id);

    return reply.status(201).send({
      id: result.message.id,
      chatId: result.message.chatId,
      senderId: result.message.senderId,
      format: result.message.format,
      content: result.message.content,
      source: result.message.source,
      createdAt: result.message.createdAt.toISOString(),
    });
  });

  /**
   * POST /chats/:chatId/questions/:correlationId/answer — submit an answer
   * to a pending agent-emitted question. Caller speaks as their human agent;
   * the answer is fanned out as a `format=question_answer` message back to
   * the original agent's inbox so the in-flight `canUseTool` callback can
   * resolve. Returns 409 if already answered or superseded.
   */
  app.post<{ Params: { chatId: string; correlationId: string } }>(
    "/:chatId/questions/:correlationId/answer",
    { config: { otelRecordBody: false } },
    async (request, reply) => {
      const { scope } = await requireChatAccess(request, app.db);
      const body = submitQuestionAnswerSchema.parse(request.body);

      await ensureParticipant(app.db, request.params.chatId, scope.humanAgentId);

      const result = await submitAnswer(app.db, app.notifier, {
        correlationId: request.params.correlationId,
        chatId: request.params.chatId,
        submitterAgentId: scope.humanAgentId,
        answers: body.answers,
      });

      return reply.status(201).send({
        correlationId: request.params.correlationId,
        messageId: result.messageId,
      });
    },
  );

  /** POST /chats/:chatId/read — chat-first-workspace read cursor. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/read", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    return markMeChatRead(app.db, request.params.chatId, scope.humanAgentId);
  });

  /** POST /chats/:chatId/unread — manual "mark as unread" affordance. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/unread", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    return markMeChatUnread(app.db, request.params.chatId, scope.humanAgentId);
  });

  /** POST /chats/:chatId/participants — add speaking participants. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/participants", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    const body = addMeChatParticipantsSchema.parse(request.body);
    await assertAllAgentsVisibleInOrg(app.db, scope, body.participantIds);
    await addMeChatParticipants(app.db, request.params.chatId, scope.humanAgentId, scope.organizationId, body);
    return reply.status(204).send();
  });

  /** Watcher → speaking participant. State-carry. */
  app.post<{ Params: { chatId: string } }>("/:chatId/workspace-join", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    await joinMeChat(app.db, request.params.chatId, scope.humanAgentId);
    return reply.status(204).send();
  });

  /** Speaking participant → watcher (or detach). */
  app.post<{ Params: { chatId: string } }>("/:chatId/workspace-leave", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    return leaveMeChat(app.db, request.params.chatId, scope.humanAgentId);
  });
}
