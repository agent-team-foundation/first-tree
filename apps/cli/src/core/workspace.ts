import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_STATE_DIRNAME,
  type WorkspaceManifest,
  workspaceManifestSchema,
} from "@first-tree/shared";

/**
 * Workspace-rooted layout simplification — runtime helpers.
 *
 * Implements §Discovery Rules from
 *   first-tree-context: first-tree-skill-cli/workspace-layout-simplification.md
 *
 * - {@link discoverWorkspaceRoot}: walk up from a cwd looking for the closest
 *   ancestor with `.first-tree/workspace.json`.
 * - {@link readWorkspaceManifest}: load + validate the manifest.
 * - {@link writeWorkspaceManifest}: persist a validated manifest (single
 *   `writeFileSync`; single-writer local file — no temp-and-rename).
 * - {@link computeWorkspaceStatus}: derive the report consumed by
 *   `first-tree tree status` (bound sources, unbound git siblings, missing
 *   sources).
 *
 * None of these helpers touch source repo internals or write outside the
 * workspace root's `.first-tree/` directory. Source repo state inspection
 * is read-only.
 */

const WORKSPACE_MANIFEST_RELATIVE_PATH = join(WORKSPACE_STATE_DIRNAME, WORKSPACE_MANIFEST_FILENAME);

export type WorkspaceBoundSource = {
  /** Immediate subdirectory name as written in `workspace.json.sources`. */
  name: string;
  /** Absolute path on disk. May not exist when `present` is `false`. */
  path: string;
  /** Whether the subdirectory exists on disk. */
  present: boolean;
  /**
   * `origin` remote URL from `git remote get-url`, when the subdirectory
   * exists on disk and has a remote. Absent when the subdirectory is
   * missing or has no `origin` remote configured.
   */
  remoteUrl?: string;
};

export type WorkspaceUnboundSibling = {
  /** Immediate subdirectory name. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** `origin` remote URL, when configured. */
  remoteUrl?: string;
};

export type WorkspaceStatus = {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Parsed manifest. */
  manifest: WorkspaceManifest;
  /** Absolute path to the tree subdirectory (whether or not it exists). */
  treePath: string;
  /** Whether the tree subdirectory exists on disk. */
  treePresent: boolean;
  /**
   * `origin` remote URL of the tree subdirectory when it exists on disk and
   * has one configured. Absent otherwise.
   */
  treeRemoteUrl?: string;
  /** Bound source entries from the manifest, each annotated with on-disk presence. */
  boundSources: WorkspaceBoundSource[];
  /**
   * Git subdirectories present at the workspace root that are not listed as
   * the tree and not listed in `sources`. Discovery candidates for `add`.
   */
  unboundGitSiblings: WorkspaceUnboundSibling[];
  /**
   * Subset of `boundSources` whose subdirectory does not exist on disk
   * (typically because the user has not cloned them on this machine).
   */
  missingBoundSources: WorkspaceBoundSource[];
};

/**
 * Walk up from `startDir` looking for the closest ancestor directory whose
 * `.first-tree/workspace.json` exists. Returns the absolute path to that
 * ancestor, or `undefined` if no workspace root is found before the filesystem
 * root.
 *
 * The search does not follow symlinks beyond what `node:path.resolve` already
 * normalizes, and does not cross filesystem boundaries explicitly — Node's
 * `existsSync` is the only signal used.
 */
export function discoverWorkspaceRoot(startDir: string): string | undefined {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, WORKSPACE_MANIFEST_RELATIVE_PATH))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/**
 * Read and validate `<workspaceRoot>/.first-tree/workspace.json`.
 *
 * Throws if the file does not exist, is not valid JSON, or fails schema
 * validation. Callers that want a soft "is this a workspace?" check should
 * use {@link discoverWorkspaceRoot} first.
 */
