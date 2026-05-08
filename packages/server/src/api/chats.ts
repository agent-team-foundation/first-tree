import {
  addMeChatParticipantsSchema,
  paginationQuerySchema,
  sendMessageSchema,
  updateChatSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { assertAllAgentsVisibleInOrg, requireChatAccess } from "../scope/require-resource.js";
import { ensureParticipant, joinChat, leaveChat } from "../services/chat.js";
import { prepareImageOutbound } from "../services/image-broadcast.js";
import {
  addMeChatParticipants,
  joinMeChat,
  leaveMeChat,
  markMeChatRead,
  resolveChatTitle,
} from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { notifyRecipients } from "../services/notifier.js";
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

    const participants = await app.db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chat.id));

    const firstMsgRows = (await app.db.execute<{ content: unknown }>(sql`
      SELECT content FROM messages
       WHERE chat_id = ${chat.id}
       ORDER BY created_at ASC
       LIMIT 1
    `)) as unknown as Array<{ content: unknown }>;
    const firstMessagePreview = firstMsgRows[0] ? extractSummary(firstMsgRows[0].content) : null;

    const participantAgentIds = participants.map((p) => p.agentId);
    const agentRows =
      participantAgentIds.length > 0
        ? await app.db
            .select({ agentId: agents.uuid, displayName: agents.displayName, type: agents.type })
            .from(agents)
            .where(inArray(agents.uuid, participantAgentIds))
        : [];
    const agentMeta = new Map(agentRows.map((a) => [a.agentId, a]));
    const participantsForTitle = participants.map((p) => {
      const meta = agentMeta.get(p.agentId);
      return {
        agentId: p.agentId,
        displayName: meta?.displayName ?? p.agentId,
        type: meta?.type ?? "unknown",
      };
    });
    const title = resolveChatTitle(chat.topic, firstMessagePreview, participantsForTitle, scope.humanAgentId);

    return {
      ...chat,
      title,
      firstMessagePreview,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        joinedAt: p.joinedAt.toISOString(),
      })),
    };
  });

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

  /** POST /chats/:chatId/read — chat-first-workspace read cursor. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/read", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    return markMeChatRead(app.db, request.params.chatId, scope.humanAgentId);
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
