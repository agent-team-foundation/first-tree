import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_TREE_WORKSPACE_MARKER } from "./bootstrap.js";

export const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sentinel that flags "stage-2 of session bootstrap (git worktree
 * materialisation) completed successfully". Distinct from the
 * `FIRST_TREE_WORKSPACE_MARKER` (`.first-tree-workspace`) which is the
 * "agent workspace boundary" — Codex's `project_root_markers` uses that one
 * to stop walking up the filesystem when looking for `AGENTS.md`. Splitting
 * the two so the boundary marker can be written eagerly (stage 1) while the
 * completion sentinel only appears after stage 2 lets `acquireWorkspace`
 * detect half-baked directories from a previous failed start and self-heal.
 *
 * See docs/workspace-session-branch-collision-fix-design.md §3.4.
 */
export const INIT_COMPLETE_SENTINEL_REL = join(".agent", "init-complete");

/**
 * Acquire a per-chat workspace directory.
 *
 * Healing rule: if the directory exists AND carries the boundary marker
 * (`.first-tree-workspace`, written in stage 1) AND is missing the
 * completion sentinel (`.agent/init-complete`, written after stage 2), the
 * previous session start crashed between the two writes — wipe it so the
 * fresh start gets a clean slate. The boundary marker alone (without the
 * sentinel) is the unambiguous shape of a half-baked workspace: only stage 1
 * writes it, and only stage 2 writes the sentinel.
 */
export function acquireWorkspace(workspaceRoot: string, chatId: string): string {
  const dir = join(workspaceRoot, chatId);

  if (
    existsSync(dir) &&
    existsSync(join(dir, FIRST_TREE_WORKSPACE_MARKER)) &&
    !existsSync(join(dir, INIT_COMPLETE_SENTINEL_REL))
  ) {
    // Half-baked from a previous failed start — start over.
    rmSync(dir, { recursive: true, force: true });
  }

  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write the stage-2 completion sentinel. Callers must invoke this AFTER all
 * pre-handler-spawn setup (workspace bootstrap, git worktrees, first-tree
 * integration) succeeded, so a process that crashes earlier leaves a
 * half-baked workspace the next acquireWorkspace can heal.
 */
export function markWorkspaceInitComplete(workspaceCwd: string): void {
  const path = join(workspaceCwd, INIT_COMPLETE_SENTINEL_REL);
  // `.agent/` already exists after `bootstrapWorkspace`; createDir defensively
  // in case a caller writes the sentinel without a prior bootstrap.
  mkdirSync(join(workspaceCwd, ".agent"), { recursive: true });
  writeFileSync(path, JSON.stringify({ completedAt: new Date().toISOString(), schemaVersion: 1 }), "utf-8");
}

/**
 * Clean stale workspace directories for an agent.
 *
 * A workspace is considered stale when:
 * 1. Its mtime is older than `ttlMs`
 * 2. Its chatId is NOT in the `activeChatIds` set
 *
 * Returns the list of removed chatIds.
 */
export function cleanWorkspaces(
  workspaceRoot: string,
  activeChatIds: Set<string>,
  ttlMs: number = DEFAULT_WORKSPACE_TTL_MS,
): string[] {
  if (!existsSync(workspaceRoot)) return [];

  const now = Date.now();
  const removed: string[] = [];

  for (const entry of readdirSync(workspaceRoot)) {
    if (activeChatIds.has(entry)) continue;

    const entryPath = join(workspaceRoot, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs > ttlMs) {
        rmSync(entryPath, { recursive: true, force: true });
        removed.push(entry);
      }
    } catch {
      // Entry disappeared between readdir and stat — skip
    }
  }

  return removed;
}
