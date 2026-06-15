import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { classifyShellCommandIo, type ShellIoPathKindHint, type ToolFileRef } from "@first-tree/shared";
import { gitRepoRootMatchingRemote } from "./git-repo-identity.js";

export type ShellCommandFileRefsInput = {
  command: string;
  cwd: string;
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
  contextTreeBranch?: string | null;
};

/** The slice of the Context Tree binding that attribution decisions need. */
export type ContextTreeAttribution = {
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
};

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Resolve `path` to its canonical filesystem form (symlinks resolved),
 * falling back lexically for segments that do not exist (yet).
 *
 * Cloud agent homes expose the shared Context Tree clone through a
 * `<workspace>/context-tree` symlink (see `runtime/workspace-manifest.ts`),
 * while the runtime config carries the external clone's real path. A pure
 * string prefix match between the two spellings never agrees, so every ref
 * that travels through the symlinked path silently loses its repo evidence.
 * Canonicalizing both sides of the containment check makes the spellings
 * equivalent.
 *
 * A not-yet-existing path (e.g. a Write creating a new file) canonicalizes
 * its deepest existing ancestor and re-appends the remaining segments, so
 * brand-new files under a symlinked root still map correctly.
 */
export function canonicalizeFsPath(path: string): string {
  let current = resolve(path);
  const pendingSegments: string[] = [];
  for (;;) {
    try {
      return pendingSegments.length === 0 ? realpathSync(current) : join(realpathSync(current), ...pendingSegments);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      pendingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Tree-root-relative posix path of `absolutePath` when it lives under
 * `contextTreeRoot`, `"/"` when it IS the root, null otherwise. Both sides
 * are compared in canonical form, so symlink aliases of the same tree agree.
 */
export function contextTreeRelativePathOf(absolutePath: string, contextTreeRoot: string): string | null {
  const relativePath = relative(canonicalizeFsPath(contextTreeRoot), canonicalizeFsPath(absolutePath));
  if (relativePath === "") return "/";
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return toPosixPath(relativePath);
}

/**
 * Tree-root-relative posix path of `absolutePath` when it belongs to the
 * bound Context Tree repo, null otherwise. Two recognition layers:
 *
 * 1. Containment (fast, pure fs): the path lives under the bound shared
 *    clone (`contextTreePath`), via canonical comparison so the workspace
 *    `context-tree` symlink matches.
 * 2. Repo identity: the path lives in ANY OTHER checkout of the same repo —
 *    above all the per-task tree PR worktree where tree writes are actually
 *    authored. The nearest enclosing git root's `origin` remote is compared,
 *    canonically, against the binding's repo URL; the relative path is then
 *    computed against THAT root.
 *
 * Layer 2 is what makes the feed recognize the real tree-write workflow:
 * agents read the shared clone but author tree PRs in `worktrees/<task>`,
 * a sibling checkout the containment check can never see.
 */
export function resolveContextTreeRelativePath(
  absolutePath: string,
  attribution: ContextTreeAttribution,
): string | null {
  if (attribution.contextTreePath) {
    const contained = contextTreeRelativePathOf(absolutePath, attribution.contextTreePath);
    if (contained !== null) return contained;
  }
  if (!attribution.contextTreeRepoUrl) return null;

  const canonicalPath = canonicalizeFsPath(absolutePath);
  const root = gitRepoRootMatchingRemote(canonicalPath, attribution.contextTreeRepoUrl);
  if (!root) return null;
  const relativePath = relative(root, canonicalPath);
  if (relativePath === "") return "/";
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return toPosixPath(relativePath);
}

function pathKindOf(
  absolutePath: string,
  repoRelativePath: string,
  hint: ShellIoPathKindHint,
): NonNullable<ToolFileRef["pathKind"]> {
  if (repoRelativePath === "/") return "repo";
  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) return "directory";
    return "file";
  } catch {
    return hint === "directory" ? "directory" : "file";
  }
}

export function toolFileRefsFromShellCommand(input: ShellCommandFileRefsInput): ToolFileRef[] {
  if (!input.contextTreePath || !input.contextTreeRepoUrl) return [];

  const classification = classifyShellCommandIo(input.command);
  if (!classification.supported || classification.action !== "read") return [];

  const refs: ToolFileRef[] = [];
  const seen = new Set<string>();
  for (const pathArg of classification.pathArgs) {
    const absolutePath = isAbsolute(pathArg.raw) ? resolve(pathArg.raw) : resolve(input.cwd, pathArg.raw);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, {
      contextTreePath: input.contextTreePath,
      contextTreeRepoUrl: input.contextTreeRepoUrl,
    });
    if (repoRelativePath === null) continue;

    refs.push({
      origin: "tool_arg",
      localPath: absolutePath,
      repoUrl: input.contextTreeRepoUrl,
      ...(input.contextTreeBranch ? { repoBranch: input.contextTreeBranch } : {}),
      repoRelativePath,
      pathKind: pathKindOf(absolutePath, repoRelativePath, pathArg.pathKindHint),
    });
  }
  return refs;
}
