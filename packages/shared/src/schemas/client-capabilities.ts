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

export const capabilityEntrySchema = z.object({
  state: capabilityStateSchema,
  available: z.boolean(),
  authenticated: z.boolean(),
  sdkVersion: z.string().nullable().optional(),
  authMethod: capabilityAuthMethodSchema,
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

/**
 * Single local Git repository the client discovered on its host filesystem.
 *
 * Reported alongside provider capabilities so Hub UIs (notably the Step 3
 * onboarding picker) can let users select an existing local clone instead
 * of forcing a fresh sandbox clone on session start (Plan A — agent works
 * on a session-scoped `git worktree` inside the user's real repo).
 *
 * `localPath` is an absolute path on the client host; the Hub never resolves
 * it itself, only round-trips it back to the agent via `gitRepos[].localPath`
 * which the client handler interprets in the same address space.
 */
export const localGitRepoSummarySchema = z.object({
  /** Absolute path on the client host. */
  localPath: z.string().min(1),
  /** Display name — typically the basename of `localPath`. */
  name: z.string().min(1),
  /** `remote.origin.url` from `.git/config`, when present. Empty when the repo has no origin. */
  originUrl: z.string().default(""),
});
export type LocalGitRepoSummary = z.infer<typeof localGitRepoSummarySchema>;

/** Wire-payload bound on the snapshot the client sends. The scanner's own
 * cap is set to match this; if the user genuinely has more than this many
 * repos under common roots, they fall back to the manual-path input in
 * Step 3 rather than ballooning the metadata column on every reconnect. */
const LOCAL_GIT_REPOS_MAX = 500;

export const localGitRepoSummariesSchema = z.array(localGitRepoSummarySchema).max(LOCAL_GIT_REPOS_MAX);
export type LocalGitRepoSummaries = z.infer<typeof localGitRepoSummariesSchema>;

export const updateClientCapabilitiesSchema = z.object({
  capabilities: clientCapabilitiesSchema,
  /**
   * Optional snapshot of local git repos under common roots (`~/code`,
   * `~/github`, `~/projects`, `~/work`, `~/Documents/GitHub`). Stored
   * alongside `capabilities` in `clients.metadata.localGitRepos`. Omitted
   * by older clients that haven't shipped the scanner yet.
   */
  localGitRepos: localGitRepoSummariesSchema.optional(),
});
export type UpdateClientCapabilities = z.infer<typeof updateClientCapabilitiesSchema>;
