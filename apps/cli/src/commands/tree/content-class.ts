import type { Dirent } from "node:fs";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type ContextContentClass = "normal" | "archive-supporting" | "member" | "repo-infra";

export type ContextContentClassCounts = Record<ContextContentClass, number>;

export type ContextMarkdownFile = {
  absolutePath: string;
  canonicalContentClass: ContextContentClass;
  canonicalRelativePath: string;
  contentClass: ContextContentClass;
  escaped: boolean;
  relativePath: string;
  unsupported: boolean;
  unresolved: boolean;
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

export type RepoInfraMarkdownInspection = { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; source: string };

const GENERATED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]);
const REPO_INFRA_MARKDOWN_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MANAGED_SYMLINK_PATHS = new Set(["WHITEPAPER.md"]);

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

export function inspectRepoInfraMarkdownFile(treeRoot: string, relativePath: string): RepoInfraMarkdownInspection {
  const absolutePath = join(treeRoot, relativePath);
  let entry: ReturnType<typeof lstatSync>;

  try {
    entry = lstatSync(absolutePath);
  } catch {
    return { kind: "absent" };
  }

  if (entry.isSymbolicLink()) {
    try {
      if (!statSync(absolutePath).isFile()) {
        return { kind: "invalid" };
      }
      const realTreeRoot = realpathSync(treeRoot);
      const realTarget = realpathSync(absolutePath);
      if (!pathIsInside(realTreeRoot, realTarget)) {
        return { kind: "invalid" };
      }
      const canonicalRelativePath = toTreeRelativePosixPath(realTreeRoot, realTarget);
      if (classifyContextContent(canonicalRelativePath) !== "repo-infra") {
        return { kind: "invalid" };
      }
    } catch {
      return { kind: "invalid" };
    }
  } else if (!entry.isFile()) {
    return { kind: "invalid" };
  }

  try {
    return { kind: "valid", source: readFileSync(absolutePath, "utf-8") };
  } catch {
    return { kind: "invalid" };
  }
}

export function collectContextMarkdownContent(treeRoot: string): ContextMarkdownCollection {
  const directorySymlinks: ContextDirectorySymlink[] = [];
  const files: ContextMarkdownFile[] = [];
  const realTreeRoot = realpathSync(treeRoot);

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
          const targetStat = statSync(absolutePath);
          if (targetStat.isDirectory()) {
            if (contentClass !== "repo-infra" || entry.name.endsWith(".md")) {
              directorySymlinks.push({
                contentClass,
                escaped: !pathIsInside(realTreeRoot, realpathSync(absolutePath)),
                relativePath,
              });
            }
            continue;
          }

          if (!targetStat.isFile() && entry.name.endsWith(".md")) {
            let escaped = false;
            let canonicalContentClass = contentClass;
            let canonicalRelativePath = relativePath;
            try {
              const realTarget = realpathSync(absolutePath);
              escaped = !pathIsInside(realTreeRoot, realTarget);
              canonicalRelativePath = toTreeRelativePosixPath(realTreeRoot, realTarget);
              if (!escaped) {
                canonicalContentClass = classifyContextContent(canonicalRelativePath);
              }
            } catch {
              files.push({
                absolutePath,
                canonicalContentClass,
                canonicalRelativePath,
                contentClass,
                escaped: false,
                relativePath,
                unsupported: false,
                unresolved: true,
              });
              continue;
            }

            files.push({
              absolutePath,
              canonicalContentClass,
              canonicalRelativePath,
              contentClass,
              escaped,
              relativePath,
              unsupported: true,
              unresolved: false,
            });
            continue;
          }
        } catch {
          if (MANAGED_SYMLINK_PATHS.has(relativePath)) {
            continue;
          }
          if (entry.name.endsWith(".md")) {
            files.push({
              absolutePath,
              canonicalContentClass: contentClass,
              canonicalRelativePath: relativePath,
              contentClass,
              escaped: false,
              relativePath,
              unsupported: false,
              unresolved: true,
            });
          }
          continue;
        }
      }

      if ((!entry.isFile() && !symbolicLink) || !entry.name.endsWith(".md")) {
        continue;
      }

      if (symbolicLink && MANAGED_SYMLINK_PATHS.has(relativePath)) {
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
      let canonicalContentClass = contentClass;
      let canonicalRelativePath = relativePath;
      if (symbolicLink) {
        try {
          const realTarget = realpathSync(absolutePath);
          escaped = !pathIsInside(realTreeRoot, realTarget);
          canonicalRelativePath = toTreeRelativePosixPath(realTreeRoot, realTarget);
          if (!escaped) {
            canonicalContentClass = classifyContextContent(canonicalRelativePath);
          }
        } catch {
          continue;
        }
      }

      files.push({
        absolutePath,
        canonicalContentClass,
        canonicalRelativePath,
        contentClass,
        escaped,
        relativePath,
        unsupported: false,
        unresolved: false,
      });
    }
  }

  walk(treeRoot);
  return { directorySymlinks, files };
}
