import { z } from "zod";

// -- Message Source (which entry point created this message) --

export const MESSAGE_SOURCES = {
  HUB_UI: "hub_ui",
  CLI: "cli",
  FEISHU: "feishu",
  GITHUB: "github",
  API: "api",
} as const;

export const messageSourceSchema = z.enum(["hub_ui", "cli", "feishu", "github", "api"]);
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

export const sendMessageSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  inReplyTo: z.string().optional(),
  source: messageSourceSchema.optional(),
  purpose: messagePurposeSchema.optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const sendToAgentSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: messageSourceSchema.optional(),
});
export type SendToAgent = z.infer<typeof sendToAgentSchema>;

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
  recipientMode: participantModeSchema.default("full"),
  precedingMessages: z.array(precedingMessageSchema).default([]),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;
