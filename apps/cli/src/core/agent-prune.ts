import { existsSync, type RmOptions, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultConfigDir, defaultDataDir } from "@first-tree/shared/config";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Why a local alias is no longer usable from this client. Surfaced to
 * operators in `client doctor` and `agent prune` — knowing *why* a dir is
 * stale changes the next action (delete vs. go run it on the other machine).
 *
 * - `unreadable`        — agent.yaml missing, malformed, or has no agentId.
 * - `unowned`           — server doesn't return this agentId at all under
 *                         the current user (deleted, or never owned).
 * - `pinned-elsewhere`  — agentId belongs to the user but is pinned to a
 *                         *different* client. R-RUN would reject `bind`
 *                         on this machine; the agent is alive on the other.
 *
 * Suspended agents pinned to this client are not stale. The server still
 * returns them from `/me/pinned-agents` with `status: "suspended"` so prune
 * keeps their local config/workspace/session state for future reactivation.
 */
export type StaleAliasReason =
  | { kind: "unreadable"; error: string }
  | { kind: "unowned" }
  | { kind: "pinned-elsewhere"; clientId: string };

export type StaleAlias = {
  name: string;
  /** Null when the YAML couldn't be parsed enough to extract an agentId. */
  agentId: string | null;
  reason: StaleAliasReason;
};

export type PinnedAgent = { agentId: string; clientId: string; status?: string };

const minimalAgentYamlSchema = z
  .object({
    agentId: z.string().min(1),
  })
  .passthrough();

/**
 * Cross-reference local `agents/<name>/agent.yaml` files against the
 * server's pinned-agent set, returning every alias that won't bind on
 * THIS client.
 *
 * Why we don't use `loadAgents`:
 * `shared/config/loader.loadAgents` is fail-fast — one malformed
 * agent.yaml throws and the whole scan dies. The dominant prune target
 * IS the malformed dir (typo `agent add d`, half-written yaml, missing
 * agentId), so we walk dirs ourselves and degrade per-entry instead.
 *
 * Why we filter by clientId, not just userId:
 * `listPinnedAgents` (`/api/v1/me/pinned-agents`) returns every agent
 * pinned to ANY client this user owns (cross-machine). For prune the
 * relevant question is "will R-RUN accept it on THIS machine", which
 * needs `agents.client_id === current client.id`. Anything pinned on
 * another client is reported with `pinned-elsewhere` so the operator
 * can either re-pin or delete the local alias deliberately.
 */
export async function findStaleAliases(opts: {
  clientId: string;
  listPinnedAgents: () => Promise<PinnedAgent[]>;
  /** Override for tests; defaults to `$FIRST_TREE_HOME/config/agents`. */
  agentsDir?: string;
}): Promise<StaleAlias[]> {
  const agentsDir = opts.agentsDir ?? join(defaultConfigDir(), "agents");
  if (!existsSync(agentsDir)) return [];

  const remote = await opts.listPinnedAgents();
  const pinnedHere = new Set<string>();
  const pinnedElsewhere = new Map<string, string>();
  for (const r of remote) {
    if (r.clientId === opts.clientId) pinnedHere.add(r.agentId);
    else pinnedElsewhere.set(r.agentId, r.clientId);
  }

  const stale: StaleAlias[] = [];
  for (const entry of readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(agentDir).isDirectory();
    } catch {
      // Vanished between readdir and stat; ignore.
      continue;
    }
    if (!isDir) continue;

    const yamlPath = join(agentDir, "agent.yaml");
    if (!existsSync(yamlPath)) {
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: "missing agent.yaml" } });
      continue;
    }

    let agentId: string;
    try {
      const raw = parseYaml(readFileSync(yamlPath, "utf-8")) as unknown;
      const parsed = minimalAgentYamlSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]?.message ?? "schema error";
        stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: issue } });
        continue;
      }
      agentId = parsed.data.agentId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: msg } });
      continue;
    }

    if (pinnedHere.has(agentId)) continue;

    const otherClient = pinnedElsewhere.get(agentId);
    if (otherClient !== undefined) {
      stale.push({ name: entry, agentId, reason: { kind: "pinned-elsewhere", clientId: otherClient } });
    } else {
      stale.push({ name: entry, agentId, reason: { kind: "unowned" } });
    }
  }

  return stale;
}

