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

/**
 * Negotiable wire-protocol features the server advertises in its `welcome`
 * frame. Older clients drop the `capabilities` field silently because the
 * frame is `.passthrough()`. New clients gate optional code paths on it —
 * absent ⇒ feature off, never assumed.
 */
export const serverCapabilitiesSchema = z
  .object({
    /**
     * Server pushes inbox entries as `inbox:deliver` WS frames and accepts
     * `inbox:ack` over the same socket, instead of relying on the client's
     * 5s HTTP poll + `POST /inbox/:id/ack`. See proposal
     * hub-inbox-ws-data-plane §3.6.
     */
    wsInboxDeliver: z.boolean().default(false),
  })
  .partial();
export type ServerCapabilities = z.infer<typeof serverCapabilitiesSchema>;

/**
 * Advisory frame sent server → client immediately after `auth:ok`. It carries
 * the Command-package version the server was bundled with, so the client can
 * detect version drift on startup and on each reconnect. `.passthrough()` so
 * future server versions may add fields without breaking older clients that
 * validate this frame.
 */
export const serverWelcomeFrameSchema = z
  .object({
    type: z.literal("server:welcome"),
    serverCommandVersion: z.string().min(1),
    serverTimeMs: z.number().int().nonnegative(),
    capabilities: serverCapabilitiesSchema.optional(),
  })
  .passthrough();
export type ServerWelcomeFrame = z.infer<typeof serverWelcomeFrameSchema>;
