import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Acquire a per-chat workspace directory.
 * Creates the directory if it does not exist; returns the path if it does.
 */
export function acquireWorkspace(workspaceRoot: string, chatId: string): string {
  const dir = join(workspaceRoot, chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
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
