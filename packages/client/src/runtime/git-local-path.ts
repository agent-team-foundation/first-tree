import { isAbsolute, relative, resolve, sep } from "node:path";
import { getRepoLocalPathSafetyError, normalizeRepoLocalPath } from "@first-tree/shared";

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

  const workspaceRoot = resolve(workspace);
  const targetPath = resolve(workspaceRoot, normalized);
  const relativeTarget = relative(workspaceRoot, targetPath);
  const escapesWorkspace = relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`);
  if (!relativeTarget || escapesWorkspace || isAbsolute(relativeTarget)) {
    throw new Error(`Unsafe git repo localPath "${localPath}": resolved path escapes the session workspace`);
  }

  return targetPath;
}
