import { isAbsolute, relative, resolve } from "node:path";
import { getRepoLocalPathSafetyError } from "@agent-team-foundation/first-tree-hub-shared";

export function resolveGitRepoTargetPath(workspace: string, localPath: string): string {
  const safetyError = getRepoLocalPathSafetyError(localPath);
  if (safetyError) {
    throw new Error(`Unsafe git repo localPath "${localPath}": ${safetyError}`);
  }

  const workspaceRoot = resolve(workspace);
  const targetPath = resolve(workspaceRoot, localPath);
  const relativeTarget = relative(workspaceRoot, targetPath);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Unsafe git repo localPath "${localPath}": resolved path escapes the session workspace`);
  }

  return targetPath;
}
