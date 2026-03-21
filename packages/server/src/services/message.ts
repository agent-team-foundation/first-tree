import { randomUUID } from "node:crypto";
import type { SendMessage, SendToAgent } from "@agent-hub/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { NotFoundError } from "../errors.js";
import { findOrCreateDirectChat } from "./chat.js";

export async function sendMessage(db: Database, chatId: string, senderId: string, data: SendMessage) {
  return db.transaction(async (tx) => {
    // 1. Store message
    const messageId = randomUUID();
    const [msg] = await tx
      .insert(messages)
      .values({
        id: messageId,
        chatId,
        senderId,
        format: data.format,
        content: data.content,
        metadata: data.metadata ?? {},
        replyToInbox: data.replyToInbox ?? null,
        replyToChat: data.replyToChat ?? null,
        inReplyTo: data.inReplyTo ?? null,
      })
      .returning();

    // 2. Get all participants' inbox IDs
    const participants = await tx
      .select({
        agentId: chatParticipants.agentId,
        inboxId: agents.inboxId,
      })
      .from(chatParticipants)
      .innerJoin(agents, eq(chatParticipants.agentId, agents.id))
      .where(eq(chatParticipants.chatId, chatId));

    // 3. Fan-out: create inbox entries for all participants (except sender)
    const entries = participants
      .filter((p) => p.agentId !== senderId)
      .map((p) => ({
        inboxId: p.inboxId,
        messageId,
        chatId,
      }));

    if (entries.length > 0) {
      await tx.insert(inboxEntries).values(entries);
    }

    // 4. replyTo routing: if this message replies to another message that has a replyTo,
    //    create an additional inbox entry for the original requester
    if (data.inReplyTo) {
      const [original] = await tx
        .select({
          replyToInbox: messages.replyToInbox,
          replyToChat: messages.replyToChat,
        })
        .from(messages)
        .where(eq(messages.id, data.inReplyTo))
        .limit(1);

      if (original?.replyToInbox && original?.replyToChat) {
        await tx
          .insert(inboxEntries)
          .values({
            inboxId: original.replyToInbox,
            messageId,
            chatId: original.replyToChat,
          })
          .onConflictDoNothing();
      }
    }

    // 5. Update chat.updatedAt so chat list sorting reflects latest activity
    await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));

    if (!msg) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return msg;
  });
}

export async function sendToAgent(db: Database, senderId: string, targetAgentId: string, data: SendToAgent) {
  // Verify target agent exists and is in the same org
  const [sender] = await db
    .select({ id: agents.id, organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.id, senderId))
    .limit(1);

  if (!sender) throw new NotFoundError(`Agent "${senderId}" not found`);

  const [target] = await db
    .select({ id: agents.id, organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.id, targetAgentId))
    .limit(1);

  if (!target) throw new NotFoundError(`Agent "${targetAgentId}" not found`);

  // Find or create direct chat
  const chat = await findOrCreateDirectChat(db, senderId, targetAgentId);

  // Send message via existing sendMessage
  return sendMessage(db, chat.id, senderId, {
    format: data.format,
    content: data.content,
    metadata: data.metadata,
    replyToInbox: data.replyToInbox,
    replyToChat: data.replyToChat,
  });
}

export async function listMessages(db: Database, chatId: string, limit: number, cursor?: string) {
  const where = cursor
    ? and(eq(messages.chatId, chatId), lt(messages.createdAt, new Date(cursor)))
    : eq(messages.chatId, chatId);

  const query = db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}
