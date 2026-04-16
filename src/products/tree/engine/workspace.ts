import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Repo } from "#products/tree/engine/repo.js";
import { TREE_SUBMODULES_DIR } from "#products/tree/engine/runtime/asset-loader.js";

export type WorkspaceRepoKind = "git-submodule" | "nested-git-repo";

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

function parseGitmodules(root: string): string[] {
  try {
    const text = readFileSync(join(root, ".gitmodules"), "utf-8");
    return [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
      .map((match) => match[1]?.trim())
      .filter(
        (value): value is string =>
          Boolean(value) && !value.startsWith(`${TREE_SUBMODULES_DIR}/`),
      );
  } catch {
    return [];
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

  for (const submodulePath of parseGitmodules(root)) {
    const submoduleRoot = resolve(root, submodulePath);
    const repo = new Repo(submoduleRoot);
    if (!repo.isGitRepo()) {
      continue;
    }
    results.set(submodulePath, {
      kind: "git-submodule",
      name: repo.repoName(),
      relativePath: submodulePath,
      root: submoduleRoot,
    });
  }

  if (existsSync(root)) {
    discoverNestedRepos(root, root, results);
  }

  return [...results.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}
