import { z } from "zod";

/**
 * First-frame auth envelope sent by the SDK on the client WS connection.
 * The server asks the client to retry with close code 1013 if this frame does
 * not arrive within {@link WS_AUTH_FRAME_TIMEOUT_MS}; malformed frames still
 * close as deterministic auth rejections.
 */
export const wsAuthFrameSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});
export type WsAuthFrame = z.infer<typeof wsAuthFrameSchema>;

/**
 * Admin WebSocket challenge protocol. Unlike the agent-runtime socket, the
 * browser admin socket first receives a server-authority challenge and must
 * echo its connection-specific nonce. This binds `auth:ok` to the exact
 * connection that supplied the token instead of accepting an unchallenged
 * bearer frame.
 */
export const ADMIN_WS_PROTOCOL_VERSION = 1 as const;
export const adminWsChallengeNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const adminWsServerHelloFrameSchema = z
  .object({
    type: z.literal("server:hello"),
    protocolVersion: z.literal(ADMIN_WS_PROTOCOL_VERSION),
    authority: z.string().min(1),
    nonce: adminWsChallengeNonceSchema,
  })
  .strict();
export type AdminWsServerHelloFrame = z.infer<typeof adminWsServerHelloFrameSchema>;

export const adminWsAuthFrameSchema = z
  .object({
    type: z.literal("auth"),
    protocolVersion: z.literal(ADMIN_WS_PROTOCOL_VERSION),
    nonce: adminWsChallengeNonceSchema,
    token: z.string().min(1),
  })
  .strict();
export type AdminWsAuthFrame = z.infer<typeof adminWsAuthFrameSchema>;

export const adminWsAuthOkFrameSchema = z
  .object({
    type: z.literal("auth:ok"),
    protocolVersion: z.literal(ADMIN_WS_PROTOCOL_VERSION),
    nonce: adminWsChallengeNonceSchema,
  })
  .strict();
export type AdminWsAuthOkFrame = z.infer<typeof adminWsAuthOkFrameSchema>;

/** How long the server waits for the first `auth` frame before closing the WS. */
export const WS_AUTH_FRAME_TIMEOUT_MS = 5_000;

export const AUTH_REJECTED_CODES = {
  INVALID_TOKEN: "invalid_token",
  INVALID_CLAIMS: "invalid_claims",
  WRONG_TOKEN_TYPE: "wrong_token_type",
  USER_NOT_FOUND: "user_not_found",
  USER_SUSPENDED: "user_suspended",
  INVALID_AUTH_FRAME: "invalid_auth_frame",
} as const;
export const authRejectedCodeSchema = z.enum([
  "invalid_token",
  "invalid_claims",
  "wrong_token_type",
  "user_not_found",
  "user_suspended",
  "invalid_auth_frame",
]);
export type AuthRejectedCode = z.infer<typeof authRejectedCodeSchema>;

export const AUTH_RETRYABLE_CODES = {
  AUTH_BACKEND_UNAVAILABLE: "auth_backend_unavailable",
  HANDSHAKE_INTERNAL_ERROR: "handshake_internal_error",
  AUTH_TIMEOUT: "auth_timeout",
  SERVER_DRAINING: "server_draining",
} as const;
export const authRetryableCodeSchema = z.enum([
  "auth_backend_unavailable",
  "handshake_internal_error",
  "auth_timeout",
  "server_draining",
]);
export type AuthRetryableCode = z.infer<typeof authRetryableCodeSchema>;

export const authRejectedFrameSchema = z.object({
  type: z.literal("auth:rejected"),
  code: authRejectedCodeSchema,
  message: z.string().min(1).optional(),
});
export type AuthRejectedFrame = z.infer<typeof authRejectedFrameSchema>;

export const authExpiredFrameSchema = z.object({
  type: z.literal("auth:expired"),
});
export type AuthExpiredFrame = z.infer<typeof authExpiredFrameSchema>;

export const authRetryableFrameSchema = z.object({
  type: z.literal("auth:retryable"),
  code: authRetryableCodeSchema,
  retryAfterMs: z.number().int().positive().optional(),
  message: z.string().min(1).optional(),
});
export type AuthRetryableFrame = z.infer<typeof authRetryableFrameSchema>;

export const authControlFrameSchema = z.discriminatedUnion("type", [
  authRejectedFrameSchema,
  authExpiredFrameSchema,
  authRetryableFrameSchema,
]);
export type AuthControlFrame = z.infer<typeof authControlFrameSchema>;

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
    /**
     * Server confirms `session:event` frames that include a client-generated
     * `ref` with `session:event:accepted` / `session:event:rejected`. Clients
     * that need durable evidence before settling related local work use this
     * path; ordinary event streaming may remain fire-and-forget.
     */
    wsSessionEventConfirm: z.boolean().default(false),
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
