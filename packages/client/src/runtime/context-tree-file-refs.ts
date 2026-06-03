import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { classifyShellCommandIo, type ShellIoPathKindHint, type ToolFileRef } from "@first-tree/shared";

export type ShellCommandFileRefsInput = {
  command: string;
  cwd: string;
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
  contextTreeBranch?: string | null;
};

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathInsideContextTree(absolutePath: string, contextTreePath: string): string | null {
  const relativePath = relative(contextTreePath, absolutePath);
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
  const contextTreeRoot = resolve(input.contextTreePath);
  for (const pathArg of classification.pathArgs) {
    const absolutePath = isAbsolute(pathArg.raw) ? resolve(pathArg.raw) : resolve(input.cwd, pathArg.raw);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    const repoRelativePath = pathInsideContextTree(absolutePath, contextTreeRoot);
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
