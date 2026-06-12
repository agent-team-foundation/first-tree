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
 * How the entry was produced.
 *   - "launch": launch-verified probe — the provider binary was really spawned
 *     and `ok` means a real end-to-end session/handshake succeeded.
 *   - "static": legacy heuristic probe (import/marker-file checks only). Old
 *     daemons upload entries without `probeKind`; consumers treat absent as
 *     "static".
 */
export const capabilityProbeKindSchema = z.enum(["launch", "static"]);
export type CapabilityProbeKind = z.infer<typeof capabilityProbeKindSchema>;

export const capabilityEntrySchema = z.object({
  state: capabilityStateSchema,
  available: z.boolean(),
  authenticated: z.boolean(),
  sdkVersion: z.string().nullable().optional(),
  authMethod: capabilityAuthMethodSchema,
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
