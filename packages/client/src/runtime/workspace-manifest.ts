// Make a cloud agent home a valid W1 workspace so the shipped First Tree
// skills find the binding they expect.
//
// The shipped skills (pre-task hygiene in `first-tree`, and `first-tree-seed`'s
// self-check) locate their binding by walking up from cwd for
// `.first-tree/workspace.json` — a manifest that names the tree subdir and the
// bound source subdirs, ALL as immediate children of one workspace root (the
// "W1" layout, see `@first-tree/shared` `workspaceManifestSchema`). A
// cloud-hosted agent doesn't naturally have that shape: its source repos sit at
// the agent-home top level (good), but the Context Tree is cloned to a SHARED
// external directory (dedup'd across every agent in the org) — not a sibling.
//
// To satisfy the W1 contract without giving up that cross-agent clone sharing,
// we expose the external clone inside the agent home as a symlink named
// `context-tree`, then write `.first-tree/workspace.json` naming that link as
// `tree`. The skills stay completely layout-agnostic; all the cloud-specific
// adaptation lives here, at the runtime boundary.

import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_MANIFEST_FILENAME, WORKSPACE_STATE_DIRNAME, workspaceManifestSchema } from "@first-tree/shared";

/**
 * Immediate-subdirectory name under the agent home that the Context Tree clone
 * is symlinked to, and the value written as the manifest's `tree`. A reserved,
 * fixed name (not derived from the repo) so the manifest is stable across tree
 * rebinds and re-clones.
 */
export const CONTEXT_TREE_LINK_DIRNAME = "context-tree";

/**
 * Ensure `<workspace>/context-tree` symlinks the external tree clone and
 * `<workspace>/.first-tree/workspace.json` records `{ tree, sources }`.
 *
 * A best-effort, idempotent, **never-throws-out** session-bootstrap step. The
 * agent home is shared across the agent's concurrent sessions, so every
 * filesystem step tolerates a racing peer, and the whole filesystem block is
 * wrapped — it must never fail the session it runs in. Defensive rules:
 *   - Validates the manifest BEFORE touching the filesystem, so a bad input
 *     never leaves a half-applied state (a symlink with no manifest).
 *   - Drops source names that can't be immediate-subdir manifest entries
 *     (a nested `localPath` like `a/b`) rather than dropping the whole manifest;
 *     such a source is still materialised on disk, it just can't be expressed
 *     in `sources`.
 *   - Skips entirely when a declared source is named `context-tree` (the schema
 *     also forbids `tree` ∈ `sources`) or when a real (non-symlink) entry
 *     occupies the link path — never clobbers checked-out code.
 *   - Re-points the symlink when the clone path changes (tree rebind / re-clone
 *     to a new digest dir), tolerating concurrent create/remove races.
 *
 * @param sourceNames immediate-subdir names of the bound source repos (the
 *   agent's resolved `gitRepos` localPaths). Pass the resolved set only — never
 *   call this with an unresolved/empty-as-unknown source set.
 */
export function ensureWorkspaceManifest(
  workspace: string,
  contextTreePath: string,
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

  if (usable.includes(CONTEXT_TREE_LINK_DIRNAME)) {
    log?.(`workspace manifest skipped: a source repo is named "${CONTEXT_TREE_LINK_DIRNAME}"`);
    return;
  }

  // Validate (and pre-serialize) BEFORE any filesystem mutation so an invalid
  // input never leaves a symlink without a manifest.
  let serialized: string;
  try {
    const manifest = workspaceManifestSchema.parse({ tree: CONTEXT_TREE_LINK_DIRNAME, sources: usable });
    serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (err) {
    log?.(`workspace manifest skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    if (!ensureTreeSymlink(join(workspace, CONTEXT_TREE_LINK_DIRNAME), contextTreePath, log)) return;
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

/**
 * Create / repair the `<workspace>/context-tree` → clone symlink, tolerating a
 * racing peer (the agent home is shared across concurrent sessions). Returns
 * `false` when a real file/dir occupies the path (so the caller writes no
 * manifest, which would otherwise name a tree that isn't actually linked).
 */
function ensureTreeSymlink(linkPath: string, target: string, log?: (msg: string) => void): boolean {
  // Already correct — the steady state and the concurrent-winner case.
  if (readlinkOrNull(linkPath) === target) return true;

  const stat = lstatOrNull(linkPath);
  if (stat && !stat.isSymbolicLink()) {
    log?.(`workspace manifest skipped: "${CONTEXT_TREE_LINK_DIRNAME}" exists and is not a symlink — not clobbering`);
    return false;
  }
  // Missing, or a stale symlink (tree re-cloned to a new digest dir). Remove a
  // stale link if present, then (re)create — tolerating a peer that created or
  // removed it underneath us.
  if (stat) {
    try {
      unlinkSync(linkPath);
    } catch (err) {
      if (nodeErrCode(err) !== "ENOENT") throw err;
    }
  }
  try {
    symlinkSync(target, linkPath);
  } catch (err) {
    // A concurrent session created it first. Accept iff it points where we want.
    if (nodeErrCode(err) === "EEXIST") return readlinkOrNull(linkPath) === target;
    throw err;
  }
  return true;
}

function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function nodeErrCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}
