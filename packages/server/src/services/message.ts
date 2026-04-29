import { randomUUID } from "node:crypto";
import {
  extractMentions,
  type SendMessage,
  type SendToAgent,
  scanMentionTokens,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger, messageAttrs, withSpan } from "../observability/index.js";
import { upsertSessionState } from "./activity.js";
import { findOrCreateDirectChat } from "./chat.js";

const log = createLogger("message");

export type SendMessageResult = {
  message: typeof messages.$inferSelect;
  /** Inbox IDs that received this message (for notification). */
  recipients: string[];
};

export type SendMessageOptions = {
  /**
   * When true, reject the send with `BadRequestError` if the chat is a group
   * and no recipient mention can be resolved (neither from `metadata.mentions`
   * nor from a `@<name>` token in the content). Used by both agent and
   * admin/web routes so a group chat message ALWAYS names a receiver — see
   * proposals/group-chat-ux-improvements §3.
   *
   * Direct chats are unaffected (the lone peer is unambiguous). Adapter and
   * webhook paths leave this off so external bridges aren't gated on hub-side
   * naming conventions.
   */
  enforceGroupMention?: boolean;
  /**
   * When true and `data.content` is a string, prepend `@<name>` tokens for
   * any participant in `metadata.mentions` whose name is missing from the
   * content. Used by the agent path so the rendered message stays in sync
   * with the routing decision (e.g. `result-sink` reply enrichment puts the
   * trigger sender in `metadata.mentions` but the agent's text rarely
   * includes the @). Admin/web path leaves this off — the picker has the
   * user write the @ themselves; we don't want server to silently mutate
   * human-typed content.
   */
  normalizeMentionsInContent?: boolean;
};

export async function sendMessage(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  return withSpan(
    "inbox.enqueue",
    messageAttrs({ chatId, senderAgentId: senderId, source: data.source ?? undefined }),
    () => sendMessageInner(db, chatId, senderId, data, options),
  );
}

