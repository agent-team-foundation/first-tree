import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "@agent-team-foundation/first-tree-hub-shared/config";
import { agentConfigSchema, loadAgents } from "@agent-team-foundation/first-tree-hub-shared/config";
import { print } from "./output.js";

/**
 * Phase 3 of the agent-naming refactor (docs/agent-naming-design.md §3.4 + §4):
 * reconcile every local agent directory name with the server-authoritative
 * `agent.name` slug. The free-form local alias concept is gone — the Hub is
 * the only namespace authority — so on every client startup we walk the
 * local configs, ask the server what each agentId's canonical name is, and
 * rename the config/workspace/sessions state when they drift.
 *
 * Invariants:
 *   - Idempotent — repeat runs after a full rename are a no-op (every
 *     `dirName === serverName` returns early).
 *   - Non-fatal — a single migration failure (missing server, collision,
 *     permission error) never aborts the runtime start. We print a warning
 *     and leave the original dir in place so the operator can investigate.
 *   - Crash-safe — the rename ordering is: config dir first, then
 *     `workspaces/<name>`, then `sessions/<name>.json`. A crash after the
 *     config dir rename but before the workspace rename leaves the client
 *     with a workspace under the old name; the next startup re-runs the
 *     migration against the already-renamed config and falls through
 *     because the server name now matches, so workspaces/sessions under
 *     the old name become orphaned. That's acceptable — the operator can
 *     `agent workspace clean` them later — and it beats a partial rename
 *     that loses the config pointer.
 *   - Collision-aware — if a directory already exists at the target name,
 *     we skip and log rather than clobber. (Two local configs mapping to
 *     the same server name is a config bug; the operator must resolve.)
 */

type AgentRow = { uuid: string; name: string | null };

export type AgentDirMigrationResult = {
  scanned: number;
  renamed: number;
  skipped: number;
  errors: number;
};

/**
 * Resolve the canonical server names for every local agentId. Uses the
 * admin `/agents` listing because it's a single paginated call — much
 * cheaper than N per-agent GETs when the user has multiple agents.
 *
 * Callers that can't reach the server (offline start, auth failure) should
 * skip the migration entirely — passing a resolver that returns `null`
 * from `resolveName` turns `migrateLocalAgentDirs` into a no-op.
 */
export type NameResolver = {
  resolveName(agentId: string): Promise<string | null>;
};

