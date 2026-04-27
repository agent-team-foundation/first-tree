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
  /** System-generated task notification. Content shape: TaskMessageContent (see schemas/task.ts). */
  TASK: "task",
} as const;

export const messageFormatSchema = z.enum(["text", "markdown", "card", "reference", "file", "task"]);
export type MessageFormat = z.infer<typeof messageFormatSchema>;

export const sendMessageSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  inReplyTo: z.string().optional(),
  replyToInbox: z.string().optional(),
  replyToChat: z.string().optional(),
  source: messageSourceSchema.optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const sendToAgentSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  replyToInbox: z.string().optional(),
  replyToChat: z.string().optional(),
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
  replyToInbox: z.string().nullable(),
  replyToChat: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  source: messageSourceSchema.nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

/**
 * Snapshot of the `in_reply_to` target that the server materialises at
 * dispatch time so the receiving runtime can decide whether this is an
 * echo it should suppress (see proposal hub-agent-messaging-reply-and-mentions).
 *
 * `chatId` is the original message's `chat_id`; `replyToChat` is the chat
 * its sender expected replies to flow back to (often a different chat).
 * `null` when the message is not a reply, or the original could not be
 * resolved (e.g. deleted).
 */
export const inReplyToSnapshotSchema = z
  .object({
    senderId: z.string(),
    chatId: z.string(),
    replyToChat: z.string().nullable(),
  })
  .nullable();
export type InReplyToSnapshot = z.infer<typeof inReplyToSnapshotSchema>;

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
 * `inReplyToSnapshot` is populated when `inReplyTo` resolves to an existing
 * message; runtime uses it to suppress self-reply echo on direct chats.
 *
 * `precedingMessages` is a (possibly empty) list of older messages in the
 * same chat that this recipient did not previously receive (silent inbox
 * context). The runtime renders them as "earlier in chat" before the
 * triggering message — see proposals/group-chat-ux-improvements §1.
 */
export const clientMessageSchema = messageSchema.extend({
  configVersion: z.number().int().positive(),
  recipientMode: participantModeSchema.default("full"),
  inReplyToSnapshot: inReplyToSnapshotSchema.default(null),
  precedingMessages: z.array(precedingMessageSchema).default([]),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;
