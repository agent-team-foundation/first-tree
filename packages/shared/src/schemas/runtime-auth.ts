import { z } from "zod";
import { runtimeProviderSchema } from "./runtime-provider.js";

/**
 * Runtime-auth: the in-product "connect this provider's credentials" flow that
 * lets a member authenticate a runtime (subscription login or API key) on the
 * daemon host without installing a separate CLI.
 *
 * Wire shape:
 *   - Trigger is a server→client (daemon) reverse command frame, sent over the
 *     existing client WebSocket via `sendToClient` — the same precedent as the
 *     `session:suspend|resume|terminate` commands.
 *   - The daemon runs the provider's official login (e.g. codex
 *     `login --device-auth`, claude `setup-token`) on the host, and surfaces
 *     progress (a device code, success, or failure) by re-PATCHing the
 *     capabilities snapshot — NOT a bespoke realtime channel. The web console
 *     reads it back by polling capabilities, keeping the probe the single
 *     source of truth.
 */

/** Server→client command frame type that starts a runtime-auth login. */
export const RUNTIME_AUTH_START_TYPE = "runtime-auth:start" as const;

/**
 * How to authenticate. The daemon picks a sensible default per provider when
 * omitted (codex → device-auth, claude-code → browser setup-token).
 */
export const runtimeAuthMethodSchema = z.enum(["device-auth", "browser", "api-key"]);
export type RuntimeAuthMethod = z.infer<typeof runtimeAuthMethodSchema>;

/** The reverse-command frame the server pushes to the daemon to begin login. */
export const runtimeAuthStartCommandSchema = z.object({
  type: z.literal(RUNTIME_AUTH_START_TYPE),
  /** Which runtime to authenticate. */
  provider: runtimeProviderSchema,
  /** Optional method override; daemon defaults per provider when absent. */
  method: runtimeAuthMethodSchema.optional(),
  /** Correlation id so logs/telemetry can tie command → outcome. */
  ref: z.string(),
});
export type RuntimeAuthStartCommand = z.infer<typeof runtimeAuthStartCommandSchema>;

/**
 * Web→server request body for `POST /clients/:clientId/runtime-auth/start`.
 * The server stamps a `ref` and forwards a {@link runtimeAuthStartCommandSchema}
 * frame to the daemon via `sendToClient`.
 */
export const runtimeAuthStartRequestSchema = z.object({
  provider: runtimeProviderSchema,
  method: runtimeAuthMethodSchema.optional(),
});
export type RuntimeAuthStartRequest = z.infer<typeof runtimeAuthStartRequestSchema>;

/** Server response for a started runtime-auth login. */
export const runtimeAuthStartResponseSchema = z.object({
  ref: z.string(),
  started: z.literal(true),
});
export type RuntimeAuthStartResponse = z.infer<typeof runtimeAuthStartResponseSchema>;

/** Terminal reasons a runtime-auth login can fail, surfaced on the entry's `error`. */
export const runtimeAuthFailureReasonSchema = z.enum([
  "spawn-error",
  "exit-nonzero",
  "timeout",
  "aborted",
  "no-prompt",
  "unsupported",
]);
export type RuntimeAuthFailureReason = z.infer<typeof runtimeAuthFailureReasonSchema>;
