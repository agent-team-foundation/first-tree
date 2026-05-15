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
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { AgentSendNonMemberError, BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger, messageAttrs, withSpan } from "../observability/index.js";
import { upsertSessionState } from "./activity.js";
import { findOrCreateDirectChat, isParticipant } from "./chat.js";
import { applyAfterFanOut, fireChatMessageKick } from "./chat-projection.js";
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
          agentId: chatMembership.agentId,
          inboxId: agents.inboxId,
          mode: chatMembership.mode,
          name: agents.name,
        })
        .from(chatMembership)
        .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
        .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker"))),
      tx.select({ type: chats.type }).from(chats).where(eq(chats.id, chatId)).limit(1),
      tx
        .select({ inboxId: agents.inboxId, organizationId: agents.organizationId, type: agents.type })
        .from(agents)
        .where(eq(agents.uuid, senderId))
        .limit(1),
    ]);
    const chatType = chatRow?.type ?? null;
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
    const contentText = typeof effectiveContent === "string" ? effectiveContent : "";
    const resolved = contentText ? extractMentions(contentText, participants) : [];
    const mergedMentions = [...new Set([...explicitMentions, ...resolved])];
    const metadataToStore = mergedMentions.length > 0 ? { ...incomingMeta, mentions: mergedMentions } : incomingMeta;

    // Direct-chat auto-mention for the unread-counter projection (chat-first
    // workspace). In a 1-on-1 the recipient is implicit, so the conversation
    // list should red-dot every DM message — without this, `extractMentions`
    // returns [] on plain text and `applyAfterFanOut` short-circuits the
    // counter bump, leaving DM rows at zero unread.
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
    const dmAutoProjection: string[] =
      chatType === "direct"
        ? [...new Set([...mergedMentions, ...participants.filter((p) => p.agentId !== senderId).map((p) => p.agentId)])]
        : mergedMentions;

    // 2b. Group-chat receiver enforcement (agent-only). Stop a misuse where an
    //     agent calls `send --chat <id>` against a group without naming who
    //     should pick it up — every mention_only participant would silently
    //     drop the message and the sender would assume delivery.
    //     Uses the chat type pre-fetched in step 1 so this stays cheap.
    //
    //     `purpose === "agent-final-text"` bypasses this guard: the message
    //     is a handler-initiated forward (result-sink final text, or an
    //     AskUserQuestion payload posted via canUseTool), not a user-typed
    //     broadcast. It still has to land in chat history so human
    //     observers in the web UI can see what the agent is doing — but
    //     every fan-out row is forced to `notify=false` further down so it
    //     never wakes another session. v1 §四 改造 4 (b) bypass channel.
    const isAgentFinalText = data.purpose === "agent-final-text";
    if (options.enforceGroupMention && chatType === "group" && !isAgentFinalText) {
      const recipientMentions = mergedMentions.filter((id) => id !== senderId);
      if (recipientMentions.length === 0) {
        throw new BadRequestError(
          "Sending to a group chat requires an explicit @mention. " +
            "Use `first-tree-hub chat send <name>` to message a single agent, or @<name> in the content to address one or more group members.",
        );
      }
    }

    // 2b.1. Unresolved-@-token guard (agent path). v1 §四 改造 1 follow-up:
    //
    //   Closes the foot-gun where an agent typed `@<name>` for someone who
    //   is not a speaker of THIS chat. `extractMentions` silently returns
    //   only resolved hits, so the misrouted message used to land with
    //   `mentions=[]` and never wake the intended recipient (issue from
    //   PR #393 manual dogfood). With `enforceGroupMention` the group
    //   branch above caught it, but the *direct-chat* path used to slip
    //   through — exactly how baixiaohang-assistant's "@tester" in a 2-way
    //   chat ended up silent-dropped.
    //
    //   New behaviour: when this hook is active (agent path), every raw
    //   `@<token>` in the content must resolve to a speaker. Unresolved
    //   tokens → 400 with a remedy hint pointing at `--direct <name>` /
    //   ask a human to add them. Code-fenced `@` tokens are already
    //   stripped by `scanMentionTokens` upstream, so legitimate quoted
    //   `@<name>` in code blocks is unaffected.
    //
    //   `purpose === "agent-final-text"` bypasses for the same reason it
    //   bypasses enforceGroupMention: handler-initiated forwards are not
    //   user-typed routing requests.
    if (options.enforceGroupMention && !isAgentFinalText && typeof effectiveContent === "string") {
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
              `Use \`first-tree-hub chat send --direct ${sample} "..."\` to message them in a side conversation, ` +
              "or ask a human in this chat to add them as a participant first.",
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
        { chatId, senderId, source: data.source ?? null },
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
        replyToInbox: data.replyToInbox ?? null,
        replyToChat: data.replyToChat ?? null,
        inReplyTo: data.inReplyTo ?? null,
        source: data.source ?? null,
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
        // Silent-send (step 2e) AND agent-final-text (step 2b bypass) both
        // force every fan-out row to notify=false regardless of mode /
        // mentions. Inbox entries are still written so history replay still
        // works; nobody is woken.
        // `addressedToAgentIds` widens the notify set within the non-silenced
        // branch — see option doc on `SendMessageOptions`.
        notify:
          !isSilentSend &&
          !isAgentFinalText &&
          (addressedSet.has(p.agentId) || p.mode !== "mention_only" || mentionSet.has(p.agentId)),
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
        // Cross-chat replyTo: when message N has `replyToInbox = X` +
        // `replyToChat = C`, every reply (`inReplyTo = N`) gets a duplicate
        // inbox row routed back to X in C. This is the delegation-closure
        // primitive: A in c1 delegates to B in c2 → B's reply must wake A
        // in c1 so the user-facing thread can continue. The flag is the
        // original sender's promise; the reply path has to honor it.
        //
        // Mirror silent-send (§2e) into this route — a silent message has
        // zero notify=true inbox rows by definition; leaking notify=true
        // through this back-channel would break that invariant.
        //
        // **Do NOT** mirror `isAgentFinalText` (§四 改造 4 b bypass) here.
        // Bypass's intent is "final text doesn't wake chat-internal peers"
        // (correct for c2 fan-out). But the replyTo cross-chat route is
        // delegation-closure, not chat-internal peer wake — silencing it
        // strands B's reply in c2 and breaks the whole delegation loop.
        // Empirically caught in PR #393 v1.7 dogfood: A in c1 → asks B in
        // c2 → B's final text → cross-chat route went notify=false → A
        // never woke in c1 → A "continued in c2" because that's the only
        // path that surfaced anything. Fix: replyTo cross-chat is governed
        // by silent-send only.
        const replyNotify = !isSilentSend;
        await tx
          .insert(inboxEntries)
          .values({
            inboxId: original.replyToInbox,
            messageId,
            chatId: original.replyToChat,
            notify: replyNotify,
          })
          .onConflictDoNothing();

        // Only surface as a wake-up target when not silenced — `recipients`
        // is what the route layer turns into PG NOTIFY wake-ups.
        if (replyNotify && !recipients.includes(original.replyToInbox)) {
          recipients.push(original.replyToInbox);
        }
      }
    }

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
    // Agents routinely pick up uuids from `chat list` / chat participant
    // lists and mistakenly paste them as the send target. Give the hint in
    // the error so the next LLM attempt self-corrects.
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetName);
    const hint = looksLikeUuid
      ? " — `first-tree-hub chat send` expects an agent NAME, not a uuid. Run `first-tree-hub agent list` to see available names."
      : "";
    throw new NotFoundError(`Agent "${targetName}" not found${hint}`);
  }

  // Build the merged-mentions metadata once — both the current-chat routing
  // branch and the direct-chat fallback need the receiver in `metadata.mentions`
  // so sendMessage's step 2c will prepend `@<name>` to the content.
  const incomingMeta = (data.metadata ?? {}) as Record<string, unknown>;
  const existingMentionsRaw = incomingMeta.mentions;
  const existingMentions = Array.isArray(existingMentionsRaw)
    ? existingMentionsRaw.filter((m): m is string => typeof m === "string")
    : [];
  const mergedMentions = existingMentions.includes(target.uuid) ? existingMentions : [...existingMentions, target.uuid];
  const metadata = { ...incomingMeta, mentions: mergedMentions };

  // Routing (v1 §四 改造 1):
  //
  //   - If the caller is sitting in a chat (CLI auto-injects
  //     `FIRST_TREE_HUB_CHAT_ID` into `replyToChat` via resolveReplyToFromEnv)
  //     AND BOTH sender and target are participants of that chat, deliver
  //     the message there.
  //   - Otherwise, if `data.direct === true`, fall through to the
  //     find-or-create-direct-chat path (the legacy implicit fallback,
  //     now explicit and opt-in).
  //   - Otherwise, refuse with `AGENT_SEND_NON_MEMBER` + a hint. Implicit
  //     side-channel chats are exactly the #311 trap we are closing.
  //
  // BOTH ends are membership-checked because `replyToChat` is caller-supplied
  // (env or explicit flag); the /agent/chats/:id/messages path enforces
  // sender membership via assertParticipant — this routing branch must hold
  // the same invariant or it becomes a write-anywhere primitive.
  if (data.replyToChat) {
    const [targetIsMember, senderIsMember] = await Promise.all([
      isParticipant(db, data.replyToChat, target.uuid),
      isParticipant(db, data.replyToChat, senderUuid),
    ]);
    if (targetIsMember && senderIsMember) {
      return sendMessage(
        db,
        data.replyToChat,
        senderUuid,
        {
          format: data.format,
          content: data.content,
          metadata,
          // The message lands in replyToChat itself, so the reply-routing
          // envelope is redundant — strip it so future replies fan out via
          // normal participant rules instead of self-referencing.
          replyToInbox: undefined,
          replyToChat: undefined,
          source: data.source,
        },
        { normalizeMentionsInContent: true },
      );
    }
  }

  if (!data.direct) {
    throw new AgentSendNonMemberError(
      `Agent "${targetName}" is not a member of your current chat. ` +
        "Either open or reuse a side-conversation explicitly with " +
        `\`first-tree-hub chat send --direct ${targetName} "..."\`, ` +
        `or ask a human in this chat to add ${targetName} as a participant.`,
    );
  }

  // Direct-chat fallback: only reachable when the caller passed `direct=true`.
  const chat = await findOrCreateDirectChat(db, senderUuid, target.uuid);

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
