import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyRuntimeLayout } from "@first-tree/client";
import { parse as parseYaml } from "yaml";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";
import { print } from "./output.js";

/**
 * Phase 3 of the agent-naming refactor (first-tree-context:agent-hub/agent-naming.md §3.4 + §4):
 * reconcile every local agent directory name with the server-authoritative
 * `agent.name` slug. The free-form local alias concept is gone — the server is
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
  const PAGE_SIZE = 100;
  // Belt-and-braces: stop after this many pages so a server bug (e.g.
  // nextCursor that never terminates) can't wedge startup.
  const MAX_PAGES = 50;

  async function ensureCache(): Promise<Map<string, string | null>> {
    if (cache) return cache;
    const token = await getAccessToken();
    const map = new Map<string, string | null>();
    // /me/managed-agents — cross-org, returns all agents the user
    // personally manages in a single response (no pagination).
    const res = await cliFetch(`${serverUrl}/api/v1/me/managed-agents`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`/me/managed-agents returned HTTP ${res.status}`);
    }
    const items = (await res.json()) as AgentRow[];
    for (const row of items) {
      map.set(row.uuid, row.name);
    }
    cache = map;
    return map;
  }
  void PAGE_SIZE;
  void MAX_PAGES;

  return {
    async resolveName(agentId: string): Promise<string | null> {
      const map = await ensureCache();
      return map.get(agentId) ?? null;
    },
  };
}

/**
 * Read the `agentId` field out of a single `agent.yaml` with minimal
 * parsing. Unlike `loadAgents`, which Zod-validates every entry and
 * throws on the first malformed file (aborting migration for *every*
 * other agent below it), this helper scopes failures per-dir: a broken
 * file returns `null` and the caller logs + skips that dir only.
 */
function readAgentId(agentYamlPath: string): string | null {
  try {
    const raw = readFileSync(agentYamlPath, "utf-8");
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object" && "agentId" in parsed) {
      const id = (parsed as { agentId: unknown }).agentId;
      if (typeof id === "string" && id.length > 0) return id;
    }
    return null;
  } catch {
    return null;
  }
}

function migrateWorkspaceRuntimeDir(workspacePath: string, agentName: string, result: AgentDirMigrationResult): void {
  if (!existsSync(workspacePath)) return;
  try {
    if (!statSync(workspacePath).isDirectory()) return;
  } catch {
    return;
  }

  try {
    migrateLegacyRuntimeLayout(workspacePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print.status("⚠️", `agent-dir migration: runtime-dir migration failed for "${agentName}": ${msg}`);
    result.errors += 1;
  }
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

  // Enumerate dirs directly instead of going through `loadAgents`.
  // `loadAgents` Zod-validates each entry and throws on the first
  // malformed file, which would abort migration for every healthy dir
  // below the bad one. Per-dir scoping lets us log + skip the broken
  // entry and keep reconciling the rest.
  let dirNames: string[];
  try {
    dirNames = readdirSync(agentsDir).filter((name) => {
      try {
        return statSync(join(agentsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print.status("⚠️", `agent-dir migration: unable to enumerate ${agentsDir}: ${msg}`);
    return { ...result, errors: result.errors + 1 };
  }

  // Track the set of local dir names that exist AFTER the loop so the
  // orphan-detection block can distinguish renamed-away state from
  // genuinely abandoned leftovers.
  const finalDirNames = new Set(dirNames);

  for (const dirName of dirNames) {
    const agentYamlPath = join(agentsDir, dirName, "agent.yaml");
    const oldWorkspace = join(workspacesDir, dirName);
    const agentId = readAgentId(agentYamlPath);
    if (!agentId) {
      // Non-agent directory, or a malformed yaml. Log only when a yaml
      // exists but didn't parse — a bare dir with no agent.yaml is
      // probably unrelated (dot-files, test fixtures).
      if (existsSync(agentYamlPath)) {
        print.status("⚠️", `agent-dir migration: unreadable ${agentYamlPath}; skipping this dir.`);
        result.errors += 1;
      }
      continue;
    }
    result.scanned += 1;

    let serverName: string | null;
    try {
      serverName = await resolver.resolveName(agentId);
    } catch (err) {
      // A network blip here shouldn't block startup — leave the dir alone
      // and continue with the rest. The next start attempts the rename
      // again; idempotent design means we don't leave the layout wedged.
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes("403") ? " (likely a non-admin account — migration skipped)" : "";
      print.status("⚠️", `agent-dir migration: failed to resolve "${dirName}" (${agentId}): ${msg}${hint}`);
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
    if (serverName === dirName) {
      migrateWorkspaceRuntimeDir(oldWorkspace, dirName, result);
      continue;
    }

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

    migrateWorkspaceRuntimeDir(oldWorkspace, dirName, result);

    try {
      renameSync(oldDir, newDir);
      finalDirNames.delete(dirName);
      finalDirNames.add(serverName);
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

    migrateWorkspaceRuntimeDir(newWorkspace, serverName, result);

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

    print.status("", `agent "${dirName}" renamed to "${serverName}" to match server`);
    result.renamed += 1;
  }

  // Enumerate ORPHANED workspace / session paths — those whose directory
  // name doesn't match any *current* local agent (after rename). We don't
  // auto-delete them (see crash-safety note above), but log a reminder so
  // the operator knows to run `agent workspace clean`. Crucially, the
  // comparison set is the *post-rename* `finalDirNames` — using both old
  // and new names would hide every workspace left behind by the rename
  // path, which is exactly what we want to surface.
  try {
    const orphanWs = existsSync(workspacesDir) ? readdirSync(workspacesDir).filter((d) => !finalDirNames.has(d)) : [];
    const orphanSessions = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter((f) => f.endsWith(".json") && !finalDirNames.has(f.slice(0, -5)))
      : [];
    if (orphanWs.length > 0 || orphanSessions.length > 0) {
      const parts: string[] = [];
      if (orphanWs.length > 0) parts.push(`workspaces: ${orphanWs.join(", ")}`);
      if (orphanSessions.length > 0) parts.push(`sessions: ${orphanSessions.join(", ")}`);
      print.status(
        "",
        `orphaned local state detected (${parts.join("; ")}). Run \`${channelConfig.binName} agent workspace clean\` to reclaim disk.`,
      );
    }
  } catch {
    // Best-effort: orphan detection is informational, never block start.
  }

  return result;
}
