import {
  extractCaption,
  imageBatchRefContentSchema,
  imageRefContentSchema,
  MAX_BATCH_ATTACHMENTS,
  MESSAGE_FORMATS,
  type SendMessage,
  scanMentionTokens,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger, messageAttrs, withSpan } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { upsertSessionState } from "./activity.js";
import { applyAfterFanOut, fireChatMessageKick } from "./chat-projection.js";
import { validateDocumentContext } from "./doc-snapshots.js";

const log = createLogger("message");

// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction clients do not expose a concrete schema type here.
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Metadata keys reserved for trusted-internal write paths. Stripped from
 * untrusted-caller input (any send that doesn't opt in) so an HTTP POST
 * cannot smuggle a UI-trust marker into a regular message — see the
 * `allowSystemSender` field on `SendMessageOptions` for the threat model.
 *
 * Returns the same reference when nothing is stripped, so the common case
 * (no reserved keys present) does not allocate.
 */
function stripUntrustedMetadataKeys(
  meta: Record<string, unknown>,
  options: SendMessageOptions,
): Record<string, unknown> {
  if (options.allowSystemSender || !("systemSender" in meta)) return meta;
  const { systemSender: _drop, ...rest } = meta;
  return rest;
}

/**
 * Fail-closed guard for `format: "file"` writes. `sendMessageSchema.content`
 * is `z.unknown()` (format-agnostic), so without this the message write
 * boundary would persist and fan out malformed, unsupported-MIME, or
 * over-limit image batches — recipients would then either not recognise the
 * batch or fan out unbounded attachment fetches. The only legal `file`
 * content is a single image ref or a 1..MAX_BATCH_ATTACHMENTS batch, both
 * restricted to supported MIME types. Reuses the shared schemas so this guard
 * can't drift from the renderers' contract.
 */
function validateFileContent(content: unknown): void {
  if (imageBatchRefContentSchema.safeParse(content).success) return;
  if (imageRefContentSchema.safeParse(content).success) return;
  throw new BadRequestError(
    `Invalid file message content: expected an image reference ({imageId, mimeType, filename}) or a batch ` +
      `({caption?, attachments[1..${MAX_BATCH_ATTACHMENTS}]}), with MIME one of png/jpeg/gif/webp.`,
  );
}

export type SendMessageResult = {
  message: typeof messages.$inferSelect;
  /** Inbox IDs that received this message (for notification). */
  recipients: string[];
};

export type SendMessagePostCommitPlan = SendMessageResult & {
  recipientAgentIds: string[];
  organizationId: string;
};

export type SendMessageOptions = {
  /**
   * Trusted-internal opt-out from the default explicit-recipient guard.
   *
   * `sendMessage()` enforces explicit-recipient routing **by default**: a send
   * that declares no recipient (no `metadata.mentions`, no `data.receiverNames`,
   * no `addressedToAgentIds`) is rejected with `BadRequestError`. This is the
   * durable contract — the server rejects a no-recipient send regardless of
   * caller (see `system/cloud/chat/messaging.md` "Addressing Is Required To
   * Send"). The two user entry points (web `api/chats.ts`, agent SDK
   * `api/agent/messages.ts`) therefore carry no business flag; they inherit the
   * default.
   *
   * The one other send shape that legitimately carries no recipient bypasses
   * the guard without this option: `data.purpose === "agent-final-text"` — an
   * agent's own final response surfaced for human observers, silent by
   * construction (self-declared via `purposeProfile.skipMentionEnforcement`).
   *
   * This option is the **only** other escape hatch, reserved for trusted
   * server-internal delivery paths whose addressing is owned and validated by
   * the caller and **can legitimately resolve to no live speaker for some
   * events** — today only `github-delivery.deliverNormalizedEvent`, whose card
   * addressing (`addressedToAgentIds` derived from the audience row) may name a
   * delegate that is not a speaker of the bound chat. Such a send writes a
   * silent history/context row for human observers rather than reaching an
   * inbox. Set it only on a path you have audited; never thread it through an
   * HTTP boundary.
   */
  allowRecipientlessSend?: boolean;
  /**
   * When true and `data.content` is a string, prepend `@<name>` tokens for
   * any participant in `metadata.mentions` whose name is missing from the
   * content. Used by the agent endpoint so the rendered message stays in
   * sync with the routing decision (e.g.
   * `result-sink` enrichment puts the trigger sender in
   * `metadata.mentions` but the agent's text rarely includes the @).
   * Web endpoint leaves this off — the composer has the user write the @
   * themselves; we don't want server to silently mutate human-typed
   * content.
   */
  normalizeMentionsInContent?: boolean;
  /**
   * Agent IDs that this message is **addressed to** by construction — used
   * for system-routed messages whose recipient is fixed at write time
   * (today: `github-delivery.deliverNormalizedEvent`). Within the
   * non-silenced fan-out branch, addressed agents always receive
   * `notify=true` regardless of `metadata.mentions`.
   *
   * `purpose === "agent-final-text"` still takes precedence (it forces
   * `notify=false` for everyone); this only widens the notify set within
   * the non-silenced branch.
   */
  addressedToAgentIds?: readonly string[];
  /**
   * Trusted-internal opt-in for writing `metadata.systemSender`. The web UI
   * uses that key to re-attribute a row to a synthetic "GitHub" sender
   * (avatar + name override) instead of the row's actual `senderId`. To
   * prevent a non-dispatcher caller (HTTP POST from web / agent SDK) from
   * smuggling the same marker into an ordinary message — which would let
   * an arbitrary agent post a phishing message that renders as if from
   * GitHub — the service unconditionally strips the key from
   * `data.metadata` when this option is not set. Only
   * `github-delivery.deliverNormalizedEvent` is expected to set this to
   * `true`. Defense-in-depth alongside the conjunctive UI trust gate in
   * `github-event-card.tsx#isTrustedGithubDispatcherMessage`.
   */
  allowSystemSender?: boolean;
};

export async function sendMessage(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  return withSpan("inbox.enqueue", messageAttrs({ chatId, senderAgentId: senderId, source: data.source }), async () => {
    const txResult = await db.transaction((tx) => sendMessageInTransaction(tx, chatId, senderId, data, options));
    await runSendMessagePostCommitEffects(db, chatId, txResult);
    return { message: txResult.message, recipients: txResult.recipients };
  });
}

/**
 * Routing contract (post-retire of content extraction)
 * ====================================================
 *
 * Every wake-up requires the caller to declare routing intent explicitly.
 * Explicit-recipient enforcement is ON BY DEFAULT in `sendMessage()`; a send
 * that declares no recipient is rejected unless it is one of the silent shapes
 * below. Routing is declared by one of:
 *
 *   - `data.metadata.mentions: string[]` — agent uuids (resolved upstream)
 *   - `data.receiverNames: string[]` — agent names; resolved here against
 *     the chat's speaker list
 *   - `options.addressedToAgentIds` — system-routed override (e.g. github
 *     delivery), counted only when it resolves to an active speaker
 *
 * Recipient-less sends are rejected by default, except these declared-silent
 * shapes:
 *   - `data.purpose === "agent-final-text"` — silent history-only write
 *   - `options.allowRecipientlessSend === true` — trusted system opt-out
 *
 * The server never parses `@<name>` tokens out of content. Clients that
 * surface IM-style `@-mention` UX (web composer, future mobile) must
 * resolve mentions client-side and pass uuids on the wire. The 1:1
 * "implicit wake" rule that previously bypassed the routing check was
 * removed when the explicit contract took its place — web clients now
 * auto-inject the peer's uuid into `metadata.mentions` in 2-speaker chats.
 */

export async function sendMessageInTransaction(
  tx: DbLike,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions,
): Promise<SendMessagePostCommitPlan> {
  // Fail fast before opening a transaction: `format: "file"` content must be a
  // valid image ref / batch (the route's schema leaves content unknown).
  if (data.format === "file") {
    validateFileContent(data.content);
  }

  // 1. Load participants and sender (inbox + org) in parallel — both are
  //    needed for fan-out + mention enforcement + post-tx session
  //    activation. Running concurrently keeps the hot send path on a
  //    single round-trip rather than two sequential lookups. Sender's
  //    organizationId is reused for predictive session activation
  //    (chat-internal participants share the same org under multi-tenant).
  //
  //    v2: `chat_membership.mode` is **not** SELECTed — fan-out no longer
  //    reads it. Likewise `chats.type` is locked to 'group' since
  //    first-tree-context PR #465 and no longer drives any decision here.
  const [participants, [senderRow]] = await Promise.all([
    tx
      .select({
        agentId: chatMembership.agentId,
        inboxId: agents.inboxId,
        name: agents.name,
        displayName: agents.displayName,
        status: agents.status,
        type: agents.type,
      })
      .from(chatMembership)
      .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker"))),
    tx
      .select({ inboxId: agents.inboxId, organizationId: agents.organizationId, type: agents.type })
      .from(agents)
      .where(eq(agents.uuid, senderId))
      .limit(1),
  ]);
  if (!senderRow) {
    throw new NotFoundError(`Sender agent "${senderId}" not found`);
  }

  // 1b. Defensive: unwrap content that was JSON.stringify-ed once before the
  //     agent passed it to the CLI / API. The bad shape is an outer `"..."`
  //     wrapper + interior `\n` / `\"` escape sequences; the UI renders it
  //     as a raw quoted line instead of markdown. See issue #389.
  //
  //     Guarded by sender type (human-typed quoted phrases never touched)
  //     and by a strict structural match (see `maybeUnwrapDoubleEncoded`).
  //     Non-string content (e.g. structured card payloads) is bypassed.
  let effectiveContent: SendMessage["content"] = data.content;
  if (senderRow.type !== "human" && typeof effectiveContent === "string") {
    const unwrapped = maybeUnwrapDoubleEncoded(effectiveContent);
    if (unwrapped !== null) {
      log.warn(
        { metric: "double_encoded_content_unwrapped_total", chatId, senderId },
        "agent sent JSON-encoded string content — unwrapping to restore markdown rendering",
      );
      effectiveContent = unwrapped;
    }
  }

  // 2. Decide the mention set. Two explicit sources contribute:
  //   - `metadata.mentions: [uuid]` — caller already resolved uuids
  //     (web composer, agent runtime / result-sink, adapter inbound).
  //   - `data.receiverNames: [name]` — caller knows the recipient by name
  //     and wants the server to resolve it against the chat's participant
  //     list (CLI `chat send <name>`). An unknown name is a 400 with a
  //     `chat invite` hint — never silently dropped.
  //
  // The server does NOT parse `@<name>` tokens out of `content` — see the
  // file-level "Routing contract" comment above.
  const incomingMeta = stripUntrustedMetadataKeys((data.metadata ?? {}) as Record<string, unknown>, options);
  // Server-side bottom-line on `metadata.documentContext`: shape via shared
  // schema + byte budgets and sha256 calibration. Snapshot content arrives
  // from a trusted runtime, but server still has to verify so a client bug
  // can't lodge mismatched hash/size into immutable message history. The
  // chat scope additionally rejects a cross-agent snapshot key whose owner
  // is not a speaker participant of this chat (cross-workspace doc preview
  // provenance check).
  validateDocumentContext(incomingMeta, {
    chatId,
    participantSlugs: new Set(participants.map((p) => p.name?.toLowerCase()).filter((n): n is string => Boolean(n))),
  });
  const explicitMentionsRaw = incomingMeta.mentions;
  const explicitMentions = Array.isArray(explicitMentionsRaw)
    ? explicitMentionsRaw.filter((m): m is string => typeof m === "string")
    : [];

  // Resolve `receiverNames` against the chat's speaker list.
  const receiverNames = data.receiverNames ?? [];
  const speakersByName = new Map<string, string>();
  for (const p of participants) {
    if (p.name) speakersByName.set(p.name.toLowerCase(), p.agentId);
  }
  const resolvedFromNames: string[] = [];
  const unresolvedNames: string[] = [];
  for (const name of receiverNames) {
    const id = speakersByName.get(name.toLowerCase());
    if (id) resolvedFromNames.push(id);
    else unresolvedNames.push(name);
  }
  if (unresolvedNames.length > 0) {
    const sample = unresolvedNames[0];
    throw new BadRequestError(
      `Cannot route to "${sample}" — they are not a participant of this chat. ` +
        "Add them first:\n" +
        `  ${getServerCliBinding().binName} chat invite ${sample}\n` +
        "Then retry your send. Or ask a human in this chat to add them.",
    );
  }

  const mergedMentions = [...new Set([...explicitMentions, ...resolvedFromNames])];
  const participantsById = new Map(participants.map((p) => [p.agentId, p]));
  const routedRecipientIds = new Set([
    ...mergedMentions.filter((id) => id !== senderId),
    ...(options.addressedToAgentIds ?? []).filter((id) => id !== senderId),
  ]);
  for (const id of routedRecipientIds) {
    const participant = participantsById.get(id);
    if (!participant || participant.status === "active") continue;
    const label = participant.displayName || participant.name || id;
    const recovery =
      participant.status === "suspended"
        ? "Reactivate it before sending."
        : "Deleted agents cannot receive new messages.";
    throw new BadRequestError(`Cannot route to "${label}" because the agent is ${participant.status}. ${recovery}`);
  }
  const metadataToStore = mergedMentions.length > 0 ? { ...incomingMeta, mentions: mergedMentions } : incomingMeta;

  // Open-question contract: a `format=request` message is an "ask" directed
  // at exactly one human (the sole `metadata.mentions` entry). Enforce here
  // so the body (`content`) + `metadata.request.question` split and the
  // open_request_count counter (below) have a single, validated target.
  if (data.format === MESSAGE_FORMATS.REQUEST) {
    const targetId = mergedMentions[0];
    if (mergedMentions.length !== 1 || !targetId) {
      throw new BadRequestError(
        `A 'request' message must mention exactly one recipient (got ${mergedMentions.length}). ` +
          "An open question is directed at a single human.",
      );
    }
    const target = participantsById.get(targetId);
    if (!target || target.type !== "human") {
      throw new BadRequestError("A 'request' message must be directed at a human member.");
    }
  }

  // Centralise the bypass contract for `purpose` values. Each flag
  // describes what this purpose means for a downstream decision; adding a
  // new `purpose` value means defining its profile here once, not hunting
  // through the call sites below.
  //
  // `agent-final-text` profile rationale:
  //   - skip mention enforcement (final-text is the one legal mentions-
  //     empty case: a handler-initiated forward of the agent's own response
  //     for human observers, not a message addressed into the room).
  //   - force every fan-out row to notify=false (final text lands in
  //     chat history for human observers but never wakes another
  //     session). v1 §四 改造 4 (b) bypass channel.
  const isAgentFinalText = data.purpose === "agent-final-text";
  const purposeProfile = isAgentFinalText
    ? {
        skipMentionEnforcement: true,
        forceSilentFanOut: true,
      }
    : {
        skipMentionEnforcement: false,
        forceSilentFanOut: false,
      };

  // Mention enforcement (explicit-only contract) — DEFAULT ON. Reject the
  // send when no routing intent is declared — `metadata.mentions`,
  // `receiverNames`, and `addressedToAgentIds` are the three legal
  // declarations. The invariant lives here in the write path so every entry
  // point inherits it; a new send caller cannot silently re-open the
  // "write to chat history with no recipient" footgun by forgetting a flag.
  //
  // Applies to every chat shape (1:1 included): the previous "1:1
  // implicit wake" bypass was removed when the explicit contract took
  // its place; web clients now auto-inject the peer's uuid into
  // `metadata.mentions` for 2-speaker chats so this check passes
  // transparently.
  //
  // Two send shapes legitimately carry no recipient and bypass the guard:
  //   - `purpose === "agent-final-text"` (via
  //     `purposeProfile.skipMentionEnforcement`) — silent-by-construction
  //     final text, never needs to name a recipient.
  //   - `options.allowRecipientlessSend` — trusted server-internal opt-out
  //     for system delivery paths whose addressing can legitimately resolve
  //     to no live speaker (today: github-delivery). See the option's doc.
  const skipRecipientEnforcement = purposeProfile.skipMentionEnforcement || options.allowRecipientlessSend === true;
  if (!skipRecipientEnforcement) {
    const recipientMentions = mergedMentions.filter((id) => id !== senderId);
    // A system-routing override (`addressedToAgentIds`) only satisfies the
    // guard when it resolves to an active, non-sender speaker of this chat.
    // Counting raw array length instead would let addressing that reaches no
    // one slip through (`[undefined]`, `[senderId]`, or an id that is not a
    // live speaker) — the same silent-dead-end the guard exists to prevent.
    // A trusted system path whose addressing can legitimately resolve to no
    // speaker (github-delivery) declares `allowRecipientlessSend` to opt out
    // above rather than lean on that hole.
    const hasActiveAddressed = (options.addressedToAgentIds ?? []).some(
      (id) => id !== senderId && participantsById.get(id)?.status === "active",
    );
    if (recipientMentions.length === 0 && !hasActiveAddressed) {
      throw new BadRequestError(
        "Sending a message requires an explicit recipient. " +
          "Pass `metadata.mentions: [agentId]` (or `receiverNames: [name]`) to declare routing, " +
          'or set `purpose: "agent-final-text"` for silent history-only sends.',
      );
    }
  }

  // Agent-path content normalisation: if the caller declared mentions
  // in metadata but didn't write the corresponding `@<name>` in the
  // text, prepend the missing tokens. This keeps the visible message
  // in sync with the routing decision — most importantly when an agent
  // replies in a group. Web composer leaves this off
  // because the human typed the @ themselves and we don't want server
  // to silently mutate human-typed content.
  let outboundContent = effectiveContent;
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
  // UUID v7 per the "UUID v7 as Message ID" architecture rule in
  // CLAUDE.md — time-ordered so message id lex order matches creation
  // order. randomUUID() (v4) was the pre-existing implementation; the
  // mismatch was caught when the web client's "new messages" divider
  // relied on lex ordering to find newer-than-anchor messages and
  // silently dropped some (PR #286, rev 8).
  const messageId = uuidv7();
  const [msg] = await tx
    .insert(messages)
    .values({
      id: messageId,
      chatId,
      senderId,
      format: data.format,
      content: outboundContent,
      metadata: metadataToStore,
      inReplyTo: data.inReplyTo ?? null,
      source: data.source,
    })
    .returning();

  // 4. Fan-out: create inbox entries for every non-sender participant.
  //    The `notify` flag splits them in two:
  //    - `notify=true`  — wakes the recipient's session (the existing path).
  //    - `notify=false` — silent context row, written so a future active
  //      delivery to the same chat can replay it as preceding history.
  //
  //    Explicit-only contract (see file-level "Routing contract"):
  //    - sender is always filtered out (no self-delivery).
  //    - explicit wake triggers `notify=true`:
  //        * agentId in `addressedToAgentIds` (system-routed override), OR
  //        * agentId in `metadata.mentions` (mergedMentions, post-resolve).
  //    - `purposeProfile.forceSilentFanOut` (today = `purpose ===
  //      "agent-final-text"`) forces notify=false for every row regardless.
  //      Inbox entries are still written so history replay still works;
  //      nobody is woken.
  const mentionSet = new Set(mergedMentions);
  const addressedSet = new Set(options.addressedToAgentIds ?? []);
  // Build a single fan-out structure that carries agentId alongside the
  // inbox row. agentId is needed by the post-tx session-activation step
  // (Step 1b) but is not part of the inbox_entries schema — it's stripped
  // back out at insert time below.
  const fanout = participants
    .filter((p) => p.agentId !== senderId)
    .filter((p) => p.status === "active")
    .map((p) => ({
      agentId: p.agentId,
      inboxId: p.inboxId,
      notify: !purposeProfile.forceSilentFanOut && (addressedSet.has(p.agentId) || mentionSet.has(p.agentId)),
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

  // 5. Update chat.updatedAt so chat list sorting reflects latest activity
  await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));

  if (!msg) throw new Error("Unexpected: INSERT RETURNING produced no row");

  // 6. Chat-first workspace projection (append-only, post-fan-out).
  //    Updates chats.last_message_*, increments speaker + watcher mention
  //    counters. New code; no existing path is modified — see
  //    first-tree-context:agent-hub/web-console.md "Risk Constraints".
  // Chat-list preview: prefer string content (text/markdown) verbatim;
  // fall back to the caption of a batched image send (`format: "file"`
  // with `{caption?, attachments[]}` shape) so a "text + N images" send
  // still surfaces its text in the conversation list. Pure single-image
  // messages (no caption) stay empty — same as before.
  const previewText =
    typeof outboundContent === "string" ? outboundContent.trim() : extractCaption(outboundContent).trim();
  await applyAfterFanOut(tx, {
    chatId,
    messageId: msg.id,
    senderId,
    mentionedAgentIds: mergedMentions,
    contentPreview: previewText,
    messageCreatedAt: msg.createdAt,
    // Restrict the final-text unread bump to non-human senders.
    // `purpose` lives on the shared sendMessage schema, so a human-
    // authored web send could in principle set it; gating here keeps
    // the human-as-sender path out of the new projection branch even
    // if the rest of `agent-final-text` semantics (skipMentionEnforcement,
    // forceSilentFanOut) happen to fire for that caller.
    bumpForAgentFinalText: isAgentFinalText && senderRow.type !== "human",
  });

  // 7. Open-question counter (`chat_user_state.open_request_count`) — see
  //    proposals/group-chat-unified-send §D1. TWO INDEPENDENT effects (a
  //    single message can trigger both):
  //      +1 — ANY `format=request` opens a question for its single human
  //           target, including a request-shaped reply (the new request
  //           stands on its own and is independently answerable).
  //      -1 — a reply that RESOLVES the parent request: the target answers
  //           it, OR the asking agent replies to its own request (a
  //           non-request reply withdraws it; a request-shaped reply
  //           supersedes it). Idempotent — only the first resolving reply
  //           decrements; `GREATEST(0, …)` floors at zero.
  //    A request-shaped reply by the author thus does both: +1 the new
  //    question and -1 (supersede) the parent → nets zero when both target
  //    the same human; +1 only when the parent was already resolved/closed.
  const requestTarget = mergedMentions[0];
  if (data.format === MESSAGE_FORMATS.REQUEST && requestTarget) {
    await tx.execute(sql`
        INSERT INTO chat_user_state (chat_id, agent_id, open_request_count)
        VALUES (${chatId}, ${requestTarget}, 1)
        ON CONFLICT (chat_id, agent_id)
        DO UPDATE SET open_request_count = chat_user_state.open_request_count + 1
      `);
  }
  if (data.inReplyTo) {
    // Lock the parent request row FIRST so concurrent resolving replies to
    // the SAME request serialise — otherwise two answers/closes could both
    // observe `alreadyResolved=false` under READ COMMITTED and each
    // decrement the same row (double-decrement).
    const [parent] = await tx
      .select({ format: messages.format, metadata: messages.metadata, senderId: messages.senderId })
      .from(messages)
      .where(and(eq(messages.id, data.inReplyTo), eq(messages.chatId, chatId)))
      .for("update")
      .limit(1);
    const parentMentions = Array.isArray(parent?.metadata?.mentions) ? parent.metadata.mentions : [];
    const target =
      parent?.format === MESSAGE_FORMATS.REQUEST && parentMentions.length === 1 ? parentMentions[0] : undefined;
    if (typeof target === "string") {
      // Resolving = the target answers (sender === target) OR the asking
      // agent replies to its own request (any format — withdraw or supersede).
      const isAnswer = senderId === target;
      const isAuthorReply = senderId === parent?.senderId;
      if (isAnswer || isAuthorReply) {
        // Idempotency: only the FIRST resolving reply decrements (exclude the
        // row we just inserted). Serialised by the parent FOR UPDATE lock; a
        // prior resolving reply is one from the target or the asking author.
        const priors = await tx
          .select({ senderId: messages.senderId })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), eq(messages.inReplyTo, data.inReplyTo), ne(messages.id, messageId)));
        const alreadyResolved = priors.some((p) => p.senderId === target || p.senderId === parent?.senderId);
        if (!alreadyResolved) {
          await tx.execute(sql`
              UPDATE chat_user_state
                 SET open_request_count = GREATEST(0, open_request_count - 1)
               WHERE chat_id = ${chatId} AND agent_id = ${target}
            `);
        }
      }
    }
  }

  return {
    message: msg,
    recipients,
    recipientAgentIds,
    organizationId: senderRow.organizationId,
  };
}

