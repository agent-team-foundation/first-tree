import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { type WorkspaceManifest, workspaceManifestSchema } from "@first-tree/shared";

import { writeWorkspaceManifest } from "./workspace.js";

/**
 * `first-tree tree migrate-to-w1` — converge a workspace from the legacy
 * multi-mode binding model onto the workspace-rooted layout (§W1) defined in
 *   first-tree-context: first-tree-skill-cli/workspace-layout-simplification.md
 *
 * The migration is one-way and non-transactional but never commits to git:
 * every change is left as a working-tree edit for the user to inspect and
 * commit. Three legacy starting points converge on the same Case A flow:
 *
 *   Case A — already a workspace (workspace-root marker or tree with bindings/)
 *   Case B — single repo bound to a sibling shared tree (`shared-source`)
 *   Case C — single repo bound to a sibling dedicated tree (`standalone-source`)
 *
 * Cases B and C require a *promote* step that materializes a parent
 * directory and moves both repos into it before the Case A cleanup can
 * proceed. The promote step is destructive on disk (file moves), so the CLI
 * layer prompts the user for confirmation before invoking it. Once
 * promoted, the migration writes `<workspace>/.first-tree/workspace.json`
 * and strips legacy state from the tree and each source repo.
 */

const WORKSPACE_MARKER = ".first-tree-workspace";
const TREE_RUNTIME_DIR = ".first-tree";
const TREE_BINDINGS_DIR = join(TREE_RUNTIME_DIR, "bindings");
const TREE_BOOTSTRAP_FILE = join(TREE_RUNTIME_DIR, "bootstrap.json");
const TREE_STATE_FILE = join(TREE_RUNTIME_DIR, "tree.json");
const TREE_SOURCE_REPOS_FILE = "source-repos.md";
const SOURCE_STATE_FILE = join(TREE_RUNTIME_DIR, "source.json");
const SOURCE_SKILL_DIRS = [join(".agents", "skills"), join(".claude", "skills")] as const;
const SOURCE_WHITEPAPER_FILE = "WHITEPAPER.md";
const SOURCE_FRAMEWORK_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const SOURCE_INTEGRATION_BLOCK_RE =
  /<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->[\s\S]*?<!-- END FIRST-TREE-SOURCE-INTEGRATION -->\n?/mu;

export type MigrationDetection =
  | { kind: "already-migrated"; workspaceRoot: string }
  | {
      kind: "workspace";
      workspaceRoot: string;
      treeRoot: string;
      /**
       * Absolute paths to bound source repo roots that the migration will
       * clean up. Detection takes the union of two scans: (a) the tree's
       * `.first-tree/bindings/*.json` resolved by `sourceName` to a child
       * dir, and (b) immediate child dirs of `workspaceRoot` that carry a
       * legacy `.first-tree/source.json`. Both scans are always run and
       * deduped by resolved path, so a stale `sourceName` in one binding
       * file cannot silently un-bind a real source repo.
       */
      sourceRoots: string[];
      /**
       * Names from `<tree>/.first-tree/bindings/*.json` whose corresponding
       * `<workspaceRoot>/<name>/` directory does not exist on disk. Surfaced
       * by the CLI as warnings so the user knows the migration could not
       * clean those — they may have been deleted, renamed, or never cloned.
       */
      missingFromBindings?: string[];
    }
  | {
      kind: "promotable-source";
      sourceRoot: string;
      treeRoot: string;
      /**
       * Default workspace name suggestion (`<source>-workspace`). The CLI
       * may override via `--workspace-name`.
       */
      suggestedWorkspaceName: string;
    }
  | { kind: "not-applicable"; reason: string };

export type MigrationResult = {
  workspaceRoot: string;
  manifest: WorkspaceManifest;
  /**
   * Paths that were removed (relative to `workspaceRoot`), grouped by what
   * they were. Files that did not exist are not reported.
   */
  removed: { path: string; kind: MigrationArtifactKind }[];
  /**
   * Paths whose contents changed (e.g. AGENTS.md after framework block
   * strip). Files we touched but did not write changes to are not
   * reported.
   */
  modified: { path: string; kind: MigrationArtifactKind }[];
  /**
   * Non-fatal anomalies (e.g. binding file pointing at a source name that
   * does not exist on disk). Reported so the CLI can surface them.
   */
  warnings: string[];
  /** When true, no disk changes were made. */
  dryRun: boolean;
};

