import type { Dirent } from "node:fs";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type ContextContentClass = "normal" | "archive-supporting" | "member" | "repo-infra";

export type ContextContentClassCounts = Record<ContextContentClass, number>;

export type ContextMarkdownFile = {
  absolutePath: string;
  contentClass: ContextContentClass;
  escaped: boolean;
  relativePath: string;
};

export type ContextDirectorySymlink = {
  contentClass: ContextContentClass;
  escaped: boolean;
  relativePath: string;
};

export type ContextMarkdownCollection = {
  directorySymlinks: ContextDirectorySymlink[];
  files: ContextMarkdownFile[];
};

const GENERATED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]);
const REPO_INFRA_MARKDOWN_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MANAGED_SYMLINK_FILES = new Set(["WHITEPAPER.md"]);

export function toTreeRelativePosixPath(treeRoot: string, targetPath: string): string {
  return relative(treeRoot, targetPath).replace(/\\/gu, "/");
}

export function classifyContextContent(relativePath: string): ContextContentClass {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);

  if (
    parts.length === 0 ||
    parts.some((part) => part.startsWith(".") || GENERATED_DIRECTORY_NAMES.has(part)) ||
    REPO_INFRA_MARKDOWN_FILES.has(parts.at(-1) ?? "")
  ) {
    return "repo-infra";
  }

  if (parts[0] === "raw-context") {
    return "archive-supporting";
  }

  if (parts[0] === "members") {
    return "member";
  }

  return "normal";
}

export function emptyContentClassCounts(): ContextContentClassCounts {
  return {
    normal: 0,
    "archive-supporting": 0,
    member: 0,
    "repo-infra": 0,
  };
}

function readDirectoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function pathIsInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function collectContextMarkdownContent(treeRoot: string): ContextMarkdownCollection {
  const directorySymlinks: ContextDirectorySymlink[] = [];
  const files: ContextMarkdownFile[] = [];

  function walk(directoryPath: string): void {
    for (const entry of readDirectoryEntries(directoryPath)) {
      const absolutePath = join(directoryPath, entry.name);
      const relativePath = toTreeRelativePosixPath(treeRoot, absolutePath);
      const contentClass = classifyContextContent(relativePath);

      if (entry.isDirectory()) {
        if (contentClass !== "repo-infra") {
          walk(absolutePath);
        }
        continue;
      }

      const symbolicLink = entry.isSymbolicLink();
      if (symbolicLink) {
        try {
          if (statSync(absolutePath).isDirectory()) {
            if (contentClass !== "repo-infra") {
              directorySymlinks.push({
                contentClass,
                escaped: !pathIsInside(realpathSync(treeRoot), realpathSync(absolutePath)),
                relativePath,
              });
            }
            continue;
          }
        } catch {
          continue;
        }
      }

      if ((!entry.isFile() && !symbolicLink) || !entry.name.endsWith(".md")) {
        continue;
      }

      if (symbolicLink && MANAGED_SYMLINK_FILES.has(entry.name)) {
        continue;
      }

      try {
        if (!statSync(absolutePath).isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      let escaped = false;
      if (symbolicLink) {
        try {
          escaped = !pathIsInside(realpathSync(treeRoot), realpathSync(absolutePath));
        } catch {
          continue;
        }
      }

      files.push({ absolutePath, contentClass, escaped, relativePath });
    }
  }

  walk(treeRoot);
  return { directorySymlinks, files };
}
