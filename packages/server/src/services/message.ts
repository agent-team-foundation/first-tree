import { randomUUID } from "node:crypto";
import { extractMentions, type SendMessage, scanMentionTokens } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger, messageAttrs, withSpan } from "../observability/index.js";
import { upsertSessionState } from "./activity.js";
import { applyAfterFanOut, fireChatMessageKick } from "./chat-projection.js";
import { validateDocumentContext } from "./doc-snapshots.js";
import { assertSenderMayEmitQuestion, recordPendingQuestionFromMessage } from "./questions.js";

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
  /**
   * Agent IDs that this message is **addressed to** by construction — used
   * for system-routed messages whose recipient is fixed at write time and
   * not derivable from `@<name>` tokens in the content. Within the
   * non-silenced fan-out branch, addressed agents always receive
   * `notify=true` regardless of their chat membership mode (`mention_only`)
   * or `metadata.mentions`.
   *
   * Canonical use: a `question_answer` from a human submitter is addressed
   * to the original asker. Without this override, a chat that upgraded
   * `direct → group` after the question was posted would silently re-grade
   * the asker to `mention_only`, and the answer's structured content (an
   * object, not a string with `@<name>`) would produce no mentions and
   * therefore no notify=true row — leaving the asker's `canUseTool` Promise
   * dangling forever.
   *
   * `isSilentSend` and `isAgentFinalText` still take precedence (they force
   * notify=false for everyone); this only widens the notify set within the
   * non-silenced branch.
   */
  addressedToAgentIds?: readonly string[];
  /**
   * When true, parse `@<name>` tokens out of string content as a
   * **fallback** routing signal. The signal is only consulted when the
   * caller did NOT declare routing intent via `metadata.mentions` (uuids)
   * or `data.receiverNames` (names) — those two are explicit-wins, and
   * presence of either skips content extraction entirely so a narrative
   * `@<peer-name>` in the body can never silently widen the recipient set.
   *
   * Enabled on both the human web endpoint and the agent endpoint today
   * (the agent runtime's LLM output naturally writes `@<peer>` without a
   * companion `receiverNames` array, and breaking that mental model
   * requires a runtime-side parser rewrite that is out of scope for the
   * current PR). The unresolved-@-token guard is gated on the same flag.
   *
   * Default when omitted: ON (`undefined !== false` evaluates to true).
   * Adapter / webhook / programmatic callers don't need to opt out — they
   * already declare recipients via `metadata.mentions` or `receiverNames`,
   * which is explicit-wins and skips content extraction regardless of
   * this flag. Pass `false` only to forcibly suppress the fallback even
   * when no explicit declaration was made.
   */
  extractMentionsFromContent?: boolean;
};

export async function sendMessage(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  return withSpan("inbox.enqueue", messageAttrs({ chatId, senderAgentId: senderId, source: data.source }), () =>
    sendMessageInner(db, chatId, senderId, data, options),
  );
}

