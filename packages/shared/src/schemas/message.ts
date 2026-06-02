import { z } from "zod";

// -- Message Source (which entry point created this message) --

/**
 * Entry point that produced this message. Required (NOT NULL) after v2 —
 * every write path must declare its caller-stack origin so observability /
 * loop / egress diagnostics can join on it.
 *
 *   - "web"     — First Tree web UI (POST /chats/:id/messages from a browser
 *                 session).
 *   - "cli"     — Agent's `first-tree` CLI (`chat send` / `chat invite`
 *                 / etc.).
 *   - "api"     — Agent SDK direct API call (incl. result-sink auto-forward,
 *                 in-process tool integrations); the catch-all for client
 *                 runtime-initiated writes that aren't typed via the CLI.
 *   - "github"  — Inbound message bridged from a GitHub webhook.
 *
 * NOT a behaviour discriminator — use `purpose` for that (e.g. distinguishing
 * a CLI-typed agent send from a result-sink auto-forward, both of which may
 * carry source='api'/'cli'). `source` is the caller-stack origin, intended
 * for observability and loop / egress diagnostics.
 */
export const MESSAGE_SOURCES = {
  WEB: "web",
  CLI: "cli",
  GITHUB: "github",
  API: "api",
} as const;

export const messageSourceSchema = z.enum(["web", "cli", "github", "api"]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

export const MESSAGE_FORMATS = {
  TEXT: "text",
  MARKDOWN: "markdown",
  CARD: "card",
  REFERENCE: "reference",
  FILE: "file",
} as const;

export const messageFormatSchema = z.enum(["text", "markdown", "card", "reference", "file"]);
export type MessageFormat = z.infer<typeof messageFormatSchema>;

/**
 * Optional intent tag set by the client when posting through
 * `POST /agent/chats/:id/messages`. Tells the server *why* this write is
 * happening so it can pick the right enforcement profile.
 *
 *   - `"agent-final-text"`: handler-initiated forward of an agent's final
 *     reply text (today: `runtime/result-sink.ts`). Lands in chat history
 *     so human observers in the web UI can see what the agent is doing,
 *     but does not wake other agents and is not subject to the group-chat
 *     `@mention required` guard — it is not a user-typed group broadcast.
 *     v1 §四 改造 4 (b) bypass channel.
 *
 * Default-`undefined` means a regular agent-initiated send (CLI `chat send`,
 * adapter, etc.) and goes through the normal enforcement profile.
 */
export const messagePurposeSchema = z.enum(["agent-final-text"]);
export type MessagePurpose = z.infer<typeof messagePurposeSchema>;

export const sendMessageSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  inReplyTo: z.string().optional(),
  /**
   * Required output (NOT NULL in `messages.source`). The Zod `.default("api")`
   * lets HTTP request bodies omit the field — pre-v2 HTTP clients still
   * send messages without `source`, and a deploy that suddenly 422'd those
   * requests would be a needless coupling break. The default fills in for
   * those callers; in-process TS callers go through `z.infer<>` (= the
   * `SendMessage` type), where `source` is structurally required and must be
   * passed explicitly so a forgotten value surfaces as a compile error
   * rather than silently labelling everything `'api'`.
   */
  source: messageSourceSchema.default("api"),
  purpose: messagePurposeSchema.optional(),
  /**
   * Recipient agent names that the server should resolve to uuids against
   * the chat's participant list and add to the message's `mentions`. Lets
   * a caller who knows the recipient by name (CLI `chat send <name>`,
   * tool integrations, etc.) declare routing intent without having to
   * pre-resolve uuids client-side. Server cross-validates each name
   * against the chat's speakers — an unknown name fails the write with
   * a hint pointing at `chat invite`. Agent-typed clients should always
   * prefer this over relying on `@<name>` extraction from `content`.
   */
  receiverNames: z.array(z.string().min(1)).optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const messageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  senderId: z.string(),
  format: z.string(),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  inReplyTo: z.string().nullable(),
  source: messageSourceSchema.nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

/** Per-chat participation mode exposed to the recipient runtime. */
export const participantModeSchema = z.enum(["full", "mention_only"]);
export type ParticipantMode = z.infer<typeof participantModeSchema>;

/**
 * Lightweight snapshot of an earlier message in the same chat that the
 * recipient missed (because it was `mention_only` + not @mentioned). Server
 * attaches a list of these to the next active delivery in the chat so the
 * agent's prompt carries enough context to reply meaningfully.
 *
 * Smaller than `messageSchema` on purpose — drops fields that don't help the
 * LLM (replyTo envelopes, source) and aren't safe to leak across recipients.
 */
export const precedingMessageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  format: z.string(),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type PrecedingMessage = z.infer<typeof precedingMessageSchema>;

/**
 * Wire format for messages routed FROM the server TO a client runtime.
 *
 * Adds `configVersion` so the client can compare against its locally cached
 * agent runtime config and refresh before delivering the message to the SDK.
 *
 * Step 3: this is the single shape used by `buildClientMessagePayload` —
 * never serialise a raw `messageSchema` row to a client; always go through
 * the dispatcher.
 *
 * `recipientMode` is the receiving agent's own mode in the entry's chat —
 * `mention_only` participants must only start a session when they appear in
 * `metadata.mentions` (see session-manager.ts).
 *
 * `precedingMessages` is a (possibly empty) list of older messages in the
 * same chat that this recipient did not previously receive (silent inbox
 * context). The runtime renders them as "earlier in chat" before the
 * triggering message — see proposals/group-chat-ux-improvements §1.
 */
export const clientMessageSchema = messageSchema.extend({
  configVersion: z.number().int().positive(),
  // Forward-roll defence: the server may push new source values before the
  // client ships the matching enum update (e.g. a new adapter is added).
  // Without `.catch`, the strict enum rejects the whole inbox frame; the
  // entry stays `delivered` server-side and every subsequent `agent:bind`
  // resets it back to `pending` and re-pushes the same un-parseable frame
  // (see inflight-message-recovery-design.md §4). That loop only ends when
  // the client process restarts (dedup window clears + this build is still
  // out of date so the row would re-loop), the deploy ships the matching
  // enum update, or a `session:terminate` clears the row — none of which
  // a reader of "chat was restarted" would expect. Degrading unknown values
  // to `null` keeps the frame parseable so the handler still receives the
  // message body; only the audit-trail `source` label is lost. Mirrors the
  // inboxDeliverFrameSchema `.passthrough()` policy for top-level fields.
  //
  // Scope: `.catch` is field-scoped — it fires for ANY shape mismatch on
  // `source` (unknown enum value, wrong type like `12345`, missing /
  // undefined), not just enum drift. Acceptable because `source` is a
  // pure audit label that handlers never branch on. Other fields' parse
  // errors still bubble up to the parent `safeParse`, so required-shape
  // drift on id / chatId / format is NOT silently swallowed.
  source: messageSourceSchema.nullable().catch(null),
  recipientMode: participantModeSchema.default("full"),
  precedingMessages: z.array(precedingMessageSchema).default([]),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;
