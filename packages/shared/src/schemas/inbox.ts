import { z } from "zod";
import { clientMessageSchema } from "./message.js";

export const INBOX_ENTRY_STATUSES = {
  PENDING: "pending",
  DELIVERED: "delivered",
  ACKED: "acked",
} as const;

export const inboxEntryStatusSchema = z.enum(["pending", "delivered", "acked"]);
export type InboxEntryStatus = z.infer<typeof inboxEntryStatusSchema>;

export const inboxEntrySchema = z.object({
  id: z.number(),
  inboxId: z.string(),
  messageId: z.string(),
  chatId: z.string().nullable(),
  status: inboxEntryStatusSchema,
  retryCount: z.number(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  ackedAt: z.string().nullable(),
});
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const inboxEntryWithMessageSchema = inboxEntrySchema.extend({
  message: clientMessageSchema,
});
export type InboxEntryWithMessage = z.infer<typeof inboxEntryWithMessageSchema>;

export const inboxPollQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type InboxPollQuery = z.infer<typeof inboxPollQuerySchema>;