export async function runSendMessagePostCommitEffects(
  db: Database,
  chatId: string,
  txResult: SendMessagePostCommitPlan,
): Promise<void> {
  // Predictive session-state activation: after the main transaction commits,
  // best-effort upsert an `active` agent_chat_sessions row for every notify=true
  // recipient so the First Tree UI list refreshes immediately on send (see M-plan
  // §8 R7 / §5 invariant #2 — notifier=undefined keeps NOTIFY scoped to First Tree UI,
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

  // Best-effort chat-first workspace kick — speakers also get the existing
  // inbox NOTIFY; this is what reaches watcher rows (no inbox entry → no
  // wake-up otherwise). Failure is dropped; web reconnect refetches.
  fireChatMessageKick(chatId, txResult.message.id);
}

export async function loadSendMessagePostCommitPlan(
  db: DbLike,
  chatId: string,
  messageId: string,
): Promise<SendMessagePostCommitPlan> {
  const [[message], [chat], notifyRows] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
      .limit(1),
    db.select({ organizationId: chats.organizationId }).from(chats).where(eq(chats.id, chatId)).limit(1),
    db
      .select({ inboxId: inboxEntries.inboxId, agentId: agents.uuid })
      .from(inboxEntries)
      .innerJoin(agents, eq(agents.inboxId, inboxEntries.inboxId))
      .where(
        and(eq(inboxEntries.chatId, chatId), eq(inboxEntries.messageId, messageId), eq(inboxEntries.notify, true)),
      ),
  ]);
  if (!message) throw new NotFoundError(`Message "${messageId}" not found in chat "${chatId}"`);
  if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);
  return {
    message,
    recipients: notifyRows.map((row) => row.inboxId),
    recipientAgentIds: notifyRows.map((row) => row.agentId),
    organizationId: chat.organizationId,
  };
}

