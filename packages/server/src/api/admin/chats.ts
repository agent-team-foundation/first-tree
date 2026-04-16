import { paginationQuerySchema, sendMessageSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { chatParticipants, chats } from "../../db/schema/chats.js";
import { inboxEntries } from "../../db/schema/inbox-entries.js";
import { messages } from "../../db/schema/messages.js";
import { BadRequestError } from "../../errors.js";
import { ensureParticipant } from "../../services/chat.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import { resolveDefaultOrgId, resolveOrganization } from "../../services/organization.js";

export async function adminChatRoutes(app: FastifyInstance): Promise<void> {
  /** List chats with participant count */
  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const orgParam = (request.query as Record<string, string>).org;
    let orgId: string;
    if (orgParam) {
      const resolved = await resolveOrganization(app.db, orgParam);
      orgId = resolved.id;
    } else {
      orgId = await resolveDefaultOrgId(app.db);
    }
    const conditions = [eq(chats.organizationId, orgId)];
    if (query.cursor) conditions.push(lt(chats.createdAt, new Date(query.cursor)));
    const where = and(...conditions);

    const rows = await app.db
      .select({
        id: chats.id,
        organizationId: chats.organizationId,
        type: chats.type,
        topic: chats.topic,
        lifecyclePolicy: chats.lifecyclePolicy,
        metadata: chats.metadata,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
        participantCount: sql<number>`(
          SELECT count(*)::int FROM chat_participants WHERE chat_id = ${chats.id}
        )`,
      })
      .from(chats)
      .where(where)
      .orderBy(desc(chats.createdAt))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

    return {
      items: items.map((c) => ({
        id: c.id,
        organizationId: c.organizationId,
        type: c.type,
        topic: c.topic,
        lifecyclePolicy: c.lifecyclePolicy,
        metadata: c.metadata,
        participantCount: c.participantCount,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      nextCursor,
    };
  });

  /** Get chat detail with participants */
  app.get<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const { chatId } = request.params;
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!chat) throw new BadRequestError(`Chat "${chatId}" not found`);

    const participants = await app.db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));

    return {
      ...chat,
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

  /** List messages in a chat with delivery status (for admin audit + read receipts) */
  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    const { chatId } = request.params;
    const query = paginationQuerySchema.parse(request.query);

    const where = query.cursor
      ? and(eq(messages.chatId, chatId), lt(messages.createdAt, new Date(query.cursor)))
      : eq(messages.chatId, chatId);

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
        // Best delivery status across all recipients: acked > delivered > pending
        // Use raw "messages"."id" in subquery — ${messages.id} renders unqualified "id"
        // which PG resolves to inbox_entries.id (bigint) instead of messages.id (text)
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

  /** POST /admin/chats/:chatId/messages — admin sends a message as their linked human agent */
  app.post<{ Params: { chatId: string } }>("/:chatId/messages", async (request, reply) => {
    const { chatId } = request.params;
    const member = request.member;
    if (!member) throw new BadRequestError("Member identity not available");
    const body = sendMessageSchema.parse(request.body);

    // Auto-join the member's agent if not already a participant (workspace chat)
    await ensureParticipant(app.db, chatId, member.agentId);

    // Send message as the member's linked agent, always with source=hub_ui
    const result = await sendMessage(app.db, chatId, member.agentId, {
      ...body,
      source: "hub_ui",
    });

    // Notify recipients via PG NOTIFY
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
}
