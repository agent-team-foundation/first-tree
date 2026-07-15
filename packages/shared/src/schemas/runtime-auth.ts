import { z } from "zod";

/**
 * Providers whose login the daemon can drive in-product. Narrower than the full
 * `runtimeProviderSchema`: `claude-code-tui` shares Claude Code's credentials
 * (authenticated by the `claude-code` login, never separately) and is not a
 * Connect target. The server rejects a `runtime-auth:start` for anything else
 * rather than returning `started: true` for a provider that will never publish
 * pending auth.
 */
export const runtimeAuthProviderSchema = z.enum(["claude-code", "codex", "cursor"]);
export type RuntimeAuthProvider = z.infer<typeof runtimeAuthProviderSchema>;

/**
 * Runtime-auth: the in-product "connect this provider's credentials" flow that
 * lets a member authenticate a runtime (subscription login) on the daemon host
 * without installing a separate CLI.
 *
 * Wire shape:
 *   - Trigger is a server→client (daemon) reverse command frame, sent over the
 *     existing client WebSocket via `sendToClient` — the same precedent as the
 *     `session:suspend|resume|terminate` commands.
 *   - The daemon runs the provider's official browser sign-in (codex `login`,
 *     claude `auth login`) on the host, and surfaces progress (success or
 *     failure) by re-PATCHing the capabilities snapshot — NOT a bespoke
 *     realtime channel. The web console reads it back by polling capabilities,
 *     keeping the probe the single source of truth.
 */

/** Server→client command frame type that starts a runtime-auth login. */
export const RUNTIME_AUTH_START_TYPE = "runtime-auth:start" as const;

/**
 * How to authenticate. Browser OAuth is the only supported method — the daemon
 * runs the provider's official browser sign-in on the host (codex `login`,
 * claude `auth login`). Kept as a single-value enum for forward compatibility.
 */
export const runtimeAuthMethodSchema = z.enum(["browser"]);
export type RuntimeAuthMethod = z.infer<typeof runtimeAuthMethodSchema>;

/** The reverse-command frame the server pushes to the daemon to begin login. */
export const runtimeAuthStartCommandSchema = z.object({
  type: z.literal(RUNTIME_AUTH_START_TYPE),
  /** Which runtime to authenticate. */
  provider: runtimeAuthProviderSchema,
  /** Optional method override; daemon defaults to browser OAuth when absent. */
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
  provider: runtimeAuthProviderSchema,
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
  "unsupported",
]);
export type RuntimeAuthFailureReason = z.infer<typeof runtimeAuthFailureReasonSchema>;

/**
 * The terminal failure of the most recent in-product login the daemon drove for
 * a provider, recorded on the capability entry so the web console can tell
 * "sign-in failed — try again" apart from "never attempted". Written by the
 * daemon's runtime-auth orchestrator (not the probe), and cleared on the next
 * login start (the fresh pending entry omits it) or a successful re-probe (the
 * `ok` entry omits it). Distinct from `CapabilityEntry.error`, which carries the
 * probe's own verbatim reason for a non-`ok` state.
 */
export const runtimeAuthLastErrorSchema = z.object({
  reason: runtimeAuthFailureReasonSchema,
  /** Provider's own failure text (truncated), when the login produced one. */
  message: z.string().optional(),
  /** ISO8601 instant the failure was recorded — lets the web ignore stale ones. */
  at: z.string(),
});
export type RuntimeAuthLastError = z.infer<typeof runtimeAuthLastErrorSchema>;
