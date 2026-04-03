import { execFileSync } from "node:child_process";
import { frameworkVersionCandidates } from "#src/runtime/asset-loader.js";

export function fetchUpstream(
  repoRoot: string,
  remote = "context-tree-upstream",
): boolean {
  try {
    execFileSync("git", ["fetch", remote, "--depth", "1"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function readUpstreamVersion(
  repoRoot: string,
  remote = "context-tree-upstream",
  ref = "main",
): string | null {
  for (const candidate of frameworkVersionCandidates()) {
    try {
      const result = execFileSync("git", ["show", `${remote}/${ref}:${candidate}`], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return result.trim();
    } catch {
      continue;
    }
  }
  return null;
}
