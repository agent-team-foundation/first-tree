import {
  extractCaption,
  imageBatchRefContentSchema,
  imageRefContentSchema,
  MAX_BATCH_ATTACHMENTS,
  MESSAGE_FORMATS,
  requestResolutionSchema,
  type SendMessage,
  scanMentionTokens,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
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
import { validateDocumentContext, validateMessageAttachmentRefs } from "./doc-snapshots.js";

const log = createLogger("message");

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

function validateMessageContent(data: SendMessage): void {
  if (data.format === "file") {
    validateFileContent(data.content);
  }
}

export type SendMessageResult = {
  message: typeof messages.$inferSelect;
  /** Inbox IDs that received this message (for notification). */
  recipients: string[];
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
   * Agent IDs to **exclude from the notify (wake) set** even when they would
   * otherwise be woken via `metadata.mentions` or `addressedToAgentIds`.
   * Generic trusted-delivery capability, decoupled from `senderId`: the
   * suppressed agent still receives a `notify=false` inbox row (the message
   * still lands in history / replays as context), it is simply not woken.
   *
   * Today's caller is `github-delivery.deliverNormalizedEvent`, which passes
   * the event's actor agent so an agent is never woken by its own GitHub
   * action (echo suppression) — without binding that exclusion to `senderId`
   * (the actor is frequently not a speaker of the target chat, so it must not
   * be the chat-local sender). See `system/cloud/github/github-entity-chat-binding.md`
   * S2. `purpose === "agent-final-text"` still forces silent for everyone;
   * this only narrows the notify set within the non-silenced branch.
   */
  suppressNotifyAgentIds?: readonly string[];
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

export type SendIntentParticipant = {
  agentId: string;
  name: string | null;
  displayName: string;
  status: string;
  type: string;
};

export type SendMessagePreflightResult = {
  content: SendMessage["content"];
  metadata: Record<string, unknown>;
  mentionedAgentIds: string[];
  isAgentFinalText: boolean;
  forceSilentFanOut: boolean;
};

export function preflightMessageSendIntent(input: {
  chatId: string;
  senderId: string;
  senderType: string;
  data: SendMessage;
  options?: SendMessageOptions;
  participants: ReadonlyArray<SendIntentParticipant>;
}): SendMessagePreflightResult {
  const options = input.options ?? {};
  const { chatId, senderId, senderType, data, participants } = input;

  validateMessageContent(data);

  let effectiveContent: SendMessage["content"] = data.content;
  if (senderType !== "human" && typeof effectiveContent === "string") {
    const unwrapped = maybeUnwrapDoubleEncoded(effectiveContent);
    if (unwrapped !== null) {
      log.warn(
        { metric: "double_encoded_content_unwrapped_total", chatId, senderId },
        "agent sent JSON-encoded string content — unwrapping to restore markdown rendering",
      );
      effectiveContent = unwrapped;
    }
  }

  const incomingMeta = stripUntrustedMetadataKeys((data.metadata ?? {}) as Record<string, unknown>, options);
  validateDocumentContext(incomingMeta);
  if (incomingMeta.resolves !== undefined && !requestResolutionSchema.safeParse(incomingMeta.resolves).success) {
    throw new BadRequestError(
      'Malformed "metadata.resolves": expected {request: <messageId>, kind: "answered"|"closed", reason?}.',
    );
  }

  const explicitMentionsRaw = incomingMeta.mentions;
  const explicitMentionsRawList = Array.isArray(explicitMentionsRaw)
    ? explicitMentionsRaw.filter((m): m is string => typeof m === "string")
    : [];
  const participantsById = new Map(participants.map((p) => [p.agentId, p]));
  const explicitMentions = explicitMentionsRawList.filter((id) => id === senderId || participantsById.has(id));

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
  const mentionTargets = mergedMentions.filter((id) => id !== senderId);
  for (const id of mentionTargets) {
    const participant = participantsById.get(id);
    if (!participant) {
      throw new BadRequestError(`Cannot route to "${id}" — they are not a participant of this chat.`);
    }
    if (participant.status !== "active") {
      const label = participant.displayName || participant.name || id;
      const recovery =
        participant.status === "suspended"
          ? "Reactivate it before sending."
          : "Deleted agents cannot receive new messages.";
      throw new BadRequestError(`Cannot route to "${label}" because the agent is ${participant.status}. ${recovery}`);
    }
  }
  const routedRecipientIds = new Set([
    ...mentionTargets,
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

  // An agent may address a human ONLY as a `request` (an ask via `chat ask`). A
  // plain agent→human send has no channel: humans are reached with `chat ask`
  // (decisions/approval) or `chat update --description` (progress). The only
  // exempt shape is the silent `agent-final-text` mirror (it addresses no one —
  // an agent's own response surfaced for human observers). An agent CANNOT
  // resolve a question either: resolution is human-only (the web answer), so a
  // resolution-carrying agent send is not exempt here and is also refused by the
  // resolution authorization below.
  if (senderType !== "human" && data.format !== MESSAGE_FORMATS.REQUEST && data.purpose !== "agent-final-text") {
    const humanTarget = mentionTargets.map((id) => participantsById.get(id)).find((p) => p?.type === "human");
    if (humanTarget) {
      const label = humanTarget.displayName || humanTarget.name || "that human";
      throw new BadRequestError(
        `An agent cannot \`chat send\` a human (addressed ${label}). Ask a human with ` +
          "`chat ask` (a decision/approval/answer), or report progress with `chat update --description`.",
      );
    }
  }

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

  const skipRecipientEnforcement = purposeProfile.skipMentionEnforcement || options.allowRecipientlessSend === true;
  if (!skipRecipientEnforcement) {
    const hasActiveAddressed = (options.addressedToAgentIds ?? []).some(
      (id) => id !== senderId && participantsById.get(id)?.status === "active",
    );
    if (mentionTargets.length === 0 && !hasActiveAddressed) {
      throw new BadRequestError(
        "Sending a message requires an explicit recipient. " +
          "Pass `metadata.mentions: [agentId]` (or `receiverNames: [name]`) to declare routing, " +
          'or set `purpose: "agent-final-text"` for silent history-only sends.',
      );
    }
  }

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

  return {
    content: outboundContent,
    metadata: metadataToStore,
    mentionedAgentIds: mergedMentions,
    isAgentFinalText,
    forceSilentFanOut: purposeProfile.forceSilentFanOut,
  };
}

export async function sendMessage(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  validateMessageContent(data);
  return withSpan("inbox.enqueue", messageAttrs({ chatId, senderAgentId: senderId, source: data.source }), () =>
    sendMessageInner(db, chatId, senderId, data, options),
  );
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

async function sendMessageInner(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const txResult = await db.transaction(async (tx) => {
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

    const prepared = preflightMessageSendIntent({
      chatId,
      senderId,
      senderType: senderRow.type,
      data,
      options,
      participants,
    });
    const { content: outboundContent, metadata: metadataToStore, mentionedAgentIds: mergedMentions } = prepared;

    // 2b. Validate generic attachment refs (`metadata.attachments[]`) against
    //     the blob store: each referenced attachment must exist and its
    //     declared mime/size must match the stored row. Async (DB lookup), so
    //     it runs here rather than in the sync preflight. Byte integrity is
    //     checked client-side at render via `ref.sha256`; uploader != sender by
    //     design (see validateMessageAttachmentRefs).
    await validateMessageAttachmentRefs(tx, metadataToStore);

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
    // Generic echo / wake-exclusion: agents here still get a `notify=false`
    // inbox row (message lands), they are just not woken. Decoupled from
    // `senderId` so a non-member actor can be excluded without being made the
    // chat-local sender. See SendMessageOptions.suppressNotifyAgentIds.
    const suppressNotifySet = new Set(options.suppressNotifyAgentIds ?? []);
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
        notify:
          !prepared.forceSilentFanOut &&
          (addressedSet.has(p.agentId) || mentionSet.has(p.agentId)) &&
          !suppressNotifySet.has(p.agentId),
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
    //    Updates chats.last_message_*, increments the directly-mentioned human
    //    speaker's unread-mention counter (plus the agent-final-text bump). See
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
      bumpForAgentFinalText: prepared.isAgentFinalText && senderRow.type !== "human",
    });

    // 7. Open-question counter (`chat_user_state.open_request_count`) — see
    //    proposals/group-chat-unified-send §D1. TWO INDEPENDENT effects:
    //      +1 — ANY `format=request` opens a question for its single human
    //           target. (A request-shaped reply also +1's — it is a new,
    //           independently-answerable question; it does NOT auto-close the
    //           one it replies to. Both stay open, worked oldest-first.)
    //      -1 — an EXPLICIT resolution: a message carrying `metadata.resolves`
    //           pointed at a prior open question. Resolution is human-only — the
    //           target's web answer; an agent (even the asker) cannot resolve.
    //           `inReplyTo` no longer resolves anything — it is pure threading,
    //           so a "chat about this" discussion can thread under the question
    //           without clearing the red dot. Idempotent — only the first
    //           resolution decrements; `GREATEST(0, …)` floors at zero.
    const requestTarget = mergedMentions[0];
    if (data.format === MESSAGE_FORMATS.REQUEST && requestTarget) {
      await tx.execute(sql`
        INSERT INTO chat_user_state (chat_id, agent_id, open_request_count)
        VALUES (${chatId}, ${requestTarget}, 1)
        ON CONFLICT (chat_id, agent_id)
        DO UPDATE SET open_request_count = chat_user_state.open_request_count + 1
      `);
    }
    // ANY presence of the reserved `resolves` key must parse — a malformed
    // shape (e.g. bogus `kind`) is rejected, not stored as inert metadata.
    // Storing it would both mislead readers and poison the prior-resolution
    // idempotency scan below (which matches on `resolves ->> 'request'`),
    // permanently blocking the legitimate decrement.
    const resolution = requestResolutionSchema.safeParse(metadataToStore.resolves);
    if (resolution.success) {
      const requestId = resolution.data.request;
      // Lock the target request row FIRST so concurrent resolutions of the
      // SAME question serialise — otherwise two could both observe no prior
      // resolution under READ COMMITTED and each decrement (double-decrement).
      const [parent] = await tx
        .select({ format: messages.format, metadata: messages.metadata, senderId: messages.senderId })
        .from(messages)
        .where(and(eq(messages.id, requestId), eq(messages.chatId, chatId)))
        .for("update")
        .limit(1);
      // FAIL LOUD on an invalid resolution target. Throwing here rolls back
      // the whole transaction (including the message INSERT above), so no
      // misleading "answered"/"closed" message with a dangling
      // `metadata.resolves.request` / `inReplyTo` ever lands in history.
      if (!parent) {
        throw new BadRequestError(
          `Cannot resolve "${requestId}": no such message in this chat. Pass the id of the open question you asked.`,
        );
      }
      const parentMentions = Array.isArray(parent.metadata?.mentions) ? parent.metadata.mentions : [];
      const target =
        parent.format === MESSAGE_FORMATS.REQUEST && parentMentions.length === 1 ? parentMentions[0] : undefined;
      if (typeof target !== "string") {
        throw new BadRequestError(
          `Cannot resolve "${requestId}": it is not a tracked request. Only a question raised with \`chat ask\` can be answered.`,
        );
      }
      // Resolution is human-only: ONLY the target human resolves it, by
      // answering in the web UI. An agent — including the asker — cannot mark a
      // question answered or close it; an agent reaches the human only by asking.
      // (The send guard above already refuses an agent→human send that is not an
      // ask; this is the authoritative authz for the resolution itself.)
      if (senderId !== target) {
        throw new ForbiddenError("Only the question's target may resolve it — the human answers in the web UI.");
      }
      // Idempotency: only the FIRST resolution decrements (exclude the row we
      // just inserted). A prior resolution is any other message in this chat
      // whose `metadata.resolves.request` points at the same question, from a
      // sender in the resolver scope. The scope is the target human (the only
      // authorized resolver now) PLUS the asker — the asker is kept ONLY to
      // recognize legacy pre-gate rows it may have written back when an agent
      // could resolve; it can no longer write a NEW resolution (the authz above
      // rejects it). The scope matters because, without it, any participant
      // could pre-write a stray `metadata.resolves` (itself never decrementing,
      // being unauthorized) that would count as a "prior" and permanently block
      // the legitimate resolution from clearing the red dot. A re-resolve of an
      // already-resolved question stays a soft success: it threads as a
      // confirmation and simply skips the decrement, so a duplicate human answer
      // never errors.
      const resolvers = [target, parent.senderId];
      const priors = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chatId),
            ne(messages.id, messageId),
            sql`${messages.metadata} -> 'resolves' ->> 'request' = ${requestId}`,
            // Only schema-valid resolution rows count as a "prior" — a
            // malformed legacy row (pre-validation `kind`) must not block
            // the legitimate resolution from clearing the red dot.
            sql`${messages.metadata} -> 'resolves' ->> 'kind' IN ('answered', 'closed')`,
            inArray(messages.senderId, resolvers),
          ),
        );
      if (priors.length === 0) {
        await tx.execute(sql`
          UPDATE chat_user_state
             SET open_request_count = GREATEST(0, open_request_count - 1)
           WHERE chat_id = ${chatId} AND agent_id = ${target}
        `);
      }
    }

    return {
      message: msg,
      recipients,
      recipientAgentIds,
      organizationId: senderRow.organizationId,
    };
  });

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

  return { message: txResult.message, recipients: txResult.recipients };
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

/**
 * Every `format=request` message in `chatId` directed at `viewerAgentId` (its
 * single human target) that has NO authorized resolution yet — i.e. the
 * viewer's currently-open questions, oldest-first.
 *
 * "Open" mirrors the `open_request_count` decrement rule in `sendMessage`:
 * resolution is human-only, so a request is resolved iff a later message in the
 * chat carries `metadata.resolves.request = <this id>` with a valid kind from an
 * authorized resolver — the target (the viewer) or the asker. Anything else
 * (a bare threaded reply, a stray `resolves` from a third party) leaves it open.
 *
 * This is deliberately WINDOW-INDEPENDENT: it is the source the blocking
 * answer UI uses so an open ask that has scrolled past the latest message page
 * still surfaces (the timeline fetch is capped + unpaginated). Oldest-first so
 * the caller's FIFO blocking pick matches the client's `findBlockingRequest`.
 */
export async function listOpenRequestsForViewer(
  db: Database,
  chatId: string,
  viewerAgentId: string,
): Promise<(typeof messages.$inferSelect)[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.format, MESSAGE_FORMATS.REQUEST),
        sql`${messages.metadata} -> 'mentions' @> jsonb_build_array(${viewerAgentId}::text)`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${messages} AS resolver
          WHERE resolver.chat_id = ${messages.chatId}
            AND resolver.metadata -> 'resolves' ->> 'request' = ${messages.id}::text
            AND (resolver.metadata -> 'resolves' ->> 'kind') IN ('answered', 'closed')
            AND resolver.sender_id IN (${messages.senderId}, ${viewerAgentId})
        )`,
      ),
    )
    .orderBy(asc(messages.createdAt));
}
