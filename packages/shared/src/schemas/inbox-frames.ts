import { z } from "zod";
import { clientMessageSchema } from "./message.js";

/**
 * server → client: a single inbox entry pushed over the active WS connection,
 * replacing the legacy `new_message` doorbell + HTTP `/inbox` poll round-trip.
 *
 * `entryId` is the server-side `inbox_entries.id` the client must echo back
 * in `inbox:ack`. `message` is exactly what the legacy poll path returned —
 * `clientMessageSchema` already carries `precedingMessages`, so the client-
 * side dispatch logic is reused verbatim (see proposal
 * hub-inbox-ws-data-plane §3.1).
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
 * client → server: ack for an `inbox:deliver` frame. Replaces the legacy
 * `POST /inbox/:id/ack` HTTP endpoint when the WS data plane is active.
 */
export const inboxAckFrameSchema = z.object({
  type: z.literal("inbox:ack"),
  entryId: z.number().int().nonnegative(),
});
export type InboxAckFrame = z.infer<typeof inboxAckFrameSchema>;
