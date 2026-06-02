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
       * clean up. Derived from the tree's `.first-tree/bindings/*.json` if
       * present, otherwise from sibling subdirs containing a legacy
       * `source.json`.
       */
      sourceRoots: string[];
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

function siblingPathFromSourceState(sourceRoot: string, sourceState: Record<string, unknown>): string | undefined {
  const tree = sourceState.tree;
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    return undefined;
  }
  const localPath = (tree as Record<string, unknown>).localPath;
  if (typeof localPath !== "string" || localPath.length === 0) {
    return undefined;
  }
  return isAbsolute(localPath) ? resolve(localPath) : resolve(sourceRoot, localPath);
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
  if (isFile(join(resolved, WORKSPACE_MARKER)) || pickTreeAmongChildren(resolved) !== undefined) {
    const treeRoot = pickTreeAmongChildren(resolved);
    if (treeRoot === undefined) {
      return {
        kind: "not-applicable",
        reason: `Found legacy workspace marker at ${resolved} but no child directory contains a tree binding (.first-tree/bindings/).`,
      };
    }

    const treeName = basename(treeRoot);
    const declaredSources = readBindingsSourceNames(treeRoot);
    const sourceRoots: string[] = [];
    for (const name of declaredSources) {
      const candidate = join(resolved, name);
      if (isDirectory(candidate)) {
        sourceRoots.push(candidate);
      }
    }

    // Fallback: scan workspace children for a `.first-tree/source.json` if the
    // bindings dir was missing or incomplete.
    if (sourceRoots.length === 0) {
      for (const childName of listImmediateChildDirs(resolved)) {
        if (childName === treeName) {
          continue;
        }
        const candidate = join(resolved, childName);
        if (isFile(join(candidate, SOURCE_STATE_FILE))) {
          sourceRoots.push(candidate);
        }
      }
    }

    return { kind: "workspace", workspaceRoot: resolved, treeRoot, sourceRoots };
  }

  // 3. Cwd is a single source repo with a sibling tree (`shared-source` or
  //    `standalone-source`). Needs a promote step before Case A can run.
  const sourceStatePath = join(resolved, SOURCE_STATE_FILE);
  if (isFile(sourceStatePath)) {
    const sourceState = readJsonObject(sourceStatePath);
    const treeRoot = sourceState ? siblingPathFromSourceState(resolved, sourceState) : undefined;
    if (treeRoot !== undefined && isDirectory(treeRoot)) {
      return {
        kind: "promotable-source",
        sourceRoot: resolved,
        treeRoot,
        suggestedWorkspaceName: `${basename(resolved)}-workspace`,
      };
    }
    return {
      kind: "not-applicable",
      reason: `${sourceStatePath} found but its tree.localPath does not resolve to an existing directory.`,
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

  // Step 1: clean each source repo.
  for (const sourceRoot of sourceRootsByName.values()) {
    cleanSourceRepo(detection.workspaceRoot, sourceRoot, result, dryRun);
  }

  // Step 2: clean the tree repo.
  cleanTreeRepo(detection.workspaceRoot, detection.treeRoot, result, dryRun);

  // Step 3: drop the legacy workspace marker file.
  const markerPath = join(detection.workspaceRoot, WORKSPACE_MARKER);
  if (tryRemove(markerPath, { dryRun })) {
    result.removed.push({ path: relative(detection.workspaceRoot, markerPath), kind: "workspace-marker" });
  }

  // Step 4: write the W1 manifest. Done last so a mid-failure on cleanup
  // doesn't leave the workspace claiming W1 state when legacy state still
  // partly survives.
  if (!dryRun) {
    writeWorkspaceManifest(detection.workspaceRoot, manifest);
  }

  return result;
}
