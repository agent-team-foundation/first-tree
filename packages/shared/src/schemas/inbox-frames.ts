import { z } from "zod";
import { clientMessageSchema } from "./message.js";

/**
 * server → client: a single inbox entry pushed over the active WS connection.
 *
 * `entryId` is the server-side `inbox_entries.id` the client must echo back
 * in `inbox:ack`. `clientMessageSchema` carries `precedingMessages`, so the
 * client-side dispatch logic handles the silent-context bundle uniformly.
 *
 * `.passthrough()` so a forward-rolling server may extend the frame without
 * breaking older clients that validate strictly. Older clients drop unknown
 * fields silently.
 */
export const inboxDeliverFrameSchema = z
  .object({
    type: z.literal("inbox:deliver"),
    entryId: z.number().int().nonnegative(),
    inboxId: z.string().min(1),
    chatId: z.string().nullable(),
    message: clientMessageSchema,
  })
  .passthrough();
export type InboxDeliverFrame = z.infer<typeof inboxDeliverFrameSchema>;

/**
 * client → server: ack for an `inbox:deliver` frame.
 */
export const inboxAckFrameSchema = z.object({
  type: z.literal("inbox:ack"),
  entryId: z.number().int().nonnegative(),
  ref: z.string().min(1).optional(),
});
export type InboxAckFrame = z.infer<typeof inboxAckFrameSchema>;

export const inboxAckAcceptedDispositionSchema = z.enum(["acked", "already_acked", "accepted_from_pending"]);
export type InboxAckAcceptedDisposition = z.infer<typeof inboxAckAcceptedDispositionSchema>;

export const inboxAckRejectedReasonSchema = z.enum([
  "not_found_or_not_bound",
  "failed_or_dead",
  "non_notify",
  "prefix_gap",
]);
export type InboxAckRejectedReason = z.infer<typeof inboxAckRejectedReasonSchema>;

export const inboxAckAcceptedFrameSchema = z.object({
  type: z.literal("inbox:ack:accepted"),
  entryId: z.number().int().nonnegative(),
  ref: z.string().min(1),
  disposition: inboxAckAcceptedDispositionSchema,
  ackedCount: z.number().int().nonnegative().optional(),
});
export type InboxAckAcceptedFrame = z.infer<typeof inboxAckAcceptedFrameSchema>;

export const inboxAckRejectedFrameSchema = z.object({
  type: z.literal("inbox:ack:rejected"),
  entryId: z.number().int().nonnegative(),
  ref: z.string().min(1),
  reason: inboxAckRejectedReasonSchema,
});
export type InboxAckRejectedFrame = z.infer<typeof inboxAckRejectedFrameSchema>;

/**
 * client → server: ask the server to reset delivered-but-unacked entries for
 * one chat back to pending so the active socket can redeliver them.
 */
export const inboxRecoverFrameSchema = z.object({
  type: z.literal("inbox:recover"),
  ref: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
});
export type InboxRecoverFrame = z.infer<typeof inboxRecoverFrameSchema>;

export const inboxRecoverRejectedReasonSchema = z.enum(["agent_not_bound", "chat_id_required", "recover_failed"]);
export type InboxRecoverRejectedReason = z.infer<typeof inboxRecoverRejectedReasonSchema>;

export const inboxRecoverAcceptedFrameSchema = z.object({
  type: z.literal("inbox:recover:accepted"),
  ref: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  resetCount: z.number().int().nonnegative(),
});
export type InboxRecoverAcceptedFrame = z.infer<typeof inboxRecoverAcceptedFrameSchema>;

export const inboxRecoverRejectedFrameSchema = z.object({
  type: z.literal("inbox:recover:rejected"),
  ref: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1).optional(),
  reason: inboxRecoverRejectedReasonSchema,
});
export type InboxRecoverRejectedFrame = z.infer<typeof inboxRecoverRejectedFrameSchema>;