export function createApiNameResolver(serverUrl: string, getAccessToken: () => Promise<string>): NameResolver {
  // One-shot fetch of the admin agents listing, memoised for the duration
  // of this resolver's life. The client-runtime migration runs once per
  // start(), so there's nothing to invalidate.
  let cache: Map<string, string | null> | null = null;

  async function ensureCache(): Promise<Map<string, string | null>> {
    if (cache) return cache;
    const token = await getAccessToken();
    const res = await fetch(`${serverUrl}/api/v1/admin/agents?limit=100`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`admin agents list returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { items: AgentRow[] };
    const map = new Map<string, string | null>();
    for (const row of body.items) {
      map.set(row.uuid, row.name);
    }
    cache = map;
    return map;
  }

  return {
    async resolveName(agentId: string): Promise<string | null> {
      const map = await ensureCache();
      return map.get(agentId) ?? null;
    },
  };
}

/**
 * Walk `agentsDir`, for each local agent compare the dir name to the
 * server's canonical `name`, and rename the dir + workspaces/sessions
 * entries when they differ. Returns a summary so the caller can decide
 * whether to print additional context.
 */
export async function migrateLocalAgentDirs(opts: {
  agentsDir: string;
  workspacesDir: string;
  sessionsDir: string;
  resolver: NameResolver;
}): Promise<AgentDirMigrationResult> {
  const { agentsDir, workspacesDir, sessionsDir, resolver } = opts;
  const result: AgentDirMigrationResult = { scanned: 0, renamed: 0, skipped: 0, errors: 0 };

  if (!existsSync(agentsDir)) return result;

  let locals: Map<string, AgentConfig>;
  try {
    locals = loadAgents({ schema: agentConfigSchema, agentsDir });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print.status("⚠️", `agent-dir migration: unable to enumerate ${agentsDir}: ${msg}`);
    return { ...result, errors: result.errors + 1 };
  }

  for (const [dirName, config] of locals) {
    result.scanned += 1;

    let serverName: string | null;
    try {
      serverName = await resolver.resolveName(config.agentId);
    } catch (err) {
      // A network blip here shouldn't block startup — leave the dir alone
      // and continue with the rest. The next start attempts the rename
      // again; idempotent design means we don't leave the layout wedged.
      const msg = err instanceof Error ? err.message : String(err);
      print.status("⚠️", `agent-dir migration: failed to resolve "${dirName}" (${config.agentId}): ${msg}`);
      result.errors += 1;
      // One resolver failure usually means the whole fetch is broken — bail
      // out so we don't spam a warning per agent.
      return result;
    }

    if (!serverName) {
      // Server has no `name` for this agent (e.g. tombstoned row, or the
      // listing call was capped before reaching this id). Skip quietly.
      result.skipped += 1;
      continue;
    }
    if (serverName === dirName) continue;

    const oldDir = join(agentsDir, dirName);
    const newDir = join(agentsDir, serverName);
    if (existsSync(newDir)) {
      print.status(
        "⚠️",
        `agent-dir migration: cannot rename "${dirName}" → "${serverName}" — target already exists. Skipping.`,
      );
      result.skipped += 1;
      continue;
    }

    try {
      renameSync(oldDir, newDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      print.status("⚠️", `agent-dir migration: config dir rename failed for "${dirName}": ${msg}`);
      result.errors += 1;
      continue;
    }

    // Follow-on renames for adjacent state. Each is best-effort and logged
    // on failure — the config dir is the canonical marker for "migrated",
    // so mismatched workspace/session leftovers show up as orphans (not
    // wedged state).
    const oldWorkspace = join(workspacesDir, dirName);
    const newWorkspace = join(workspacesDir, serverName);
    if (existsSync(oldWorkspace)) {
      try {
        if (existsSync(newWorkspace)) {
          print.status(
            "⚠️",
            `agent-dir migration: workspace target "${serverName}" already exists; leaving old "${dirName}" in place for manual cleanup.`,
          );
        } else if (statSync(oldWorkspace).isDirectory()) {
          renameSync(oldWorkspace, newWorkspace);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.status("⚠️", `agent-dir migration: workspace rename failed for "${dirName}": ${msg}`);
        result.errors += 1;
      }
    }

    const oldSessions = join(sessionsDir, `${dirName}.json`);
    const newSessions = join(sessionsDir, `${serverName}.json`);
    if (existsSync(oldSessions)) {
      try {
        if (existsSync(newSessions)) {
          print.status(
            "⚠️",
            `agent-dir migration: sessions target "${serverName}.json" already exists; leaving old "${dirName}.json" in place for manual cleanup.`,
          );
        } else {
          renameSync(oldSessions, newSessions);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.status("⚠️", `agent-dir migration: sessions rename failed for "${dirName}": ${msg}`);
        result.errors += 1;
      }
    }

    print.status("", `agent "${dirName}" renamed to "${serverName}" to match hub`);
    result.renamed += 1;
  }

  // Helper: enumerate ORPHANED workspace / session paths — those whose
  // directory name doesn't match any current local agent. We don't
  // auto-delete them (see crash-safety note above), but we log a reminder
  // when the set is non-empty so the operator knows to run `agent
  // workspace clean`.
  try {
    const localNames = new Set(locals.keys());
    // Recompute after rename since `locals` was taken before the walk.
    if (existsSync(agentsDir)) {
      const refreshed = loadAgents({ schema: agentConfigSchema, agentsDir });
      for (const k of refreshed.keys()) localNames.add(k);
    }
    const orphanWs = existsSync(workspacesDir) ? readdirSync(workspacesDir).filter((d) => !localNames.has(d)) : [];
    const orphanSessions = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter((f) => f.endsWith(".json") && !localNames.has(f.slice(0, -5)))
      : [];
    if (orphanWs.length > 0 || orphanSessions.length > 0) {
      const parts: string[] = [];
      if (orphanWs.length > 0) parts.push(`workspaces: ${orphanWs.join(", ")}`);
      if (orphanSessions.length > 0) parts.push(`sessions: ${orphanSessions.join(", ")}`);
      print.status(
        "",
        `orphaned local state detected (${parts.join("; ")}). Run \`first-tree-hub agent workspace clean\` to reclaim disk.`,
      );
    }
  } catch {
    // Best-effort: orphan detection is informational, never block start.
  }

  return result;
}