export function readWorkspaceManifest(workspaceRoot: string): WorkspaceManifest {
  const manifestPath = join(workspaceRoot, WORKSPACE_MANIFEST_RELATIVE_PATH);
  const raw = readFileSync(manifestPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return workspaceManifestSchema.parse(parsed);
}

/**
 * Validate and write `<workspaceRoot>/.first-tree/workspace.json`. Creates
 * the `.first-tree/` directory if missing. Writes with a trailing newline and
 * stable 2-space indentation so diffs stay readable.
 *
 * Throws if the supplied manifest fails schema validation; the file is not
 * touched in that case.
 */
export function writeWorkspaceManifest(workspaceRoot: string, manifest: WorkspaceManifest): void {
  const validated = workspaceManifestSchema.parse(manifest);
  const stateDir = join(workspaceRoot, WORKSPACE_STATE_DIRNAME);
  mkdirSync(stateDir, { recursive: true });
  const manifestPath = join(stateDir, WORKSPACE_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(validated, null, 2)}\n`, "utf-8");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isGitRepoDir(path: string): boolean {
  return isDirectory(path) && existsSync(join(path, ".git"));
}

function listImmediateChildDirs(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      names.push(entry.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Read the `origin` remote URL from a directory, or `undefined` if the
 * directory is not a git repo or has no `origin` remote configured. Never
 * throws; failures degrade to `undefined`.
 */
export function readGitRemoteUrl(repoDir: string, remote = "origin"): string | undefined {
  if (!isGitRepoDir(repoDir)) {
    return undefined;
  }

  try {
    const output = execFileSync("git", ["remote", "get-url", remote], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate immediate-child git repos suitable for a workspace.json
 * `sources` field. Returns the basenames (no nesting) of git repos that
 * are direct children of `workspaceRoot`, sorted, excluding the tree itself
 * and excluding any names in `excludeNames`.
 *
 * This is the source-of-truth filter for the §workspace.json `sources` field
 * contract — only immediate subdirectories may appear. Callers that derive
 * source lists from any other discovery surface (e.g. the legacy
 * `discoverWorkspaceRepos`, which recurses through non-git intermediate
 * dirs) MUST route through this helper to avoid writing nested basenames
 * that violate the schema and would render `computeWorkspaceStatus` unable
 * to locate them later.
 */
export function pickImmediateWorkspaceSources(
  workspaceRoot: string,
  treeName: string,
  excludeNames: ReadonlySet<string> = new Set(),
): string[] {
  const resolvedRoot = resolve(workspaceRoot);
  const names: string[] = [];

  for (const childName of listImmediateChildDirs(resolvedRoot)) {
    if (childName === treeName || excludeNames.has(childName)) {
      continue;
    }
    if (isGitRepoDir(join(resolvedRoot, childName))) {
      names.push(childName);
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Compute the read-only status report for a workspace. Used by
 * `first-tree tree status` to render the human-facing summary and by tests
 * to assert drift conditions.
 *
 * Performs no mutations and no network calls.
 */
export function computeWorkspaceStatus(workspaceRoot: string): WorkspaceStatus {
  const manifest = readWorkspaceManifest(workspaceRoot);
  const treePath = join(workspaceRoot, manifest.tree);
  const treePresent = isDirectory(treePath);
  const treeRemoteUrl = treePresent ? readGitRemoteUrl(treePath) : undefined;

  const boundSources: WorkspaceBoundSource[] = manifest.sources.map((name) => {
    const sourcePath = join(workspaceRoot, name);
    const present = isDirectory(sourcePath);
    const remoteUrl = present ? readGitRemoteUrl(sourcePath) : undefined;
    return {
      name,
      path: sourcePath,
      present,
      ...(remoteUrl ? { remoteUrl } : {}),
    };
  });

  const missingBoundSources = boundSources.filter((entry) => !entry.present);

  const declaredNames = new Set<string>([manifest.tree, ...manifest.sources]);
  const unboundGitSiblings: WorkspaceUnboundSibling[] = [];
  for (const childName of listImmediateChildDirs(workspaceRoot)) {
    if (declaredNames.has(childName)) {
      continue;
    }
    const childPath = join(workspaceRoot, childName);
    if (isGitRepoDir(childPath)) {
      const remoteUrl = readGitRemoteUrl(childPath);
      unboundGitSiblings.push({
        name: childName,
        path: childPath,
        ...(remoteUrl ? { remoteUrl } : {}),
      });
    }
  }

  return {
    workspaceRoot,
    manifest,
    treePath,
    treePresent,
    ...(treeRemoteUrl ? { treeRemoteUrl } : {}),
    boundSources,
    unboundGitSiblings,
    missingBoundSources,
  };
}
