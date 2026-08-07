import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";
import { SessionRegistry } from "./session-registry.js";
import { cleanWorkspaces } from "./workspace.js";

/**
 * Public options for {@link cleanAgentWorkspaces}.
 * Channel data-root and the low-level cleaner stay inside Client — not package API.
 */
export type CleanAgentWorkspacesOptions = {
  /** When set, clean only this agent home. When omitted, enumerate every agent under workspaces/. */
  agentName?: string;
  /** TTL forwarded to the low-level cleaner (currently a no-op). */
  ttlMs: number;
};

export type CleanedWorkspaceEntry = {
  agentName: string;
  chatId: string;
};

export type CleanAgentWorkspacesResult =
  | { kind: "missing-root" }
  | { kind: "cleaned"; removed: CleanedWorkspaceEntry[] };

/**
 * @internal Test-only dependency seam. Not re-exported from package barrels.
 * Production {@link cleanAgentWorkspaces} always binds channel `defaultDataDir()`
 * and the real zero-deletion {@link cleanWorkspaces}.
 */
export type CleanAgentWorkspacesTestDeps = {
  dataDir: string;
  cleanWorkspacesFn?: (workspaceRoot: string, activeChatIds: Set<string>, ttlMs: number) => string[];
};

/**
 * High-level agent-workspace maintenance for the CLI `agent workspace clean`
 * command.
 *
 * Owns `<dataDir>/workspaces` / `<dataDir>/sessions/<agent>.json` layout,
 * agent enumeration, SessionRegistry reads, active/evicted selection, and the
 * low-level {@link cleanWorkspaces} call. The CLI command layer only parses
 * flags and prints the returned structure.
 *
 * Behavior is intentionally unchanged from the prior CLI orchestration:
 * {@link cleanWorkspaces} remains a deprecated zero-deletion no-op, so this
 * never auto-deletes agent homes, clones, worktrees, or legacy chat dirs.
 */
export function cleanAgentWorkspaces(options: CleanAgentWorkspacesOptions): CleanAgentWorkspacesResult {
  return cleanAgentWorkspacesWithDeps(options, {
    dataDir: defaultDataDir(),
    cleanWorkspacesFn: cleanWorkspaces,
  });
}

/**
 * @internal Orchestration core with injectable data-root / cleaner for tests.
 * Import only via the module path — never from `@first-tree/client` barrels.
 */
export function cleanAgentWorkspacesWithDeps(
  options: CleanAgentWorkspacesOptions,
  deps: CleanAgentWorkspacesTestDeps,
): CleanAgentWorkspacesResult {
  const dataDir = deps.dataDir;
  const ttlMs = options.ttlMs;
  const cleanFn = deps.cleanWorkspacesFn ?? cleanWorkspaces;
  const workspacesDir = join(dataDir, "workspaces");

  if (!existsSync(workspacesDir)) {
    return { kind: "missing-root" };
  }

  const agentNames = options.agentName ? [options.agentName] : readdirSync(workspacesDir);
  const removed: CleanedWorkspaceEntry[] = [];

  for (const name of agentNames) {
    const agentWorkspaceRoot = join(workspacesDir, name);
    if (!existsSync(agentWorkspaceRoot)) continue;

    const registryPath = join(dataDir, "sessions", `${name}.json`);
    const registry = new SessionRegistry(registryPath);
    const persisted = registry.load();
    const activeChatIds = new Set<string>();
    for (const [chatId, data] of persisted) {
      if (data.status !== "evicted") {
        activeChatIds.add(chatId);
      }
    }

    const cleaned = cleanFn(agentWorkspaceRoot, activeChatIds, ttlMs);
    for (const chatId of cleaned) {
      removed.push({ agentName: name, chatId });
    }
  }

  return { kind: "cleaned", removed };
}
