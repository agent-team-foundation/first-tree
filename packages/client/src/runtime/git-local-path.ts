import { isAbsolute, relative, resolve, sep } from "node:path";
import { getRepoLocalPathSafetyError, normalizeRepoLocalPath, SOURCE_REPOS_DIRNAME } from "@first-tree/shared";

export function resolveGitRepoTargetPath(workspace: string, localPath: string): string {
  // Match the schema's read-tolerant normalization: a legacy clean nested
  // path collapses to its basename so the runtime resolves the same
  // single-segment target the manifest / briefing use; anything hard-unsafe
  // passes through unchanged and is rejected by the safety check below.
  const normalized = normalizeRepoLocalPath(localPath);
  const safetyError = getRepoLocalPathSafetyError(normalized);
  if (safetyError) {
    throw new Error(`Unsafe git repo localPath "${localPath}": ${safetyError}`);
  }

  // Source clones live one level down, under `<workspace>/source-repos/<name>`
  // (the manifest's `sourcesRoot`), keeping them grouped apart from the tree
  // clone, `worktrees/`, and workspace state dirs. The escape guard is anchored
  // at the `source-repos/` directory itself (not the workspace root), so a
  // `..`-bearing localPath that would climb out of `source-repos/` — even into
  // a workspace-root sibling like `context-tree/` — is rejected, keeping the
  // guard locally self-consistent rather than relying on the upstream safety
  // check (`getRepoLocalPathSafetyError`, which already rejects `/`/`..`) never
  // loosening.
  const workspaceRoot = resolve(workspace);
  const sourceReposRoot = resolve(workspaceRoot, SOURCE_REPOS_DIRNAME);
  const targetPath = resolve(sourceReposRoot, normalized);
  const relativeTarget = relative(sourceReposRoot, targetPath);
  const escapesSourceRepos = relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`);
  if (!relativeTarget || escapesSourceRepos || isAbsolute(relativeTarget)) {
    throw new Error(`Unsafe git repo localPath "${localPath}": resolved path escapes the source-repos directory`);
  }

  return targetPath;
}