async function sendMessageInner(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const txResult = await db.transaction(async (tx) => {
    // 1. Load participants, chat type, and sender (inbox + org) in parallel —
    //    all three are needed for fan-out + mention enforcement + post-tx
    //    session activation. Running concurrently keeps the hot send path on
    //    a single round-trip rather than three sequential lookups.
    //    Sender's organizationId is reused for predictive session activation
    //    (chat-internal participants share the same org under multi-tenant).
    const [participants, [chatRow], [senderRow]] = await Promise.all([
      tx
        .select({
          agentId: chatParticipants.agentId,
          inboxId: agents.inboxId,
          mode: chatParticipants.mode,
          name: agents.name,
        })
        .from(chatParticipants)
        .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
        .where(eq(chatParticipants.chatId, chatId)),
      tx.select({ type: chats.type }).from(chats).where(eq(chats.id, chatId)).limit(1),
      tx
        .select({ inboxId: agents.inboxId, organizationId: agents.organizationId })
        .from(agents)
        .where(eq(agents.uuid, senderId))
        .limit(1),
    ]);
    const chatType = chatRow?.type ?? null;
    if (!senderRow) {
      throw new NotFoundError(`Sender agent "${senderId}" not found`);
    }

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
      if (senderRow.inboxId !== data.replyToInbox) {
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

    // 2b. Group-chat receiver enforcement (agent-only). Stop a misuse where an
    //     agent calls `send --chat <id>` against a group without naming who
    //     should pick it up — every mention_only participant would silently
    //     drop the message and the sender would assume delivery.
    //     Uses the chat type pre-fetched in step 1 so this stays cheap.
    if (options.enforceGroupMention && chatType === "group") {
      const recipientMentions = mergedMentions.filter((id) => id !== senderId);
      if (recipientMentions.length === 0) {
        throw new BadRequestError(
          "Sending to a group chat requires an explicit @mention. " +
            "Use `agent send <name>` to message a single agent, or @<name> in the content to address one or more group members.",
        );
      }
    }

    // 2c. Agent-path content normalisation: if the caller declared mentions in
    //     metadata but didn't write the corresponding `@<name>` in the text,
    //     prepend the missing tokens. This keeps the visible message in sync
    //     with the routing decision — most importantly when an agent replies
    //     in a group: the runtime's `result-sink` already adds the trigger
    //     sender to `mentions`, but only the content shows up in the UI.
    //
    //     Driven by its own opt-in flag (separate from enforceGroupMention) so
    //     admin/web and adapter paths can validate without mutating content.
    let outboundContent = data.content;
    if (options.normalizeMentionsInContent && typeof outboundContent === "string") {
      const present = new Set(scanMentionTokens(outboundContent));
      const missingNames: string[] = [];
      for (const id of mergedMentions) {
        if (id === senderId) continue;
        const p = participants.find((q) => q.agentId === id);
        if (!p?.name) continue;
        if (present.has(p.name.toLowerCase())) continue;
        missingNames.push(p.name);
      }
      if (missingNames.length > 0) {
        const prefix = missingNames.map((n) => `@${n}`).join(" ");
        outboundContent = outboundContent.length > 0 ? `${prefix} ${outboundContent}` : prefix;
      }
    }

    // 3. Store the message (with merged metadata + normalised content).
    const messageId = randomUUID();
    const [msg] = await tx
      .insert(messages)
      .values({
        id: messageId,
        chatId,
        senderId,
        format: data.format,
        content: outboundContent,
        metadata: metadataToStore,
        replyToInbox: data.replyToInbox ?? null,
        replyToChat: data.replyToChat ?? null,
        inReplyTo: data.inReplyTo ?? null,
        source: data.source ?? null,
      })
      .returning();

    // 4. Fan-out: create inbox entries for every non-sender participant.
    //    The `notify` flag splits them in two:
    //    - `notify=true`  — wakes the recipient's session (the existing path).
    //    - `notify=false` — silent context row, written so a future active
    //      delivery to the same chat can replay it as preceding history.
    //
    //    Rules:
    //    - sender is always filtered out (no self-delivery).
    //    - `full` mode participants always get notify=true.
    //    - `mention_only` participants get notify=true only when in `mentions`,
    //      otherwise notify=false (silent context).
    //
    //    Replaces the previous "filter mention_only out at fan-out time" rule
    //    so a `mention_only` agent that gets @mentioned later can still see
    //    the chat history it missed — see proposals/group-chat-ux-improvements §1.
    const mentionSet = new Set(mergedMentions);
    // Build a single fan-out structure that carries agentId alongside the
    // inbox row. agentId is needed by the post-tx session-activation step
    // (Step 1b) but is not part of the inbox_entries schema — it's stripped
    // back out at insert time below.
    const fanout = participants
      .filter((p) => p.agentId !== senderId)
      .map((p) => ({
        agentId: p.agentId,
        inboxId: p.inboxId,
        notify: p.mode !== "mention_only" || mentionSet.has(p.agentId),
      }));

    if (fanout.length > 0) {
      await tx
        .insert(inboxEntries)
        .values(fanout.map((f) => ({ inboxId: f.inboxId, messageId, chatId, notify: f.notify })));
    }

    // notify=true entries serve two consumers:
    //   - `recipients` (inboxIds) — feeds the route-layer PG NOTIFY for
    //     wake-up. Silent entries piggy-back on the next active delivery
    //     (see services/inbox.ts pollInbox).
    //   - `recipientAgentIds` — feeds the post-transaction predictive
    //     session-activation block (Step 1b below; M-plan N1-B range).
    const notified = fanout.filter((f) => f.notify);
    const recipients = notified.map((f) => f.inboxId);
    const recipientAgentIds = notified.map((f) => f.agentId);

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
    return {
      message: msg,
      recipients,
      recipientAgentIds,
      organizationId: senderRow.organizationId,
    };
  });

  // Predictive session-state activation: after the main transaction commits,
  // best-effort upsert an `active` agent_chat_sessions row for every notify=true
  // recipient so the Hub UI list refreshes immediately on send (see M-plan
  // §8 R7 / §5 invariant #2 — notifier=undefined keeps NOTIFY scoped to Hub UI,
  // touchPresenceLastSeen=false avoids polluting the client's heartbeat).
  // Failure is logged but never thrown: the message is durable, and the
  // client's later `session:state: active` frame self-heals the row.
  const settled = await Promise.allSettled(
    txResult.recipientAgentIds.map((agentId) =>
      upsertSessionState(db, agentId, chatId, "active", txResult.organizationId, undefined, {
        touchPresenceLastSeen: false,
      }),
    ),
  );
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r?.status === "rejected") {
      log.error(
        { err: r.reason, chatId, agentId: txResult.recipientAgentIds[i] },
        "predictive session activation failed",
      );
    }
  }

  return { message: txResult.message, recipients: txResult.recipients };
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

  // The receiver is explicit (`<name>`); merge them into metadata.mentions so
  // sendMessage's step 2c will prepend `@<name>` to content. One uniform
  // injection path means agent-to-agent and result-sink replies use exactly
  // the same logic — no risk of the two drifting on edge cases.
  const incomingMeta = (data.metadata ?? {}) as Record<string, unknown>;
  const existingMentionsRaw = incomingMeta.mentions;
  const existingMentions = Array.isArray(existingMentionsRaw)
    ? existingMentionsRaw.filter((m): m is string => typeof m === "string")
    : [];
  const mergedMentions = existingMentions.includes(target.uuid) ? existingMentions : [...existingMentions, target.uuid];
  const metadata = { ...incomingMeta, mentions: mergedMentions };

  return sendMessage(
    db,
    chat.id,
    senderUuid,
    {
      format: data.format,
      content: data.content,
      metadata,
      replyToInbox: data.replyToInbox,
      replyToChat: data.replyToChat,
      source: data.source,
    },
    { normalizeMentionsInContent: true },
  );
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
