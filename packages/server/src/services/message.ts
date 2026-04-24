import { randomUUID } from "node:crypto";
import { extractMentions, type SendMessage, type SendToAgent } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { messageAttrs, withSpan } from "../observability/index.js";
import { findOrCreateDirectChat } from "./chat.js";

export type SendMessageResult = {
  message: typeof messages.$inferSelect;
  /** Inbox IDs that received this message (for notification). */
  recipients: string[];
};

export async function sendMessage(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
): Promise<SendMessageResult> {
  return withSpan(
    "inbox.enqueue",
    messageAttrs({ chatId, senderAgentId: senderId, source: data.source ?? undefined }),
    () => sendMessageInner(db, chatId, senderId, data),
  );
}

async function sendMessageInner(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
): Promise<SendMessageResult> {
  return db.transaction(async (tx) => {
    // 1. Load participants once — we use them both to resolve `@name`
    //    mentions and to fan-out inbox entries.
    const participants = await tx
      .select({
        agentId: chatParticipants.agentId,
        inboxId: agents.inboxId,
        mode: chatParticipants.mode,
        name: agents.name,
      })
      .from(chatParticipants)
      .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
      .where(eq(chatParticipants.chatId, chatId));

    // `replyTo` is a sender-declared routing promise — the sender is saying
    // "when someone replies to this, also deliver a copy to my own inbox in
    // this other chat". Letting a caller put somebody else's inboxId here
    // would let an agent spam a third party's inbox by baiting replies.
    // Enforce that replyToInbox belongs to the sender. replyToChat is not
    // validated against membership intentionally: cross-workspace reply
    // routing would already require the sender to be a participant of the
    // target chat when they *read* that reply, and we don't want to block
    // legit "I'll come back to this later" envelopes.
    if (data.replyToInbox !== undefined && data.replyToInbox !== null) {
      const [senderRow] = await tx
        .select({ inboxId: agents.inboxId })
        .from(agents)
        .where(eq(agents.uuid, senderId))
        .limit(1);
      if (!senderRow || senderRow.inboxId !== data.replyToInbox) {
        throw new BadRequestError("replyToInbox must reference the sender's own inbox");
      }
    }

    // 2. Resolve `@<name>` tokens in the content against the participant
    //    list. Merge the result into `metadata.mentions` so mention_only
    //    participants get fanned out on step 4. Explicit mentions passed
    //    by the caller are preserved verbatim — server resolution is
    //    additive, not authoritative.
    const incomingMeta = (data.metadata ?? {}) as Record<string, unknown>;
    const explicitMentionsRaw = incomingMeta.mentions;
    const explicitMentions = Array.isArray(explicitMentionsRaw)
      ? explicitMentionsRaw.filter((m): m is string => typeof m === "string")
      : [];
    const contentText = typeof data.content === "string" ? data.content : "";
    const resolved = contentText ? extractMentions(contentText, participants) : [];
    const mergedMentions = [...new Set([...explicitMentions, ...resolved])];
    const metadataToStore = mergedMentions.length > 0 ? { ...incomingMeta, mentions: mergedMentions } : incomingMeta;

    // 3. Store the message (with merged metadata).
    const messageId = randomUUID();
    const [msg] = await tx
      .insert(messages)
      .values({
        id: messageId,
        chatId,
        senderId,
        format: data.format,
        content: data.content,
        metadata: metadataToStore,
        replyToInbox: data.replyToInbox ?? null,
        replyToChat: data.replyToChat ?? null,
        inReplyTo: data.inReplyTo ?? null,
        source: data.source ?? null,
      })
      .returning();

    // 4. Fan-out: create inbox entries for participants who should see this
    //    message. Rules:
    //    - sender is always filtered out (no self-delivery).
    //    - `full` mode participants always receive.
    //    - `mention_only` participants receive only when in `mentions`.
    //    See proposals/hub-agent-messaging-reply-and-mentions §3.5. Filtering
    //    server-side means mention_only agents don't wake their session over
    //    irrelevant chatter and the client runtime never has to double-guard.
    const mentionSet = new Set(mergedMentions);
    const entries = participants
      .filter((p) => p.agentId !== senderId)
      .filter((p) => p.mode !== "mention_only" || mentionSet.has(p.agentId))
      .map((p) => ({
        inboxId: p.inboxId,
        messageId,
        chatId,
      }));

    if (entries.length > 0) {
      await tx.insert(inboxEntries).values(entries);
    }

    // Collect recipient inboxIds for notification
    const recipients = entries.map((e) => e.inboxId);

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

        // Include replyTo recipient for notification
        if (!recipients.includes(original.replyToInbox)) {
          recipients.push(original.replyToInbox);
        }
      }
    }

    // 5. Update chat.updatedAt so chat list sorting reflects latest activity
    await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));

    if (!msg) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return { message: msg, recipients };
  });
}

export async function sendToAgent(
  db: Database,
  senderUuid: string,
  targetName: string,
  data: SendToAgent,
): Promise<SendMessageResult> {
  // Verify sender exists
  const [sender] = await db
    .select({ uuid: agents.uuid, organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.uuid, senderUuid))
    .limit(1);

  if (!sender) throw new NotFoundError(`Agent "${senderUuid}" not found`);

  // Resolve target by name within sender's org (natural cross-org isolation)
  const [target] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(
      and(eq(agents.organizationId, sender.organizationId), eq(agents.name, targetName), ne(agents.status, "deleted")),
    )
    .limit(1);

  if (!target) {
    // Agents routinely pick up uuids from `agent chats` / chat participant
    // lists and mistakenly paste them as the send target. Give the hint in
    // the error so the next LLM attempt self-corrects.
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetName);
    const hint = looksLikeUuid
      ? " — `agent send` expects an agent NAME, not a uuid. Run `first-tree-hub agent list` to see available names."
      : "";
    throw new NotFoundError(`Agent "${targetName}" not found${hint}`);
  }

  // Find or create direct chat
  const chat = await findOrCreateDirectChat(db, senderUuid, target.uuid);

  // Send message via existing sendMessage
  return sendMessage(db, chat.id, senderUuid, {
    format: data.format,
    content: data.content,
    metadata: data.metadata,
    replyToInbox: data.replyToInbox,
    replyToChat: data.replyToChat,
    source: data.source,
  });
}

export async function editMessage(
  db: Database,
  chatId: string,
  messageId: string,
  senderId: string,
  data: { format?: string; content?: unknown },
) {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg) throw new NotFoundError(`Message "${messageId}" not found`);
  if (msg.chatId !== chatId) throw new NotFoundError(`Message "${messageId}" not found in this chat`);
  if (msg.senderId !== senderId) throw new ForbiddenError("Only the sender can edit a message");

  const setClause: Record<string, unknown> = {};
  if (data.format !== undefined) setClause.format = data.format;
  if (data.content !== undefined) setClause.content = data.content;

  // Track edit in metadata
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  meta.editedAt = new Date().toISOString();
  setClause.metadata = meta;

  const [updated] = await db.update(messages).set(setClause).where(eq(messages.id, messageId)).returning();
  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return updated;
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
