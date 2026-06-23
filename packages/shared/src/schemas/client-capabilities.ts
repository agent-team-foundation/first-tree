import { z } from "zod";

export const CAPABILITY_STATES = {
  OK: "ok",
  MISSING: "missing",
  UNAUTHENTICATED: "unauthenticated",
  ERROR: "error",
} as const;

export const capabilityStateSchema = z.enum(["ok", "missing", "unauthenticated", "error"]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const capabilityAuthMethodSchema = z.enum(["api_key", "oauth", "auth_json", "none"]);
export type CapabilityAuthMethod = z.infer<typeof capabilityAuthMethodSchema>;

/**
 * Which on-disk artifact backs the runtime:
 *   - "bundled": the SDK-bundled binary (the default the runtime spawns).
 *   - "path":    a system `codex` found on PATH, used as a validated fallback
 *     when the bundled binary is missing.
 */
export const capabilityRuntimeSourceSchema = z.enum(["bundled", "path"]);
export type CapabilityRuntimeSource = z.infer<typeof capabilityRuntimeSourceSchema>;

/**
 * How the entry was produced.
 *   - "launch": launch-verified probe — the provider binary was really spawned
 *     and `ok` means a real end-to-end session/handshake succeeded.
 *   - "static": legacy heuristic probe (import/marker-file checks only). Old
 *     daemons upload entries without `probeKind`; consumers treat absent as
 *     "static".
 */
export const capabilityProbeKindSchema = z.enum(["launch", "static"]);
export type CapabilityProbeKind = z.infer<typeof capabilityProbeKindSchema>;

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
  available: z.boolean(),
  authenticated: z.boolean(),
  sdkVersion: z.string().nullable().optional(),
  authMethod: capabilityAuthMethodSchema,
  /** Which artifact backs the runtime (bundled binary vs system-PATH fallback). */
  runtimeSource: capabilityRuntimeSourceSchema.optional(),
  /** Absolute path of the system fallback binary, when `runtimeSource: "path"`. */
  runtimePath: z.string().nullable().optional(),
  /**
   * Human-readable failure reason. Launch-verified probes always set this for
   * every non-`ok` state, carrying the provider's own output verbatim
   * (truncated) so the web UI can render the real error instead of a generic
   * label. Optional in the schema for backward compatibility with entries
   * uploaded by older daemons.
   */
  error: z.string().nullable().optional(),
  detectedAt: z.string(),
  probeKind: capabilityProbeKindSchema.optional(),
  /** Wall-clock duration of the whole probe (all stages), milliseconds. */
  latencyMs: z.number().nonnegative().optional(),
  /**
   * True when the probe could not run its full verification and fell back to
   * a weaker check (e.g. codex without a `doctor` subcommand) — `ok` then
   * means "launchable + credentials present", not "end-to-end verified".
   */
  degraded: z.boolean().optional(),
  /**
   * Present while the daemon is driving an in-product browser-OAuth login for
   * this provider. Absent in steady state. See `pendingAuthSchema`.
   */
  pendingAuth: pendingAuthSchema.nullable().optional(),
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
