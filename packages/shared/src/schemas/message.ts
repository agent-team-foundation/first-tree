import { z } from "zod";

export const MESSAGE_FORMATS = {
  TEXT: "text",
  MARKDOWN: "markdown",
  CARD: "card",
  REFERENCE: "reference",
  FILE: "file",
} as const;

export const messageFormatSchema = z.enum(["text", "markdown", "card", "reference", "file"]);
export type MessageFormat = z.infer<typeof messageFormatSchema>;

export const sendMessageSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
  inReplyTo: z.string().optional(),
  replyToInbox: z.string().optional(),
  replyToChat: z.string().optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const messageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  senderId: z.string(),
  format: z.string(),
  content: z.unknown(),
  metadata: z.record(z.unknown()),
  replyToInbox: z.string().nullable(),
  replyToChat: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;
