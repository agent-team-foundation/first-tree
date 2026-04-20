import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
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
  "target",
  "vendor",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  "out",
  ".cache",
  ".pytest_cache",
]);

const TREE_SUBMODULES_PREFIX = `${TREE_SUBMODULES_DIR.split(/[\\/]/).join("/")}/`;

function parseGitmodules(root: string): string[] {
  try {
    const text = readFileSync(join(root, ".gitmodules"), "utf-8");
    return [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
      .map((match) => match[1]?.trim())
      .filter(
        (value): value is string =>
          Boolean(value) && !value.startsWith(TREE_SUBMODULES_PREFIX),
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
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    // Skip symlinks to avoid recursion cycles (repo pointing into itself,
    // shared toolchain dirs, etc.).
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue;
    }
    const child = join(current, entry.name);

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
      console.warn(
        `warning: submodule "${submodulePath}" is declared in .gitmodules but is not initialized; skipping. Run \`git submodule update --init\` to include it.`,
      );
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
    left.relativePath.localeCompare(right.relativePath, "en")
  );
}
