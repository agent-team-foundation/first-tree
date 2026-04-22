import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Repo } from "#products/tree/engine/repo.js";

export type WorkspaceRepoKind = "nested-git-repo";

export interface WorkspaceRepoCandidate {
  kind: WorkspaceRepoKind;
  name: string;
  relativePath: string;
  root: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "dist",
  "build",
  "node_modules",
  ".next",
  ".turbo",
]);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function discoverNestedRepos(
  root: string,
  current: string,
  results: Map<string, WorkspaceRepoCandidate>,
): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) {
      continue;
    }
    const child = join(current, entry);
    if (!isDirectory(child)) {
      continue;
    }

    const repo = new Repo(child);
    if (repo.isGitRepo() && repo.root !== root && repo.root === resolve(child)) {
      const relativePath = relative(root, repo.root);
      if (!results.has(relativePath)) {
        results.set(relativePath, {
          kind: "nested-git-repo",
          name: repo.repoName(),
          relativePath,
          root: repo.root,
        });
      }
      continue;
    }

    discoverNestedRepos(root, child, results);
  }
}

export function discoverWorkspaceRepos(root: string): WorkspaceRepoCandidate[] {
  const results = new Map<string, WorkspaceRepoCandidate>();

  if (existsSync(root)) {
    discoverNestedRepos(root, root, results);
  }

  return [...results.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}