/**
 * 1:1 implicit wake rule
 * ======================
 *
 * A chat with exactly 2 speakers (`participants.length === 2`) treats the
 * non-sender peer as implicitly addressed. Practical UX motivation: in a
 * 1-on-1 human↔agent chat, the human typing "hello" without an explicit
 * `@mention` should still wake the agent — there is no ambiguity about
 * who the message is for.
 *
 * This rule is expressed in the fan-out decision (notify=true branch) as:
 *
 *   isOneOnOne && p.agentId !== senderId
 *
 * It is NOT a `chat_membership.mode`-derived property — `mode` is decision-
 * inert in v2. The rule operates on chat membership shape and applies
 * uniformly regardless of participant types. A 1:1 agent↔agent chat is
 * also covered (the other agent gets notify=true on every message, which
 * is the desired behaviour for a tight pair like a delegated subtask).
 *
 * Silent-send (content empty after stripping leading `@<name>` tokens)
 * and `purpose === "agent-final-text"` both still force notify=false; the
 * implicit wake is shadowed by these profile bypasses.
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
    //     Non-string content (e.g. structured question payloads) is bypassed.
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

    // 2. Decide the mention set. Three sources can contribute:
    //   - `metadata.mentions: [uuid]` — caller already resolved uuids
    //     (result-sink / questions / adapter / webhook).
    //   - `data.receiverNames: [name]` — caller knows the recipient by name
    //     and wants the server to resolve it against the chat's participant
    //     list (CLI `chat send <name>` post-Phase-1). An unknown name is a
    //     400 with a `chat invite` hint — never silently dropped.
    //   - Content-extracted `@<name>` tokens — opt-in via
    //     `extractMentionsFromContent`, used only by the human web endpoint
    //     where the typed message is the sole source of routing intent.
    //     Agent / programmatic callers leave this off so a narrative
    //     `@<peer>` in content never silently wakes anyone.
    const incomingMeta = (data.metadata ?? {}) as Record<string, unknown>;
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
    const contentText = typeof effectiveContent === "string" ? effectiveContent : "";

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
          `  first-tree-hub chat invite ${sample}\n` +
          "Then retry your send. Or ask a human in this chat to add them.",
      );
    }

    // Explicit-wins-with-content-fallback. When the caller declares routing
    // intent via `metadata.mentions` (uuids) or `data.receiverNames` (names),
    // we trust that and skip content extraction so a narrative `@<peer>` in
    // the body never silently adds an extra recipient. With neither
    // declared, fall back to `@<name>` extraction (default ON) so the IM
    // mental model (typed `@b` wakes b) still works — this is the path the
    // agent runtime takes when its LLM output naturally writes `@<peer>`
    // without a companion `receiverNames` array. Programmatic callers that
    // never want extraction (adapter / webhook variants that already pass
    // explicit mentions) can opt out by setting the flag to `false`.
    const explicitlyDeclared = explicitMentions.length > 0 || resolvedFromNames.length > 0;
    const contentExtractEnabled = options.extractMentionsFromContent !== false;
    const contentExtracted =
      !explicitlyDeclared && contentExtractEnabled && contentText ? extractMentions(contentText, participants) : [];
    const mergedMentions = [...new Set([...explicitMentions, ...resolvedFromNames, ...contentExtracted])];
    const metadataToStore = mergedMentions.length > 0 ? { ...incomingMeta, mentions: mergedMentions } : incomingMeta;

    // 1-on-1 auto-mention for the unread-counter projection (chat-first
    // workspace). In a two-member chat the recipient is implicit, so the
    // conversation list should red-dot every DM message — without this,
    // `extractMentions` returns [] on plain text and `applyAfterFanOut`
    // short-circuits the counter bump, leaving DM rows at zero unread.
    //
    // The 1-on-1 signal is membership shape (participants.length === 2)
    // rather than `chats.type === "direct"`. Hub no longer writes new
    // `direct` rows (see first-tree-context PR #281), and any existing
    // `direct` row by construction has exactly two speakers — so the
    // derived predicate matches both old and new chats without a column
    // check.
    //
    // This list is **projection-only** — it deliberately does NOT join
    // `mergedMentions`. Folding it in would make the auto-mention also
    // drive fan-out (`notify=true` inbox), which would reintroduce the
    // agent↔agent courtesy loop migration 0029 fixed: A's "ok thanks"
    // would wake B in `mention_only` mode again. Keep the two lists
    // separate so unread badges are correct without unmuting agent wakes.
    //
    // Silent-send (step 2e) overrides this back to [] so the badge stays
    // off — a silent turn whose entire text is `@<name>` tokens is meant
    // to land in history without bothering anyone; bumping unread
    // contradicts that intent.
    const isOneOnOne = participants.length === 2;
    const dmAutoProjection: string[] = isOneOnOne
      ? [...new Set([...mergedMentions, ...participants.filter((p) => p.agentId !== senderId).map((p) => p.agentId)])]
      : mergedMentions;

    // v2: centralise the bypass contract for `purpose` values. Each flag
    // describes what this purpose means for a downstream decision; adding a
    // new `purpose` value means defining its profile here once, not hunting
    // through the three call sites below.
    //
    // `agent-final-text` profile rationale:
    //   - skip group-mention enforcement (handler-initiated forward, not a
    //     user-typed broadcast).
    //   - skip the unresolved-@-token guard (handler text may legitimately
    //     contain narrative @ tokens that don't resolve to chat members).
    //   - force every fan-out row to notify=false (final text lands in
    //     chat history for human observers but never wakes another
    //     session). v1 §四 改造 4 (b) bypass channel.
    const isAgentFinalText = data.purpose === "agent-final-text";
    const purposeProfile = isAgentFinalText
      ? {
          skipMentionEnforcement: true,
          skipUnresolvedTokenGuard: true,
          forceSilentFanOut: true,
        }
      : {
          skipMentionEnforcement: false,
          skipUnresolvedTokenGuard: false,
          forceSilentFanOut: false,
        };

    // 2b. Group-chat receiver enforcement (agent-only). Stop a misuse where an
    //     agent calls `send --chat <id>` against a group without naming who
    //     should pick it up — every recipient would silently drop the message
    //     and the sender would assume delivery.
    //
    //     Keys on membership shape (`isOneOnOne`, derived from
    //     `participants.length === 2`) so a size-2 chat keeps the legacy
    //     "1-on-1 doesn't need an explicit @mention" UX. Three-plus-speaker
    //     chats stay strict. v2 dropped the `chats.type === "group"` branch
    //     — chats are structurally always group, so the predicate folds
    //     down to "must be a real group (≥3 speakers) and not bypassed".
    if (options.enforceGroupMention && !isOneOnOne && !purposeProfile.skipMentionEnforcement) {
      const recipientMentions = mergedMentions.filter((id) => id !== senderId);
      if (recipientMentions.length === 0) {
        throw new BadRequestError(
          "Sending to a group chat requires an explicit @mention. " +
            "Use `first-tree-hub chat send <name>` to message a single agent, or @<name> in the content to address one or more group members.",
        );
      }
    }

    // 2b.1. Unresolved-@-token guard. Closes the foot-gun where a caller
    //   types `@<name>` for someone who is not a speaker of THIS chat —
    //   `extractMentions` would silently drop it and the message would land
    //   with `mentions=[]`, never waking the intended recipient.
    //
    //   Gated on `enforceGroupMention` (same flag that opts a caller into
    //   strict routing checks — HTTP endpoints set it; internal / adapter
    //   paths leave it off and keep the "unknown @ silently drops" legacy
    //   semantics). Also skipped when the caller declared recipients
    //   explicitly: their `@<name>` tokens are narrative, not routing.
    //
    //   Code-fenced `@` tokens are already stripped by `scanMentionTokens`
    //   upstream, so legitimate quoted `@<name>` in code blocks is
    //   unaffected. `purpose === "agent-final-text"` bypasses through
    //   `purposeProfile.skipUnresolvedTokenGuard` for the same reason it
    //   bypasses enforceGroupMention.
    if (
      options.enforceGroupMention &&
      !explicitlyDeclared &&
      contentExtractEnabled &&
      !purposeProfile.skipUnresolvedTokenGuard &&
      typeof effectiveContent === "string"
    ) {
      const rawTokens = scanMentionTokens(effectiveContent);
      if (rawTokens.length > 0) {
        const speakerNames = new Set(
          participants
            .map((p) => p.name)
            .filter((n): n is string => typeof n === "string" && n.length > 0)
            .map((n) => n.toLowerCase()),
        );
        const unresolved = rawTokens.filter((t) => !speakerNames.has(t));
        if (unresolved.length > 0) {
          const sample = unresolved[0];
          throw new BadRequestError(
            `Cannot @-mention "${sample}" — they are not a participant of this chat. ` +
              "Add them first:\n" +
              `  first-tree-hub chat invite ${sample}\n` +
              "Then retry your send. Or ask a human in this chat to add them.",
          );
        }
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

    // 2d. Defensive: only Claude-runtime agents may emit ask-user questions.
    //     Codex SDK has no ask-user surface, so any `format=question` message
    //     coming from a codex-runtime sender is a runtime regression. We
    //     surface it as 403 here rather than silently writing the row, so
    //     the buggy caller is forced to fix itself. See questions.ts.
    if (data.format === "question") {
      await assertSenderMayEmitQuestion(tx, senderId);
    }

    // 2e. L4 silent-send form guard — mirror of the client-side result-sink
    //     silent-turn (runtime/result-sink.ts). Covers any path that reaches
    //     sendMessage without going through result-sink: the agent CLI
    //     `chat send`, AskUserQuestion, external IM adapters, admin/web
    //     posts. Form-only check on the FINAL outbound text (after
    //     normalizeMentionsInContent has had its turn): if everything that
    //     remains after stripping leading `@<name>` tokens is empty, the
    //     send becomes silent — the message row is still written so chat
    //     history stays complete, but fan-out emits notify=false for every
    //     recipient (silent context rows; L3 behavior).
    //
    //     NO content language evaluation. Non-empty filler like "." or
    //     "(待命中)" still wakes the recipient; the agent prompt + silent-
    //     turn protocol is responsible for those. Non-string content
    //     (e.g. structured question payloads) bypasses the guard entirely.
    const isSilentSend =
      typeof outboundContent === "string" && outboundContent.replace(/^(@\S+\s*)+/, "").trim().length === 0;
    if (isSilentSend) {
      log.info(
        { chatId, senderId, source: data.source },
        "silent send: empty content after mention strip — no fan-out wake-up",
      );
    }

    // Silent-send overrides the direct-chat auto-mention projection: a
    // silent turn is "this exists in history but nobody needs to know",
    // so the recipient's red-dot badge stays off too. Mirrors the
    // fan-out `notify=false` guarantee at step 4 below.
    const projectionMentions: string[] = isSilentSend ? [] : dmAutoProjection;

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
        inReplyTo: data.inReplyTo ?? null,
        source: data.source,
      })
      .returning();

    // 3b. For ask-user questions, record the pending lifecycle row in the
    //     same transaction so a rollback drops both. The content was just
    //     stored verbatim above; recordPendingQuestionFromMessage parses it
    //     to extract the correlationId and rejects malformed payloads.
    if (data.format === "question" && msg) {
      await recordPendingQuestionFromMessage(tx, {
        agentId: senderId,
        chatId,
        messageId: msg.id,
        content: outboundContent,
      });
    }

    // 4. Fan-out: create inbox entries for every non-sender participant.
    //    The `notify` flag splits them in two:
    //    - `notify=true`  — wakes the recipient's session (the existing path).
    //    - `notify=false` — silent context row, written so a future active
    //      delivery to the same chat can replay it as preceding history.
    //
    //    v2 rules (membership-shape driven; `chat_membership.mode` is no
    //    longer read — see file-level "1:1 implicit wake rule" comment and
    //    proposals/hub-chat-message-v2-simplify-mode.20260520.md):
    //    - sender is always filtered out (no self-delivery).
    //    - explicit wake triggers `notify=true`:
    //        * agentId in `addressedToAgentIds` (system-routed override), OR
    //        * agentId in `metadata.mentions` (mergedMentions, post-resolve), OR
    //        * 1:1 implicit — `isOneOnOne` and the recipient is not sender.
    //    - silent-send and `purposeProfile.forceSilentFanOut` (today
    //      = `purpose === "agent-final-text"`) both force notify=false for
    //      every row regardless. Inbox entries are still written so history
    //      replay still works; nobody is woken.
    const mentionSet = new Set(mergedMentions);
    const addressedSet = new Set(options.addressedToAgentIds ?? []);
    // Build a single fan-out structure that carries agentId alongside the
    // inbox row. agentId is needed by the post-tx session-activation step
    // (Step 1b) but is not part of the inbox_entries schema — it's stripped
    // back out at insert time below.
    const fanout = participants
      .filter((p) => p.agentId !== senderId)
      .map((p) => ({
        agentId: p.agentId,
        inboxId: p.inboxId,
        notify:
          !isSilentSend &&
          !purposeProfile.forceSilentFanOut &&
          (addressedSet.has(p.agentId) || mentionSet.has(p.agentId) || isOneOnOne),
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
    //    docs/chat-first-workspace-product-design.md "Risk Constraints".
    const previewText = typeof outboundContent === "string" ? outboundContent.trim() : "";
    await applyAfterFanOut(tx, {
      chatId,
      messageId: msg.id,
      senderId,
      mentionedAgentIds: projectionMentions,
      contentPreview: previewText,
      messageCreatedAt: msg.createdAt,
    });

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

  // Best-effort chat-first workspace kick — speakers also get the existing
  // inbox NOTIFY; this is what reaches watcher rows (no inbox entry → no
  // wake-up otherwise). Failure is dropped; web reconnect refetches.
  fireChatMessageKick(chatId, txResult.message.id);

  // L4 echo-loop observation: scan the just-tail of this chat for the
  // ping-pong pattern that L1 (mention_only) + L4 (silent-turn) are meant
  // to prevent. We emit a structured warn-log only — `notify` is never
  // mutated here. Frequent triggers signal client-side prompt drift and
  // a need to revisit the agent template. Fire-and-forget so the hot send
  // path is unaffected; failures are logged but never propagated.
  void observeLoopPattern(db, chatId).catch((err) => {
    log.error({ err, chatId }, "loop pattern observation failed");
  });

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

export const LOOP_OBSERVATION_WINDOW = 4;
export const LOOP_OBSERVATION_SHORT_CHARS = 10;
export const LOOP_OBSERVATION_TIME_WINDOW_MS = 30_000;

function stripMentionPrefix(content: string): string {
  return content.replace(/^(@\S+\s*)+/, "").trim();
}

/**
 * Reporting hook: what to do when a loop pattern is detected. Production
 * default goes through pino's structured `warn`; tests pass a fake so they
 * can assert on detection without raising the test app's log level (helpers
 * pin level=error for noise reduction).
 */
