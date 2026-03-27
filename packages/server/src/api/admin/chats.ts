import { paginationQuerySchema } from "@first-tree-hub/shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { chatParticipants, chats } from "../../db/schema/chats.js";
import { messages } from "../../db/schema/messages.js";
import { BadRequestError } from "../../errors.js";

export async function adminChatRoutes(app: FastifyInstance): Promise<void> {
  /** List chats with participant count */
  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const where = query.cursor ? lt(chats.createdAt, new Date(query.cursor)) : undefined;

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

  /** List messages in a chat (read-only, for admin audit) */
  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    const { chatId } = request.params;
    const query = paginationQuerySchema.parse(request.query);

    const where = query.cursor
      ? and(eq(messages.chatId, chatId), lt(messages.createdAt, new Date(query.cursor)))
      : eq(messages.chatId, chatId);

    const rows = await app.db
      .select()
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
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });
}