/** Human-readable suffix for the per-alias listing. */
export function formatStaleReason(reason: StaleAliasReason): string {
  switch (reason.kind) {
    case "unreadable":
      return `unreadable: ${reason.error}`;
    case "unowned":
      return "no longer owned by you (deleted or transferred)";
    case "pinned-elsewhere":
      return `pinned to another client: ${reason.clientId}`;
  }
}

/**
 * Deletion-side agent-name gate for `removeLocalAgent`. Intentionally wider
 * than the create-side `AGENT_NAME_REGEX`: the server grandfathers rows
 * created under the previous 1–100 rule and `migrateLocalAgentDirs` renames
 * local dirs to those server-authoritative names, so grandfathered names
 * must stay removable here. The character set contains no `/`, `\` or `.`,
 * so a matching name can never form `.`, `..`, an absolute path, or any
 * other traversal segment.
 */
const REMOVABLE_AGENT_NAME_REGEX = /^[a-z0-9_-]{1,100}$/;

/**
 * Reject names that could steer the deletion paths below outside First Tree
 * state. `agent remove` also calls this before touching the filesystem so an
 * invalid name fails as a clean CLI error.
 */
export function assertRemovableAgentName(name: string): void {
  if (!REMOVABLE_AGENT_NAME_REGEX.test(name)) {
    throw new Error(`Invalid agent name ${JSON.stringify(name)}: expected 1-100 characters of [a-z0-9_-]`);
  }
}

// Verbatim copy of the private helper in core/context-tree-read.ts and
// commands/tree/context-links.ts — keep all three in sync.
function pathIsInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Resolve `entryName` against `baseDir` and enforce — lexically and on
 * realpaths — that the target stays inside `baseDir`; throws without
 * deleting anything otherwise. `resolve` (not `join`) so an absolute
 * `entryName` replaces the base wholesale and the lexical check rejects it.
 *
 * Returns the resolved path, never its realpath: `rmSync` must operate on
 * the symlink itself, so unlinking a link that points elsewhere inside
 * `baseDir` cannot delete the link's target.
 *
 * A missing target (including a dangling symlink — `existsSync` follows
 * links) is checked as its parent's realpath plus its own basename, so
 * stale links stay removable and `realpathSync` never sees ENOENT here.
 */
function resolveContainedTarget(baseDir: string, entryName: string, agentName: string): string {
  const outsideError = () =>
    new Error(`Refusing to remove ${JSON.stringify(agentName)}: resolves outside First Tree state`);
  const candidate = resolve(baseDir, entryName);
  if (!pathIsInside(baseDir, candidate)) throw outsideError();
  const realBase = realpathSync(baseDir);
  const realCandidate = existsSync(candidate)
    ? realpathSync(candidate)
    : join(realpathSync(dirname(candidate)), basename(candidate));
  if (!pathIsInside(realBase, realCandidate)) throw outsideError();
  return candidate;
}

/**
 * Remove an agent's local footprint: the YAML alias dir, the workspace
 * tree under `data/workspaces/<name>`, and the session-mapping file under
 * `data/sessions/<name>.json`. Shared by `agent remove` and `agent prune`.
 *
 * `name` reaches this function as raw user input, so it is gated twice
 * before anything is deleted: the whitelist rejects every traversal-capable
 * name, and each target must realpath-resolve inside its base dir
 * immediately before deletion, so an alias symlink pointing outside First
 * Tree state is refused rather than removed.
 */
export function removeLocalAgent(name: string): void {
  assertRemovableAgentName(name);
  const targets: Array<{ baseDir: string; entryName: string; options: RmOptions }> = [
    { baseDir: join(defaultConfigDir(), "agents"), entryName: name, options: { recursive: true, force: true } },
    { baseDir: join(defaultDataDir(), "workspaces"), entryName: name, options: { recursive: true, force: true } },
    { baseDir: join(defaultDataDir(), "sessions"), entryName: `${name}.json`, options: { force: true } },
  ];
  for (const { baseDir, entryName, options } of targets) {
    // A base dir that does not exist yet (fresh install) has nothing to
    // delete; the remaining targets are still processed independently.
    if (!existsSync(baseDir)) continue;
    rmSync(resolveContainedTarget(baseDir, entryName, name), options);
  }
}