export type LoopPatternObserver = (data: {
  chatId: string;
  recentMessageIds: string[];
  windowSpanMs: number;
  contentLengths: number[];
}) => void;

const defaultLoopObserver: LoopPatternObserver = (data) => {
  log.warn(
    { metric: "loop_pattern_observed_total", ...data },
    "loop pattern observed (not blocked) — prompt discipline may be drifting",
  );
};

/**
 * Pure observation: detect short, fast, two-agent ping-pong reply chains and
 * surface them via a structured log line. Does NOT modify the `notify` flag
 * or otherwise interfere with delivery — loop *prevention* lives client-side
 * (prompt + silent-turn protocol in `result-sink`). Six conjunctive
 * conditions (see design `agent-reply-loop-prevention-design.md` §3.4) so
 * normal multi-agent collaboration is never flagged:
 *
 *   C1 — every message is `format=text`
 *   C2 — no human sender in the window (any human reply resets the chain)
 *   C3 — exactly two senders, perfectly alternating
 *   C4 — strict `inReplyTo` chain across the whole window
 *   C5 — every message body (after stripping leading `@<name>` tokens) is
 *        ≤ `LOOP_OBSERVATION_SHORT_CHARS` characters
 *   C6 — the whole window spans ≤ `LOOP_OBSERVATION_TIME_WINDOW_MS` ms
 *
 * Exported for direct test coverage of the detection logic; the `sendMessage`
 * call site uses the default observer.
 */
