import { z } from "zod";
import { runtimeAuthLastErrorSchema } from "./runtime-auth.js";

/**
 * Capability detection is install-only: a provider is `ok` when the binary the
 * runtime would spawn is resolvable on this host, `missing` when it is not, and
 * `error` when detection itself threw. Whether the provider is *authenticated*
 * or end-to-end *usable* is deliberately NOT probed here — that is discovered at
 * session run time and surfaced as an in-chat credential failure (see the
 * provider-retry policy + the in-chat "needs login" entry point). This replaced
 * the older launch-verified probe whose mandatory auth precheck + real-session
 * smoke were the main source of false negatives and token/latency cost.
 */
export const CAPABILITY_STATES = {
  OK: "ok",
  MISSING: "missing",
  ERROR: "error",
} as const;

export const capabilityStateSchema = z.enum(["ok", "missing", "error"]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

/**
 * Which on-disk artifact backs the runtime:
 *   - "bundled": the SDK-bundled binary (the default the runtime spawns).
 *   - "path":    a system `claude` / `codex` found on PATH (or a well-known
 *     install dir), used when no bundled binary is present.
 */
export const capabilityRuntimeSourceSchema = z.enum(["bundled", "path"]);
export type CapabilityRuntimeSource = z.infer<typeof capabilityRuntimeSourceSchema>;

export const pendingAuthMethodSchema = z.enum(["browser"]);
export type PendingAuthMethod = z.infer<typeof pendingAuthMethodSchema>;

/**
 * An in-flight in-product login the daemon is driving for this provider. It
 * rides the capabilities snapshot the daemon already PATCHes — so the web
 * console surfaces it by polling capabilities, with the probe staying the
 * single source of truth and no separate realtime channel. Cleared (back to
 * absent) once the daemon re-probes after the login resolves.
 *
 *   - `method: "browser"`: the daemon ran the provider's official browser OAuth
 *     on the host (codex `login` / claude `auth login`). The web shows a
 *     "finish in the browser that opened on <host>" state.
 */
export const pendingAuthSchema = z.object({
  method: pendingAuthMethodSchema,
  /**
   * The provider's sign-in URL, surfaced once the login process prints it, so
   * the web can offer a "didn't open? open sign-in" link when the host browser
   * does not auto-launch. Absent until the process emits it.
   */
  authUrl: z.string().optional(),
  /** ISO8601 instant the attempt expires; the web hides/falls back once past. */
  expiresAt: z.string(),
});
export type PendingAuth = z.infer<typeof pendingAuthSchema>;

export const capabilityEntrySchema = z.object({
  state: capabilityStateSchema,
  /** Derived: the provider binary is installed/resolvable (`state === "ok"`). */
  available: z.boolean(),
  /**
   * Provider version, when cheaply known from the resolved package/binary.
   * Install-only detection does not launch the binary, so this is often absent.
   */
  sdkVersion: z.string().nullable().optional(),
  /** Which artifact backs the runtime (bundled binary vs system-PATH fallback). */
  runtimeSource: capabilityRuntimeSourceSchema.optional(),
  /** Absolute path of the resolved binary, when `runtimeSource: "path"`. */
  runtimePath: z.string().nullable().optional(),
  /**
   * Human-readable failure reason for a non-`ok` state — for `missing`, which
   * artifacts were checked and not found; for `error`, the exception message.
   * Optional for backward compatibility with entries uploaded by older daemons.
   */
  error: z.string().nullable().optional(),
  detectedAt: z.string(),
  /** Wall-clock duration of the detection, milliseconds. */
  latencyMs: z.number().nonnegative().optional(),
  /**
   * Present while the daemon is driving an in-product browser-OAuth login for
   * this provider. Absent in steady state. See `pendingAuthSchema`.
   */
  pendingAuth: pendingAuthSchema.nullable().optional(),
  /**
   * Terminal failure of the most recent in-product login the daemon drove for
   * this provider, so the web can distinguish "sign-in failed — retry" from
   * "never attempted". Set by the daemon's runtime-auth orchestrator; cleared on
   * the next login start or a successful re-probe. See `runtimeAuthLastErrorSchema`.
   */
  lastAuthError: runtimeAuthLastErrorSchema.nullable().optional(),
});
export type CapabilityEntry = z.infer<typeof capabilityEntrySchema>;

/**
 * Capabilities snapshot keyed by runtime provider name. Recorded as a plain
 * `Record<string, CapabilityEntry>` — every entry is optional (a client may
 * report only the runtimes it actually probed) and the key set evolves
 * naturally as new providers ship without a schema migration. Service-layer
 * lookups (`agents.runtime_provider ∈ keys(capabilities)`) treat the keys
 * as `RuntimeProvider` strings.
 */
export const clientCapabilitiesSchema = z.record(z.string(), capabilityEntrySchema);
export type ClientCapabilities = z.infer<typeof clientCapabilitiesSchema>;

export const updateClientCapabilitiesSchema = z.object({
  capabilities: clientCapabilitiesSchema,
});
export type UpdateClientCapabilities = z.infer<typeof updateClientCapabilitiesSchema>;
