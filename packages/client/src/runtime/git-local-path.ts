import { isAbsolute, relative, resolve, sep } from "node:path";
import { getRepoLocalPathSafetyError } from "@first-tree/shared";

export function resolveGitRepoTargetPath(workspace: string, localPath: string): string {
  const safetyError = getRepoLocalPathSafetyError(localPath);
  if (safetyError) {
    throw new Error(`Unsafe git repo localPath "${localPath}": ${safetyError}`);
  }

  const workspaceRoot = resolve(workspace);
  const targetPath = resolve(workspaceRoot, localPath);
  const relativeTarget = relative(workspaceRoot, targetPath);
  const escapesWorkspace = relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`);
  if (!relativeTarget || escapesWorkspace || isAbsolute(relativeTarget)) {
    throw new Error(`Unsafe git repo localPath "${localPath}": resolved path escapes the session workspace`);
  }

  return targetPath;
}
