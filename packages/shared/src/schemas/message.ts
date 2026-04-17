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
 * Wire format for messages routed FROM the Hub TO a client runtime.
 *
 * Adds `configVersion` so the client can compare against its locally cached
 * agent runtime config and refresh before delivering the message to the SDK.
 *
 * Step 3: this is the single shape used by `buildClientMessagePayload` —
 * never serialise a raw `messageSchema` row to a client; always go through
 * the dispatcher.
 */
export const clientMessageSchema = messageSchema.extend({
  configVersion: z.number().int().positive(),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;