/**
 * Detect agent-sent content that was JSON.stringify-ed once before reaching
 * the CLI / API. The bad shape is an outer `"..."` wrapper + interior `\n` /
 * `\"` escape sequences, which the UI renders as a quoted literal instead of
 * markdown (issue #389). Returns the unwrapped inner string on a confident
 * match, or `null` to leave the content alone.
 *
 * Match conditions (all required) — kept strict so legitimate human content
 * that happens to look like a quoted phrase is never touched. The caller is
 * additionally responsible for restricting this to non-human senders.
 *
 *   - first and last char are `"`
 *   - body contains at least one typical JSON escape sequence
 *     (`\n`, `\r`, `\t`, `\"`, or `\\`)
 *   - `JSON.parse` succeeds
 *   - the parse result is a `string` (excludes `{...}`, `[...]`, numbers)
 */
export function maybeUnwrapDoubleEncoded(content: string): string | null {
  if (content.length < 4) return null;
  if (content.charCodeAt(0) !== 0x22 /* " */) return null;
  if (content.charCodeAt(content.length - 1) !== 0x22 /* " */) return null;
  if (!/\\[nrt"\\]/.test(content)) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
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

  // The open-question counter (`open_request_count`) is maintained only on the
  // send path, keyed off `format=request`. Allowing an edit to flip a message
  // into or out of `request` would desync that counter (a request edited to
  // text leaves a stuck +1; text edited to request renders an open card with
  // no count). Forbid format changes that touch `request`; content edits and
  // other format changes are unaffected. See proposals/group-chat-unified-send §D1.
  if (
    data.format !== undefined &&
    data.format !== msg.format &&
    (data.format === MESSAGE_FORMATS.REQUEST || msg.format === MESSAGE_FORMATS.REQUEST)
  ) {
    throw new BadRequestError("Cannot change a message's format to or from 'request'.");
  }

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
