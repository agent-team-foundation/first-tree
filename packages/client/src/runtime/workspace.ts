import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWorkspaceRuntimeDir, FIRST_TREE_RUNTIME_DIR } from "./bootstrap.js";

/** Retained as an exported constant so external callers that imported it
 *  before the per-agent-home refactor still compile. The runtime no longer
 *  recycles directories by mtime — see `cleanWorkspaces` below. */
export const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stage-2 sentinel marking "agent home bootstrap completed". Distinct from the
 * boundary marker `FIRST_TREE_WORKSPACE_MARKER` (`.first-tree-workspace`) which
 * Codex's `project_root_markers` uses to stop walking up the filesystem.
 *
 * Pre-refactor (per-chat cwd) the two markers gated per-chat self-healing:
 * boundary-marker-present + sentinel-absent meant the previous start crashed
 * between stage 1 and stage 2, and `acquireWorkspace` would wipe the chat
 * directory. With per-agent-home cwd we can no longer wipe — that would also
 * drop predeclared worktrees and any persistent agent state — so the new
 * contract is: sentinel-absent ⇒ re-run `runBootstrap` (idempotent), which
 * overwrites the bootstrap-managed files in place.
 */
export const INIT_COMPLETE_SENTINEL_REL = join(FIRST_TREE_RUNTIME_DIR, "init-complete");

/**
 * Acquire the agent's home directory (shared by every chat session for this
 * agent). Idempotent: first call creates the directory and converges the
 * runtime state into the workspace marker directory; subsequent calls just
 * return the path.
 *
 * Per the agent-session-cwd-redesign proposal, the cwd is **per-agent**, not
 * per-chat: same agent → same cwd across every chat. Per-chat differentiation
 * lives in the system prompt injected by the handler.
 */
export function acquireAgentHome(agentHome: string): string {
  mkdirSync(agentHome, { recursive: true });
  ensureWorkspaceRuntimeDir(agentHome);
  return agentHome;
}

/**
 * Legacy per-chat acquire. Kept exported for backward-compatibility with any
 * out-of-tree caller still importing it; the production handlers no longer
 * invoke it. New code should use {@link acquireAgentHome}.
 *
 * @deprecated Use {@link acquireAgentHome}. Removed once external callers
 * have migrated.
 */
export function acquireWorkspace(workspaceRoot: string, chatId: string): string {
  const dir = join(workspaceRoot, chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write the stage-2 completion sentinel into the agent home. Callers invoke
 * this after `runBootstrap` succeeds; the sentinel's presence then short-
 * circuits the expensive bootstrap path on future session starts.
 */
export function markWorkspaceInitComplete(agentHome: string): void {
  const path = join(agentHome, INIT_COMPLETE_SENTINEL_REL);
  ensureWorkspaceRuntimeDir(agentHome);
  writeFileSync(path, JSON.stringify({ completedAt: new Date().toISOString(), schemaVersion: 1 }), "utf-8");
}

/**
 * Clear the stage-2 sentinel so the next session start re-runs the full
 * bootstrap (skill install + briefing regenerate) without touching any
 * other agent state. Operator-facing escape hatch for a wedged workspace.
 */
export function clearWorkspaceInitComplete(agentHome: string): void {
  const path = join(agentHome, INIT_COMPLETE_SENTINEL_REL);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone — fine.
    }
  }
}

/**
 * Per-agent-home model: the agent home is persistent and never auto-recycled.
 * This function is retained as a no-op only so external callers (and the
 * AgentSlot reconcile loop, if it grows one) keep compiling.
 *
 * Per proposal §0.6 Q6 and §⑤, disk reclamation for the agent home and for
 * legacy `<chatId>/` directories is an explicit operator action via a future
 * `agent prune-legacy` CLI surface, not a background sweep.
 */
export function cleanWorkspaces(
  _workspaceRoot: string,
  _activeChatIds: Set<string>,
  _ttlMs: number = DEFAULT_WORKSPACE_TTL_MS,
): string[] {
  return [];
}