export type MigrationArtifactKind =
  | "workspace-marker"
  | "source-state"
  | "source-state-dir"
  | "source-skills"
  | "source-whitepaper"
  | "source-framework-block"
  | "tree-bindings"
  | "tree-bootstrap"
  | "tree-state"
  | "tree-source-repos-index";

export type MigrateOptions = {
  /** When true, no disk changes are made. The result reports what would happen. */
  dryRun?: boolean;
};

export type PromoteOptions = {
  /** Workspace dir name to materialize. Defaults to `<source>-workspace`. */
  workspaceName?: string;
  /** When true, no disk changes are made; the planned new paths are returned. */
  dryRun?: boolean;
};

export type PromoteResult = {
  workspaceRoot: string;
  newSourceRoot: string;
  newTreeRoot: string;
  dryRun: boolean;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function listImmediateChildDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function hasTreeBindings(candidatePath: string): boolean {
  return isDirectory(join(candidatePath, TREE_BINDINGS_DIR));
}

function readBindingsSourceNames(treeRoot: string): string[] {
  const bindingsDir = join(treeRoot, TREE_BINDINGS_DIR);
  if (!isDirectory(bindingsDir)) {
    return [];
  }

  const names = new Set<string>();
  try {
    for (const entry of readdirSync(bindingsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const parsed = readJsonObject(join(bindingsDir, entry.name));
      const sourceName = typeof parsed?.sourceName === "string" ? parsed.sourceName : undefined;
      if (sourceName && sourceName.length > 0) {
        names.add(sourceName);
      }
    }
  } catch {
    /* fall through with whatever names were collected */
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

type SiblingTreeResolution = { ok: true; treeRoot: string } | { ok: false; reason: string };

function siblingTreeFromSourceState(sourceRoot: string, sourceState: Record<string, unknown>): SiblingTreeResolution {
  const tree = sourceState.tree;
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    return { ok: false, reason: "source.json has no `tree` object" };
  }
  const localPath = (tree as Record<string, unknown>).localPath;
  if (typeof localPath !== "string" || localPath.length === 0) {
    return { ok: false, reason: "source.json `tree.localPath` is missing or empty" };
  }
  const resolvedTree = isAbsolute(localPath) ? resolve(localPath) : resolve(sourceRoot, localPath);
  // `promotable-source` is specifically the legacy "single repo with sibling
  // tree" layout; an absolute or `..`-escaping `localPath` that points
  // outside the source's parent dir is not a sibling and must not be
  // promoted into the workspace by a one-way `mv`. Reject those cases.
  if (dirname(resolvedTree) !== dirname(sourceRoot)) {
    return {
      ok: false,
      reason: `source.json points at ${resolvedTree}, which is not a sibling of ${sourceRoot}`,
    };
  }
  return { ok: true, treeRoot: resolvedTree };
}

function pickTreeAmongChildren(workspaceRoot: string): string | undefined {
  for (const childName of listImmediateChildDirs(workspaceRoot)) {
    const childPath = join(workspaceRoot, childName);
    if (hasTreeBindings(childPath)) {
      return childPath;
    }
  }
  return undefined;
}

/**
 * Classify the cwd into one of the four migration buckets. Read-only; never
 * touches disk beyond `stat` / `readFile` / `readdir`.
 */
export function detectMigrationState(cwd: string): MigrationDetection {
  const resolved = resolve(cwd);

  // 1. Already on the new model.
  if (isFile(join(resolved, ".first-tree", "workspace.json"))) {
    return { kind: "already-migrated", workspaceRoot: resolved };
  }

  // 2. Cwd is a workspace root that hasn't been migrated yet — either has the
  //    legacy `.first-tree-workspace` marker, or contains a tree subdir with
  //    `bindings/`. Both shapes converge on Case A.
  const markerPresent = isFile(join(resolved, WORKSPACE_MARKER));
  const treeRoot = pickTreeAmongChildren(resolved);
  if (markerPresent || treeRoot !== undefined) {
    if (treeRoot === undefined) {
      return {
        kind: "not-applicable",
        reason: `Found legacy workspace marker at ${resolved} but no child directory contains a tree binding (.first-tree/bindings/).`,
      };
    }

    const treeName = basename(treeRoot);
    const declaredSources = readBindingsSourceNames(treeRoot);
    const sourceRoots: string[] = [];
    const seen = new Set<string>();
    const missingFromBindings: string[] = [];

    for (const name of declaredSources) {
      const candidate = join(resolved, name);
      if (isDirectory(candidate)) {
        sourceRoots.push(candidate);
        seen.add(candidate);
      } else {
        missingFromBindings.push(name);
      }
    }

    // Always run the filesystem fallback (in addition to bindings) so that a
    // partially-resolved bindings dir cannot silently drop a real source repo
    // that still carries `.first-tree/source.json` on disk. Without this,
    // migrating from a workspace where bindings/ holds a stale entry for
    // `api` but `web/.first-tree/source.json` is real would write a manifest
    // missing `web` and leave `web`'s legacy state intact.
    for (const childName of listImmediateChildDirs(resolved)) {
      if (childName === treeName) {
        continue;
      }
      const candidate = join(resolved, childName);
      if (seen.has(candidate)) {
        continue;
      }
      if (isFile(join(candidate, SOURCE_STATE_FILE))) {
        sourceRoots.push(candidate);
        seen.add(candidate);
      }
    }

    return {
      kind: "workspace",
      workspaceRoot: resolved,
      treeRoot,
      sourceRoots,
      ...(missingFromBindings.length > 0 ? { missingFromBindings } : {}),
    };
  }

  // 3. Cwd is a single source repo with a sibling tree (`shared-source` or
  //    `standalone-source`). Needs a promote step before Case A can run.
  const sourceStatePath = join(resolved, SOURCE_STATE_FILE);
  if (isFile(sourceStatePath)) {
    // Guard: refuse to promote if the user is inside a workspace-member
    // source whose parent is already populated as a legacy workspace —
    // either has the `.first-tree-workspace` marker, or holds at least one
    // OTHER source sibling. Moving this source + its tree out of that
    // parent breaks the parent workspace (the other sources lose their
    // tree). Tell the user to cd up and re-run instead.
    //
    // We deliberately do NOT trip on "parent has a tree with bindings/" by
    // itself — for a true two-sibling legacy `shared-source` /
    // `standalone-source` layout (just source + tree at the parent),
    // promoting them into a dedicated workspace dir is the spec's
    // intended action and there are no other members to break.
    const parentDir = dirname(resolved);
    const parentHasMarker = isFile(join(parentDir, WORKSPACE_MARKER));
    let parentHasOtherSourceSibling = false;
    for (const siblingName of listImmediateChildDirs(parentDir)) {
      if (join(parentDir, siblingName) === resolved) {
        continue;
      }
      if (isFile(join(parentDir, siblingName, SOURCE_STATE_FILE))) {
        parentHasOtherSourceSibling = true;
        break;
      }
    }
    if (parentHasMarker || parentHasOtherSourceSibling) {
      return {
        kind: "not-applicable",
        reason:
          `${resolved} appears to be a member of a legacy workspace at ${parentDir} ` +
          `(detected via .first-tree-workspace marker or another source sibling). ` +
          `cd to ${parentDir} and re-run migrate-to-w1 from there so the other members are migrated together.`,
      };
    }

    const sourceState = readJsonObject(sourceStatePath);
    if (sourceState === undefined) {
      return {
        kind: "not-applicable",
        reason: `${sourceStatePath} exists but could not be parsed as JSON.`,
      };
    }
    const resolution = siblingTreeFromSourceState(resolved, sourceState);
    if (resolution.ok && isDirectory(resolution.treeRoot)) {
      return {
        kind: "promotable-source",
        sourceRoot: resolved,
        treeRoot: resolution.treeRoot,
        suggestedWorkspaceName: `${basename(resolved)}-workspace`,
      };
    }
    return {
      kind: "not-applicable",
      reason: resolution.ok
        ? `${sourceStatePath} resolves a tree path at ${resolution.treeRoot} but that path is not an existing directory.`
        : `Cannot promote ${resolved}: ${resolution.reason}.`,
    };
  }

  return {
    kind: "not-applicable",
    reason: `No legacy first-tree state detected at ${resolved} (looked for .first-tree-workspace, tree/.first-tree/bindings/, and .first-tree/source.json).`,
  };
}

/**
 * Promote a single source repo + sibling tree into a parent workspace dir.
 * Materializes `<parent>/<workspaceName>/`, then `rename`s both repos into
 * it. The CLI layer is responsible for getting explicit user confirmation
 * before calling this — the moves are observable to git (each repo's
 * `.git/` travels with it but the absolute path changes).
 */
export function promoteToWorkspace(
  detection: Extract<MigrationDetection, { kind: "promotable-source" }>,
  options: PromoteOptions = {},
): PromoteResult {
  const workspaceName = options.workspaceName ?? detection.suggestedWorkspaceName;
  if (workspaceName.length === 0 || workspaceName.includes("/") || workspaceName.includes("\\")) {
    throw new Error(`Invalid workspace name: ${JSON.stringify(workspaceName)}`);
  }

  const parentDir = dirname(detection.sourceRoot);
  const workspaceRoot = join(parentDir, workspaceName);
  const newSourceRoot = join(workspaceRoot, basename(detection.sourceRoot));
  const newTreeRoot = join(workspaceRoot, basename(detection.treeRoot));

  const dryRun = options.dryRun === true;
  if (dryRun) {
    return { workspaceRoot, newSourceRoot, newTreeRoot, dryRun };
  }

  if (existsSync(workspaceRoot)) {
    throw new Error(`Refusing to promote: ${workspaceRoot} already exists. Pick a different --workspace-name.`);
  }

  mkdirSync(workspaceRoot, { recursive: false });
  try {
    renameSync(detection.sourceRoot, newSourceRoot);
    renameSync(detection.treeRoot, newTreeRoot);
  } catch (error) {
    // Best effort: try to undo the partial move so the user can re-run.
    try {
      if (existsSync(newSourceRoot) && !existsSync(detection.sourceRoot)) {
        renameSync(newSourceRoot, detection.sourceRoot);
      }
      if (existsSync(newTreeRoot) && !existsSync(detection.treeRoot)) {
        renameSync(newTreeRoot, detection.treeRoot);
      }
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* swallow — original error is more informative */
    }
    throw error;
  }

  return { workspaceRoot, newSourceRoot, newTreeRoot, dryRun };
}

function stripFrameworkBlock(
  filePath: string,
  options: { dryRun: boolean },
): { changed: boolean; modifiedPath?: string } {
  if (!isFile(filePath)) {
    return { changed: false };
  }
  // Note on line endings: this helper normalizes CRLF→LF up front and writes
  // LF unconditionally on change. That changes the whole-file ending style of
  // CRLF-authored files. In practice the only file this helper writes is one
  // where the `<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->` block exists,
  // which is itself authored by first-tree tooling and shipped as LF — so a
  // CRLF host file with that block is the artifact of an editor / VCS
  // configuration that already disagrees with how the file was authored.
  // The change is safe (and effectively a no-op) for the supported flow; if
  // a future use case needs faithful CRLF preservation, swap to a regex
  // splice that touches only the block bytes.
  const raw = readFileSync(filePath, "utf-8").replaceAll("\r\n", "\n");
  if (!SOURCE_INTEGRATION_BLOCK_RE.test(raw)) {
    return { changed: false };
  }
  const next = raw.replace(SOURCE_INTEGRATION_BLOCK_RE, "");
  // Trim consecutive blank lines that the block strip might leave behind, but
  // preserve a single trailing newline so the file stays well-formed.
  const collapsed = next.replace(/\n{3,}/gu, "\n\n");
  const final = collapsed.endsWith("\n") ? collapsed : `${collapsed}\n`;
  if (final === raw) {
    return { changed: false };
  }
  if (!options.dryRun) {
    writeFileSync(filePath, final, "utf-8");
  }
  return { changed: true, modifiedPath: filePath };
}

function tryRemove(target: string, options: { dryRun: boolean; recursive?: boolean }): boolean {
  if (!existsSync(target)) {
    return false;
  }
  if (options.dryRun) {
    return true;
  }
  rmSync(target, { recursive: options.recursive === true, force: true });
  return true;
}

function tryRemoveDirIfEmpty(dirPath: string, options: { dryRun: boolean }): boolean {
  if (!isDirectory(dirPath)) {
    return false;
  }
  try {
    const entries = readdirSync(dirPath);
    if (entries.length > 0) {
      return false;
    }
  } catch {
    return false;
  }
  if (options.dryRun) {
    return true;
  }
  // `rmSync(dir, { recursive: false, force: true })` still throws EISDIR on a
  // directory — `force` only suppresses ENOENT. The guards above ensure the
  // dir exists and is empty, so `rmdirSync` is the right primitive here.
  rmdirSync(dirPath);
  return true;
}

function cleanSourceRepo(workspaceRoot: string, sourceRoot: string, result: MigrationResult, dryRun: boolean): void {
  const reportPath = (absolute: string): string => relative(workspaceRoot, absolute) || ".";

  if (tryRemove(join(sourceRoot, SOURCE_STATE_FILE), { dryRun })) {
    result.removed.push({ path: reportPath(join(sourceRoot, SOURCE_STATE_FILE)), kind: "source-state" });
  }

  if (tryRemoveDirIfEmpty(join(sourceRoot, TREE_RUNTIME_DIR), { dryRun })) {
    result.removed.push({
      path: reportPath(join(sourceRoot, TREE_RUNTIME_DIR)),
      kind: "source-state-dir",
    });
  }

  for (const skillDir of SOURCE_SKILL_DIRS) {
    if (tryRemove(join(sourceRoot, skillDir), { dryRun, recursive: true })) {
      result.removed.push({ path: reportPath(join(sourceRoot, skillDir)), kind: "source-skills" });
    }
  }

  if (tryRemove(join(sourceRoot, SOURCE_WHITEPAPER_FILE), { dryRun })) {
    result.removed.push({
      path: reportPath(join(sourceRoot, SOURCE_WHITEPAPER_FILE)),
      kind: "source-whitepaper",
    });
  }

  for (const filename of SOURCE_FRAMEWORK_FILES) {
    const filePath = join(sourceRoot, filename);
    const outcome = stripFrameworkBlock(filePath, { dryRun });
    if (outcome.changed && outcome.modifiedPath !== undefined) {
      result.modified.push({ path: reportPath(outcome.modifiedPath), kind: "source-framework-block" });
    }
  }
}

function cleanTreeRepo(workspaceRoot: string, treeRoot: string, result: MigrationResult, dryRun: boolean): void {
  const reportPath = (absolute: string): string => relative(workspaceRoot, absolute) || ".";

  if (tryRemove(join(treeRoot, TREE_BINDINGS_DIR), { dryRun, recursive: true })) {
    result.removed.push({ path: reportPath(join(treeRoot, TREE_BINDINGS_DIR)), kind: "tree-bindings" });
  }

  if (tryRemove(join(treeRoot, TREE_BOOTSTRAP_FILE), { dryRun })) {
    result.removed.push({ path: reportPath(join(treeRoot, TREE_BOOTSTRAP_FILE)), kind: "tree-bootstrap" });
  }

  // The spec says "remove binding-related fields from .first-tree/tree.json;
  // remove the file entirely if it becomes empty". In the legacy schema every
  // field on tree.json is binding-related (treeId, treeMode, treeRepoName,
  // schemaVersion, published.remoteUrl), so deleting the file is the result of
  // following the rule strictly.
  if (tryRemove(join(treeRoot, TREE_STATE_FILE), { dryRun })) {
    result.removed.push({ path: reportPath(join(treeRoot, TREE_STATE_FILE)), kind: "tree-state" });
  }

  if (tryRemove(join(treeRoot, TREE_SOURCE_REPOS_FILE), { dryRun })) {
    result.removed.push({
      path: reportPath(join(treeRoot, TREE_SOURCE_REPOS_FILE)),
      kind: "tree-source-repos-index",
    });
  }
}

/**
 * Synthesize a dry-run cleanup plan for a `promotable-source` detection
 * *before* the actual `mv` runs. Because the planned post-move paths don't
 * exist yet, calling {@link migrateWorkspaceToW1} against them would report
 * an empty plan (every `tryRemove`/`stripFrameworkBlock` would see no
 * files) and mislead the user about the real cleanup's blast radius.
 *
 * Instead we run cleanup detection against the still-live pre-move layout
 * (parent dir treated as the synthetic workspace root for path-relativizing
 * purposes), then re-anchor `workspaceRoot` to the planned post-move
 * location so the report describes what the real run will produce.
 *
 * The reported relative paths preserve the source / tree basenames and
 * therefore describe the post-move shape correctly (e.g. `api/AGENTS.md`,
 * `context/.first-tree/bindings`).
 */
export function planPromotableDryRun(
  detection: Extract<MigrationDetection, { kind: "promotable-source" }>,
  plannedWorkspaceRoot: string,
): MigrationResult {
  const parentDir = dirname(detection.sourceRoot);
  const planned = migrateWorkspaceToW1(
    {
      kind: "workspace",
      workspaceRoot: parentDir,
      treeRoot: detection.treeRoot,
      sourceRoots: [detection.sourceRoot],
    },
    { dryRun: true },
  );
  return {
    ...planned,
    workspaceRoot: plannedWorkspaceRoot,
  };
}

/**
 * Convert a detected Case-A workspace onto the new layout. Caller is
 * responsible for promoting `promotable-source` detections into Case A
 * first (via {@link promoteToWorkspace}). Returns a structured summary the
 * CLI layer can render.
 */
export function migrateWorkspaceToW1(
  detection: Extract<MigrationDetection, { kind: "workspace" }>,
  options: MigrateOptions = {},
): MigrationResult {
  const dryRun = options.dryRun === true;
  const treeName = basename(detection.treeRoot);

  // Source names for the manifest = subdir names of the resolved source roots,
  // not whatever sourceName the binding file claimed (that field can drift).
  const sourceNames = detection.sourceRoots
    .map((sourceRoot) => basename(sourceRoot))
    .filter((name) => name !== treeName && !name.includes("/") && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b));

  // Dedupe while preserving sort.
  const dedupedSources = [...new Set(sourceNames)];

  const manifest = workspaceManifestSchema.parse({ tree: treeName, sources: dedupedSources });

  const result: MigrationResult = {
    workspaceRoot: detection.workspaceRoot,
    manifest,
    removed: [],
    modified: [],
    warnings: [],
    dryRun,
  };

  // Surface detection-time warnings (e.g. binding files that pointed at a
  // source name with no matching subdir) so the CLI can show them.
  if (detection.missingFromBindings !== undefined) {
    for (const name of detection.missingFromBindings) {
      result.warnings.push(
        `Tree binding declares source "${name}" but ${join(detection.workspaceRoot, name)} does not exist; ` +
          `migration could not clean its legacy state.`,
      );
    }
  }

  // Validate that each declared source actually lives at workspaceRoot/<name>.
  const sourceRootsByName = new Map<string, string>();
  for (const sourceRoot of detection.sourceRoots) {
    const name = basename(sourceRoot);
    if (resolve(sourceRoot) !== resolve(join(detection.workspaceRoot, name))) {
      result.warnings.push(
        `Source ${name} resolves to ${sourceRoot}, which is not an immediate child of ${detection.workspaceRoot}; skipping cleanup for it.`,
      );
      continue;
    }
    sourceRootsByName.set(name, resolve(sourceRoot));
  }

  // Step 1: write the W1 manifest FIRST. If a later cleanup step fails
  // partway, the workspace at least gains the new detection signal so
  // `migrate-to-w1` can be safely re-run. The prior order (manifest last)
  // had a partial-failure mode where the cleanup steps had wiped every
  // legacy detection marker (bindings/, source.json, .first-tree-workspace)
  // before the manifest write threw, leaving the user in a state where
  // re-detection saw nothing at all.
  if (!dryRun) {
    writeWorkspaceManifest(detection.workspaceRoot, manifest);
  }

  // Step 2: clean each source repo.
  for (const sourceRoot of sourceRootsByName.values()) {
    cleanSourceRepo(detection.workspaceRoot, sourceRoot, result, dryRun);
  }

  // Step 3: clean the tree repo.
  cleanTreeRepo(detection.workspaceRoot, detection.treeRoot, result, dryRun);

  // Step 4: drop the legacy workspace marker file last so its absence is the
  // commit signal that the cleanup ran. If anything earlier in steps 2/3
  // fails, the marker survives and re-detection still hits the workspace
  // branch.
  const markerPath = join(detection.workspaceRoot, WORKSPACE_MARKER);
  if (tryRemove(markerPath, { dryRun })) {
    result.removed.push({ path: relative(detection.workspaceRoot, markerPath), kind: "workspace-marker" });
  }

  return result;
}
