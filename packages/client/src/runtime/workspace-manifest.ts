// Make a cloud agent home a valid W1 workspace so the shipped First Tree
// skills find the binding they expect.
//
// The shipped skills (pre-task hygiene in `first-tree`, and `first-tree-seed`'s
// self-check) locate their binding by walking up from cwd for
// `.first-tree/workspace.json` — a manifest that names the tree subdir and the
// bound source subdirs, ALL as immediate children of one workspace root (the
// "W1" layout, see `@first-tree/shared` `workspaceManifestSchema`).
//
// Per the agent-managed-repos design the Context Tree clone lives directly at
// `<workspace>/context-tree` — a real per-agent clone the agent itself
// maintains (clone-if-missing, pull-before-read; see the briefing protocol in
// `agent-briefing.ts`). The runtime writes only the manifest here; it neither
// clones nor links anything. Legacy homes may still carry a `context-tree`
// symlink into the retired shared `<dataDir>/context-tree-repos/` pool — that
// link is tolerated (reads through it keep working) until the agent replaces
// it with a real clone per its briefing; the runtime never deletes it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_MANIFEST_FILENAME, WORKSPACE_STATE_DIRNAME, workspaceManifestSchema } from "@first-tree/shared";

/**
 * Immediate-subdirectory name under the agent home where the agent maintains
 * its Context Tree clone, and the value written as the manifest's `tree`. A
 * reserved, fixed name (not derived from the repo) so the manifest is stable
 * across tree rebinds and re-clones.
 */
export const CONTEXT_TREE_DIRNAME = "context-tree";

/**
 * Ensure `<workspace>/.first-tree/workspace.json` records `{ tree, sources }`.
 *
 * A best-effort, idempotent, **never-throws-out** session-bootstrap step. The
 * agent home is shared across the agent's concurrent sessions, so the write
 * tolerates a racing peer and the whole block is wrapped — it must never fail
 * the session it runs in. Defensive rules:
 *   - Validates the manifest BEFORE touching the filesystem.
 *   - Drops source names that can't be immediate-subdir manifest entries
 *     (a nested `localPath` like `a/b`) rather than dropping the whole
 *     manifest; such a source is still materialised on disk, it just can't be
 *     expressed in `sources`.
 *   - Skips entirely when a declared source is named `context-tree` (the
 *     schema also forbids `tree` ∈ `sources`).
 *
 * The manifest may name a `tree` directory that does not exist yet — the
 * agent clones it on first use per its briefing protocol. The shipped
 * skills already treat a missing tree directory as "not yet materialised",
 * not as an invalid workspace.
 *
 * @param sourceNames immediate-subdir names of the bound source repos (the
 *   agent's resolved `gitRepos` localPaths). Pass the resolved set only — never
 *   call this with an unresolved/empty-as-unknown source set.
 */
export function ensureWorkspaceManifest(
  workspace: string,
  sourceNames: readonly string[],
  log?: (msg: string) => void,
): void {
  // Drop names that can't be immediate-subdir manifest entries (nested
  // `localPath`). Better than failing the whole manifest write.
  const usable = [...sourceNames].filter((name) => {
    if (isImmediateSubdirName(name)) return true;
    log?.(`workspace manifest: dropping source "${name}" — not an immediate subdirectory name`);
    return false;
  });

  if (usable.includes(CONTEXT_TREE_DIRNAME)) {
    log?.(`workspace manifest skipped: a source repo is named "${CONTEXT_TREE_DIRNAME}"`);
    return;
  }

  // Validate (and pre-serialize) BEFORE any filesystem mutation.
  let serialized: string;
  try {
    const manifest = workspaceManifestSchema.parse({ tree: CONTEXT_TREE_DIRNAME, sources: usable });
    serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (err) {
    log?.(`workspace manifest skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    const stateDir = join(workspace, WORKSPACE_STATE_DIRNAME);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, WORKSPACE_MANIFEST_FILENAME), serialized, "utf-8");
  } catch (err) {
    log?.(`workspace manifest write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Mirrors `workspaceManifestSchema`'s `subdirectoryNameSchema` rules. */
function isImmediateSubdirName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".")
  );
}
