import { z } from "zod";

/**
 * First-frame auth envelope sent by the SDK on the client WS connection.
 * The server rejects the connection with close code 4401 if this frame does
 * not arrive within {@link WS_AUTH_FRAME_TIMEOUT_MS} or fails verification.
 */
export const wsAuthFrameSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});
export type WsAuthFrame = z.infer<typeof wsAuthFrameSchema>;

/** How long the server waits for the first `auth` frame before closing the WS. */
export const WS_AUTH_FRAME_TIMEOUT_MS = 5_000;
