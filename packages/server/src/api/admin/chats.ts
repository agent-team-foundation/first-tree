import {
  paginationQuerySchema,
  sendMessageSchema,
  updateChatSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { chatParticipants, chats } from "../../db/schema/chats.js";
import { inboxEntries } from "../../db/schema/inbox-entries.js";
import { messages } from "../../db/schema/messages.js";
import { requireAdminRoleHook } from "../../middleware/member-auth.js";
import { requireMember } from "../../middleware/require-identity.js";
import { assertChatAccess, memberScope } from "../../services/access-control.js";
import { ensureParticipant, joinChat, leaveChat, listChatsForMember } from "../../services/chat.js";
import { prepareImageOutbound } from "../../services/image-broadcast.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import { resolveDefaultOrgId, resolveOrganization } from "../../services/organization.js";

export async function adminChatRoutes(app: FastifyInstance): Promise<void> {
  /** List all chats in org (admin-only, for audit). Members should use GET /mine. */
  app.get("/", { preHandler: requireAdminRoleHook() }, async (request) => {
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

  /** Get chat detail with participants (requires participation or supervision) */
  app.get<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    await assertChatAccess(app.db, scope, chatId); // also verifies chat exists

    // assertChatAccess guarantees the chat exists; the select is for full data
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!chat) throw new Error("Unexpected: chat missing after access check");

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

  /** Rename (or clear) a chat's topic. Requires participation or supervision — same gate as reading it. */
  app.patch<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    await assertChatAccess(app.db, scope, chatId);
    const body = updateChatSchema.parse(request.body);
    const nextTopic = body.topic && body.topic.length > 0 ? body.topic : null;

    const [updated] = await app.db
      .update(chats)
      .set({ topic: nextTopic, updatedAt: new Date() })
      .where(eq(chats.id, chatId))
      .returning();
    if (!updated) throw new Error("Unexpected: chat missing after update");
    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  /** List messages in a chat with delivery status (requires participation or supervision) */
  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    await assertChatAccess(app.db, scope, chatId);
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

  /**
   * GET /admin/chats/mine — member-scoped chat listing grouped by agent.
   * Returns only chats where the member's agents participate or are supervised.
   */
  // TODO: add pagination (limit/cursor) — currently returns all results which may be too large
  app.get("/mine", async (request) => {
    const member = requireMember(request);
    return listChatsForMember(app.db, member.memberId, member.agentId);
  });

  /** POST /admin/chats/:chatId/join — manager joins a chat (adds human agent as participant) */
  app.post<{ Params: { chatId: string } }>("/:chatId/join", async (request, reply) => {
    const { chatId } = request.params;
    const member = requireMember(request);

    const participants = await joinChat(app.db, chatId, member.memberId, member.agentId);

    return reply.status(200).send({
      chatId,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  /** POST /admin/chats/:chatId/leave — manager leaves a chat (removes human agent from participants) */
  app.post<{ Params: { chatId: string } }>("/:chatId/leave", async (request, reply) => {
    const { chatId } = request.params;
    const member = requireMember(request);

    const participants = await leaveChat(app.db, chatId, member.agentId);

    return reply.status(200).send({
      chatId,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: p.mode,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  /** POST /admin/chats/:chatId/messages — member sends a message as their linked human agent */
  app.post<{ Params: { chatId: string } }>("/:chatId/messages", async (request, reply) => {
    const { chatId } = request.params;
    const scope = memberScope(request);
    const member = requireMember(request);
    const body = sendMessageSchema.parse(request.body);

    // Verify the member has legitimate access (participant or supervision), then auto-join
    await assertChatAccess(app.db, scope, chatId);
    await ensureParticipant(app.db, chatId, member.agentId);

    // Image messages: push the bytes to participant clients over WS and
    // rewrite `content` to a reference before it reaches the DB. Non-image
    // messages fall through unchanged.
    const prepared = await prepareImageOutbound(app.db, app.notifier, chatId, { ...body, source: "hub_ui" });

    // Send message as the member's linked agent, always with source=hub_ui.
    // `enforceGroupMention` matches the front-end mention picker's send-button
    // gate so requests that bypass the picker (curl / scripts / tampered web)
    // can't slip an unaddressed message into a group. Content is NOT
    // normalised on this path — humans typed exactly what they typed.
    const result = await sendMessage(app.db, chatId, member.agentId, prepared, { enforceGroupMention: true });

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
