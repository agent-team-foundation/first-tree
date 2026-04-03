import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  frameworkVersionCandidates,
  resolveFirstExistingPath,
} from "#skill/engine/runtime/asset-loader.js";

export const FIRST_TREE_REPO_URL =
  "https://github.com/agent-team-foundation/first-tree";

export function cloneUpstreamRepo(
  repoUrl = FIRST_TREE_REPO_URL,
): string {
  const tmp = mkdtempSync(join(tmpdir(), "context-tree-upstream-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", repoUrl, tmp], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return tmp;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : "unknown error";
    throw new Error(`Failed to clone ${repoUrl}: ${message}`);
  }
}

export function cleanupUpstreamRepo(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function readUpstreamVersion(sourceRoot: string): string | null {
  const versionPath = resolveFirstExistingPath(
    sourceRoot,
    frameworkVersionCandidates(),
  );
  if (versionPath === null) return null;
  try {
    return readFileSync(join(sourceRoot, versionPath), "utf-8").trim();
  } catch {
    return null;
  }
}
