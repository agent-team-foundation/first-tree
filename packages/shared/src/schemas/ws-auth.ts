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
 * frame is `.passthrough()`.
 *
 * Required by clients in the 0.10.4 ~ 0.14.2 range: those builds read
 * `wsInboxDeliver` here to decide whether to skip the local HTTP poll loop
 * and rely on `inbox:deliver` push frames. The 0.14.3+ runtime ignores the
 * field (push is the only path) but the server still emits it so middle-
 * version clients keep working.
 */
export const serverCapabilitiesSchema = z
  .object({
    /**
     * Server pushes inbox entries as `inbox:deliver` WS frames and accepts
     * `inbox:ack` over the same socket. Always `true` on the current server
     * build — the legacy `new_message` doorbell path was removed in 0.14.3,
     * so there is no negotiation: it's signalled to the client purely so
     * 0.10.4 ~ 0.14.2 clients suppress their local 5s HTTP poll.
     */
    wsInboxDeliver: z.boolean().default(false),
    /**
     * Server confirms `inbox:ack` frames that include a client-generated
     * `ref` with `inbox:ack:accepted` / `inbox:ack:rejected`. New clients use
     * this to retry ACKs until the database transition is known durable.
     */
    wsInboxAckConfirm: z.boolean().default(false),
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
