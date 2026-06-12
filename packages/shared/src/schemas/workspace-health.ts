import { z } from "zod";

// -- Workspace Health (per-agent repo reachability) --
//
// Reported by the client after session bootstrap materialises the agent's
// source repos and Context Tree (`workspace:health` WS frame, client → server),
// persisted latest-wins on `agent_presence.workspace_health`, and read by the
// web console to render the degraded-workspace warning chip.
//
// Reachability is an **agent × repo** fact (two agents on one machine declare
// different gitRepos), which is why it lives on agent presence rather than on
// `clients.metadata` next to the client × runtime capabilities probe.

export const WORKSPACE_REPO_STATUSES = {
  /** Clone present and fetched (or safely left at current commit). */
  OK: "ok",
  /**
   * Existing clone served at its last-good commit because the fetch failed
   * with a permission-shaped error. Unlike a transient network stall this
   * will NOT self-heal — the code view stays frozen until credentials are
   * fixed on the host.
   */
  STALE: "stale",
  /** No usable local clone; the repo could not be cloned (permission-shaped failure). */
  UNREACHABLE: "unreachable",
} as const;

export const workspaceRepoStatusSchema = z.enum(["ok", "stale", "unreachable"]);
export type WorkspaceRepoStatus = z.infer<typeof workspaceRepoStatusSchema>;

/** Tree adds `unbound` — the organization has no Context Tree configured at all. */
export const workspaceTreeStatusSchema = z.enum(["ok", "stale", "unreachable", "unbound"]);
export type WorkspaceTreeStatus = z.infer<typeof workspaceTreeStatusSchema>;

/**
 * Why a repo is degraded. Reuses the git error-taxonomy buckets: only the
 * permission-shaped subset can appear here — auth rejected on both transports,
 * or a 404 (which GitHub deliberately serves for private repos the host's git
 * identity cannot see, so "no permission" most often *looks like* not-found).
 *
 * `git_not_installed` covers the host with no usable `git` binary at all — the
 * single most common all-repos-unreachable cause (fresh machine, gh/git never
 * installed). No clone is even attempted there, so it cannot reuse the two
 * error-shaped buckets; the fix-chat template's first steps (install gh,
 * `gh auth login`) are exactly its remediation.
 */
export const workspaceHealthReasonSchema = z.enum(["git_clone_auth_failed", "git_repo_not_found", "git_not_installed"]);
export type WorkspaceHealthReason = z.infer<typeof workspaceHealthReasonSchema>;

export const workspaceRepoHealthSchema = z.object({
  url: z.string().min(1),
  /** Workspace-relative checkout dir (derived localPath); absent when never materialised. */
  localPath: z.string().min(1).optional(),
  status: workspaceRepoStatusSchema,
  reasonCode: workspaceHealthReasonSchema.optional(),
  /**
   * Short git stderr summary for the warning UI. MUST be passed through the
   * client-side `redactErrorPreview` helper before it leaves the host —
   * credentials never reach the DB or the console.
   */
  errorPreview: z.string().max(512).optional(),
  /** HEAD commit the checkout is frozen at (stale repos only). */
  headCommit: z.string().optional(),
});
export type WorkspaceRepoHealth = z.infer<typeof workspaceRepoHealthSchema>;

export const workspaceTreeHealthSchema = z.object({
  status: workspaceTreeStatusSchema,
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  reasonCode: workspaceHealthReasonSchema.optional(),
  /** Same redaction contract as `workspaceRepoHealthSchema.errorPreview`. */
  errorPreview: z.string().max(512).optional(),
});
export type WorkspaceTreeHealth = z.infer<typeof workspaceTreeHealthSchema>;

/**
 * Payload of the `workspace:health` client → server frame. `agentId` rides on
 * the WS envelope (same as `runtime:state` / `session:runtime`); the server
 * stamps `updatedAt` on persist so "last reported X ago" never trusts the
 * client clock.
 */
export const workspaceHealthMessageSchema = z.object({
  tree: workspaceTreeHealthSchema,
  repos: z.array(workspaceRepoHealthSchema),
});
export type WorkspaceHealthMessage = z.infer<typeof workspaceHealthMessageSchema>;

/** Stored shape (`agent_presence.workspace_health` JSONB) — payload + server receive time. */
export const workspaceHealthSchema = workspaceHealthMessageSchema.extend({
  updatedAt: z.string(),
});
export type WorkspaceHealth = z.infer<typeof workspaceHealthSchema>;

/** True when anything in the report needs the degraded-workspace warning surface. */
export function isWorkspaceHealthDegraded(health: WorkspaceHealthMessage): boolean {
  if (health.tree.status === "stale" || health.tree.status === "unreachable") return true;
  return health.repos.some((repo) => repo.status !== "ok");
}