export async function observeLoopPattern(
  db: Database,
  chatId: string,
  observer: LoopPatternObserver = defaultLoopObserver,
): Promise<void> {
  const window = await db
    .select({
      id: messages.id,
      senderId: messages.senderId,
      content: messages.content,
      inReplyTo: messages.inReplyTo,
      createdAt: messages.createdAt,
      format: messages.format,
      senderType: agents.type,
    })
    .from(messages)
    .innerJoin(agents, eq(messages.senderId, agents.uuid))
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt))
    .limit(LOOP_OBSERVATION_WINDOW);

  if (window.length < LOOP_OBSERVATION_WINDOW) return;

  // C1: all text format
  if (window.some((m) => m.format !== "text")) return;
  // C2: no human sender (any human turn naturally breaks the chain)
  if (window.some((m) => m.senderType === "human")) return;
  // C3: exactly two distinct senders, strictly alternating
  if (new Set(window.map((m) => m.senderId)).size !== 2) return;
  for (let i = 0; i < window.length - 1; i++) {
    if (window[i]?.senderId === window[i + 1]?.senderId) return;
  }
  // C4: strict reply chain — each newer message replies to the one beneath it
  for (let i = 0; i < window.length - 1; i++) {
    if (window[i]?.inReplyTo !== window[i + 1]?.id) return;
  }
  // C5: every body short after stripping mention prefix. Non-string contents
  //     (markdown JSON, file/card payloads, etc.) can't be classified by a
  //     simple char count, so we bail rather than guess.
  const lens: number[] = [];
  for (const m of window) {
    const text = typeof m.content === "string" ? m.content : null;
    if (text === null) return;
    const len = stripMentionPrefix(text).length;
    if (len > LOOP_OBSERVATION_SHORT_CHARS) return;
    lens.push(len);
  }
  // C6: tight time window across the whole tail
  const newest = window[0];
  const oldest = window[window.length - 1];
  if (!newest || !oldest) return;
  const spanMs = newest.createdAt.getTime() - oldest.createdAt.getTime();
  if (spanMs > LOOP_OBSERVATION_TIME_WINDOW_MS) return;

  observer({
    chatId,
    recentMessageIds: window.map((m) => m.id),
    windowSpanMs: spanMs,
    contentLengths: lens,
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
