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

export const capabilityRuntimeSourceSchema = z.enum(["bundled", "path"]);
export type CapabilityRuntimeSource = z.infer<typeof capabilityRuntimeSourceSchema>;

export const capabilityEntrySchema = z.object({
  state: capabilityStateSchema,
  available: z.boolean(),
  authenticated: z.boolean(),
  sdkVersion: z.string().nullable().optional(),
  authMethod: capabilityAuthMethodSchema,
  runtimeSource: capabilityRuntimeSourceSchema.optional(),
  runtimePath: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  detectedAt: z.string(),
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
