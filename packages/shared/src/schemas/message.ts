import { z } from "zod";

// -- Message Source (which entry point created this message) --

/**
 * Entry point that produced this message. Required (NOT NULL) after v2 —
 * every write path must declare its caller-stack origin so observability /
 * loop / egress diagnostics can join on it.
 *
 *   - "web"     — Hub web UI (POST /chats/:id/messages from a browser
 *                 session; includes AskUserQuestion answers submitted via
 *                 the web UI).
 *   - "cli"     — Agent's `first-tree-hub` CLI (`chat send` / `chat invite`
 *                 / etc.).
 *   - "api"     — Agent SDK direct API call (incl. result-sink auto-forward,
 *                 in-process tool integrations, AskUserQuestion publish);
 *                 the catch-all for client runtime-initiated writes that
 *                 aren't typed via the CLI.
 *   - "feishu"  — Inbound message bridged from a Feishu adapter.
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
  FEISHU: "feishu",
  GITHUB: "github",
  API: "api",
} as const;

export const messageSourceSchema = z.enum(["web", "cli", "feishu", "github", "api"]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

export const MESSAGE_FORMATS = {
  TEXT: "text",
  MARKDOWN: "markdown",
  CARD: "card",
  REFERENCE: "reference",
  FILE: "file",
  /** Agent → user structured ask-user prompt. Content shape: QuestionMessageContent (see schemas/question.ts). */
  QUESTION: "question",
  /** User → agent answer to a prior question. Content shape: QuestionAnswerMessageContent (see schemas/question.ts). */
  QUESTION_ANSWER: "question_answer",
} as const;

export const messageFormatSchema = z.enum([
  "text",
  "markdown",
  "card",
  "reference",
  "file",
  "question",
  "question_answer",
]);
export type MessageFormat = z.infer<typeof messageFormatSchema>;

/**
 * Optional intent tag set by the client when posting through
 * `POST /agent/chats/:id/messages`. Tells the server *why* this write is
 * happening so it can pick the right enforcement profile.
 *
 *   - `"agent-final-text"`: handler-initiated forward of an agent's final
 *     reply text (today: `runtime/result-sink.ts`) OR an `AskUserQuestion`
 *     payload posted via the canUseTool bridge. Both should land in chat
 *     history so human observers in the web UI can see what the agent is
 *     doing, but neither should wake other agents and neither should be
 *     subject to the group-chat `@mention required` guard — they are not
 *     a user-typed group broadcast. v1 §四 改造 4 (b) bypass channel.
 *
 * Default-`undefined` means a regular agent-initiated send (CLI `chat send`,
 * adapter, etc.) and goes through the normal enforcement profile.
 */
export const messagePurposeSchema = z.enum(["agent-final-text"]);
export type MessagePurpose = z.infer<typeof messagePurposeSchema>;

// -- Message attachments (A′: no new `format`; attachments ride `metadata.attachments`) --

/**
 * Reference to a file attached to a message. The bytes live server-side in
 * `message_attachments` (PG bytea, see proposals/hub-message-text-attachments);
 * the message itself only carries this reference under `metadata.attachments[]`.
 * There is no base64 and no client-local id here — clients fetch the bytes on
 * demand from `GET /chats/:chatId/attachments/:attachmentId` with their normal
 * auth (web JWT / agent token).
 *
 * A message with `metadata.attachments` is a *regular* text/markdown message
 * whose `content` string is the caption (may be empty for an attachment-only
 * send). This keeps old readers gracefully degrading — they render the caption
 * and ignore the attachments — and keeps the @mention guard on the existing
 * text path.
 */
export const attachmentRefSchema = z.object({
  attachmentId: z.string().uuid(),
  mimeType: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Render/delivery split (image → thumbnail/vision, file → card/Read). */
  kind: z.enum(["image", "file"]),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/** Shape of the `metadata.attachments` field carried on a message. */
export const messageAttachmentsMetadataSchema = z.object({
  attachments: z.array(attachmentRefSchema),
});

/**
 * Single source of truth for the image/file split. Server stamps it on upload,
 * web/runtime read it back — call this everywhere instead of re-deriving from
 * `mimeType` ad hoc so the two sides can never drift.
 */
export function deriveAttachmentKind(mimeType: string): "image" | "file" {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/**
 * Read A′ attachment refs off a message's metadata, or [] when none. Single
 * call site for `messageAttachmentsMetadataSchema.safeParse(...).data.attachments`
 * — server adapter / web renderer / agent runtime all consume the same shape,
 * so a shared helper prevents the parse + fallback from drifting across them.
 */
export function getMessageAttachments(metadata: unknown): AttachmentRef[] {
  const parsed = messageAttachmentsMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.attachments : [];
}

/**
 * Metadata keys that are **server-managed**: the server stamps them on writes,
 * clients must never set them. Listed here as the single source of truth so
 * `stripUntrustedMetadataKeys` is the only place that needs to know about new
 * server-managed keys — adding one to the set is enough to plug it across
 * every write path that consumes client-supplied metadata.
 *
 *   - `attachments` — folded in from `attachmentIds` after C3 validation
 *     (server/services/message.ts:sendMessage + prepareAttachmentsForSend).
 *   - `editedAt`    — stamped on edits (server/services/message.ts:editMessage).
 *
 * NOTE: this is the **defensive-strip set**, not a complete inventory of
 * every metadata key the platform uses. Client-trusted keys (`mentions`,
 * `documentContext`, ...) intentionally are not listed — they go through
 * their own validation paths.
 */
export const SERVER_MANAGED_METADATA_KEYS = new Set<string>(["attachments", "editedAt"]);

/**
 * Return a shallow copy of `metadata` with every {@link SERVER_MANAGED_METADATA_KEYS}
 * key removed. Use this at every write path that accepts caller-supplied
 * metadata so a client cannot forge server-stamped fields (e.g. C3 forged
 * `metadata.attachments`). Centralised so future server-managed keys only
 * need to be added to the set above.
 */
export function stripUntrustedMetadataKeys(metadata: Record<string, unknown>): Record<string, unknown> {
  const result = { ...metadata };
  for (const key of SERVER_MANAGED_METADATA_KEYS) {
    delete result[key];
  }
  return result;
}

export const sendMessageSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  inReplyTo: z.string().optional(),
  /**
   * Required output (NOT NULL in `messages.source`). The Zod `.default("api")`
   * lets HTTP request bodies omit the field — Hub's pre-v2 HTTP clients still
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
  /**
   * Ids of files previously uploaded via `POST /chats/:id/attachments` to
   * attach to this message. The server validates ownership/binding (C3) and
   * folds the authoritative refs into the stored `metadata.attachments` — the
   * message stays a regular text/markdown message (A′). Caption goes in
   * `content` and may be empty for an attachment-only send.
   */
  attachmentIds: z.array(z.string().uuid()).optional(),
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
 * Wire format for messages routed FROM the Hub TO a client runtime.
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
  // Without `.catch`, the strict enum rejects the whole inbox frame, which
  // forces a 300s reaper round-trip before re-delivery — and that retry
  // hits the same schema mismatch, so the entry exhausts retryCount and
  // is effectively lost. Degrading unknown values to `null` keeps the
  // frame parseable so the handler still receives the message body; only
  // the audit-trail `source` label is lost. Mirrors the
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
