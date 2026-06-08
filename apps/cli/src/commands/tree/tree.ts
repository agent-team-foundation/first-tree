import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { Command } from "commander";
import matter from "gray-matter";

import { isJsonMode, print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { asString, findGitRoot, isRecord } from "./shared.js";

export type NodeMetadata = {
  title: string;
  description?: string;
  owners: string[];
};

export type ContextTreeNode = {
  kind: "directory" | "file";
  name: string;
  relativePath: string;
  depth: number;
  metadata: NodeMetadata;
  hasNode: boolean;
  children: ContextTreeNode[];
};

type RenderContextTreeOptions = {
  maxDepth?: number;
  pattern?: string;
  path?: string;
};

export type ReadContextTreeSnapshotOptions = {
  level?: number;
  pattern?: string;
  path?: string;
  target?: string;
};

export type ContextTreeSnapshot = {
  root: string;
  target: string;
  options: ReadContextTreeSnapshotOptions;
  tree: ContextTreeNode;
};

type ParsedTreeTreeOptions = {
  level?: number;
  pattern?: string;
  path: string;
};

type ResolvedTreeTarget = {
  repoRoot: string;
  targetRelativePath: string;
};

const NODE_FILE = "NODE.md";
const LEAF_FILE_EXCLUDES = new Set([NODE_FILE, "AGENTS.md", "CLAUDE.md"]);
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]);
const TREE_TREE_INVALID_LEVEL = "TREE_TREE_INVALID_LEVEL";
const TREE_TREE_INVALID_PATH = "TREE_TREE_INVALID_PATH";
const TREE_TREE_FAILED = "TREE_TREE_FAILED";

class TreeTreeCommandError extends Error {
  constructor(
    public readonly code: typeof TREE_TREE_INVALID_LEVEL | typeof TREE_TREE_INVALID_PATH | typeof TREE_TREE_FAILED,
    message: string,
  ) {
    super(message);
    this.name = "TreeTreeCommandError";
  }
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function toPosixRelativePath(root: string, target: string): string {
  return relative(root, target).replace(/\\/gu, "/");
}

function fileHasMarkdownExtension(name: string): boolean {
  return name.endsWith(".md");
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const items: string[] = [];

  for (const item of value) {
    const normalized = asNonEmptyString(item);

    if (normalized === undefined) {
      return undefined;
    }

    items.push(normalized);
  }

  return items;
}

function readFrontmatterMetadata(path: string): NodeMetadata | null {
  try {
    const parsed = matter(readFileSync(path, "utf-8"));
    const data: unknown = parsed.data;

    if (!isRecord(data)) {
      return null;
    }

    const title = asNonEmptyString(data.title);
    const owners = asNonEmptyStringArray(data.owners);

    if (title === undefined || owners === undefined) {
      return null;
    }

    return {
      title,
      description: asNonEmptyString(data.description),
      owners,
    };
  } catch {
    return null;
  }
}

function formatDisplayValue(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatDisplayPath(node: ContextTreeNode): string {
  if (node.relativePath.length === 0) {
    return `${node.name}/`;
  }

  return node.kind === "directory" ? `${node.relativePath}/` : node.relativePath;
}

function formatNodeLine(node: ContextTreeNode): string {
  const description =
    node.metadata.description === undefined ? "" : ` -> ${formatDisplayValue(node.metadata.description)}`;

  return `${formatDisplayPath(node)} [${formatDisplayValue(node.metadata.title)}]${description}`;
}

function compareEntryNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function shouldSkipDirectory(name: string): boolean {
  return isHidden(name) || SKIPPED_DIRECTORY_NAMES.has(name);
}

function shouldSkipFile(name: string): boolean {
  return isHidden(name) || !fileHasMarkdownExtension(name) || LEAF_FILE_EXCLUDES.has(name);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readDirectoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => compareEntryNames(left.name, right.name));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPathInsideOrEqual(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function splitRelativePath(path: string): string[] {
  if (path.length === 0) {
    return [];
  }

  return path.split("/").filter((segment) => segment.length > 0);
}

function formatTargetForMessage(path: string): string {
  return path.length === 0 ? "." : path;
}

function buildDirectoryNode(
  root: string,
  path: string,
  depth: number,
  name: string,
  targetSegments: string[],
): ContextTreeNode | null {
  const nodePath = join(path, NODE_FILE);
  const hasNode = isFile(nodePath);
  const metadata = readFrontmatterMetadata(nodePath);
  const relativePath = toPosixRelativePath(root, path);
  const children: ContextTreeNode[] = [];

  if (!hasNode || metadata === null) {
    return null;
  }

  if (targetSegments.length > 0) {
    const [nextSegment, ...remainingSegments] = targetSegments;

    if (!shouldSkipDirectory(nextSegment)) {
      const child = buildDirectoryNode(root, join(path, nextSegment), depth + 1, nextSegment, remainingSegments);

      if (child !== null) {
        children.push(child);
      }
    }
  } else {
    for (const entry of readDirectoryEntries(path)) {
      const entryName = entry.name;
      const childPath = join(path, entryName);

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entryName)) {
          continue;
        }

        const child = buildDirectoryNode(root, childPath, depth + 1, entryName, []);

        if (child !== null) {
          children.push(child);
        }

        continue;
      }

      if (!entry.isFile() || shouldSkipFile(entryName)) {
        continue;
      }

      const childMetadata = readFrontmatterMetadata(childPath);

      if (childMetadata === null) {
        continue;
      }

      children.push({
        kind: "file",
        name: entryName,
        relativePath: toPosixRelativePath(root, childPath),
        depth: depth + 1,
        metadata: childMetadata,
        hasNode: false,
        children: [],
      });
    }
  }

  return {
    kind: "directory",
    name,
    relativePath,
    depth,
    metadata,
    hasNode: true,
    children,
  };
}

function cloneWithTargetDepthLimit(
  node: ContextTreeNode,
  maxDepth: number | undefined,
  targetDepth: number,
): ContextTreeNode | null {
  if (maxDepth !== undefined && node.depth > targetDepth && node.depth > targetDepth + maxDepth) {
    return null;
  }

  return {
    ...node,
    children: node.children
      .map((child) => cloneWithTargetDepthLimit(child, maxDepth, targetDepth))
      .filter((child): child is ContextTreeNode => child !== null),
  };
}

function globToRegex(pattern: string): RegExp {
  let source = "^";

  for (const char of pattern) {
    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }

  source += "$";
  return new RegExp(source, "u");
}

function nodeMatchesPattern(node: ContextTreeNode, pattern: RegExp): boolean {
  const candidates = [node.relativePath, formatDisplayPath(node), node.name, node.metadata.title];

  if (node.metadata.description !== undefined) {
    candidates.push(node.metadata.description);
  }

  return candidates.some((candidate) => pattern.test(candidate));
}

function isAncestorOrSelfPath(candidate: string, target: string): boolean {
  if (candidate.length === 0) {
    return true;
  }

  return target === candidate || target.startsWith(`${candidate}/`);
}

function cloneWithPattern(
  node: ContextTreeNode,
  pattern: RegExp,
  targetRelativePath: string,
  forceKeep: boolean,
): ContextTreeNode | null {
  const children = node.children
    .map((child) => cloneWithPattern(child, pattern, targetRelativePath, false))
    .filter((child): child is ContextTreeNode => child !== null);
  const selfMatches = nodeMatchesPattern(node, pattern);
  const keepDirectoryAncestor = node.kind === "directory" && children.length > 0;
  const keepTargetContext = node.kind === "directory" && isAncestorOrSelfPath(node.relativePath, targetRelativePath);

  if (!forceKeep && !selfMatches && !keepDirectoryAncestor && !keepTargetContext) {
    return null;
  }

  return {
    ...node,
    children,
  };
}

function collectRenderedLines(node: ContextTreeNode, prefix: string, isLast: boolean, lines: string[]): void {
  if (node.depth === 0) {
    lines.push(formatNodeLine(node));
  } else {
    lines.push(`${prefix}${isLast ? "└── " : "├── "}${formatNodeLine(node)}`);
  }

  const childPrefix = node.depth === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`;

  node.children.forEach((child, index) => {
    collectRenderedLines(child, childPrefix, index === node.children.length - 1, lines);
  });
}

export function parseTreeLevel(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error("Invalid --level: expected a non-negative integer.");
  }

  const level = Number(value);

  if (!Number.isSafeInteger(level)) {
    throw new Error("Invalid --level: expected a non-negative integer.");
  }

  return level;
}

function looksLikeNumericLevelInput(value: string): boolean {
  return /^[-+]?\d/u.test(value);
}

function parseTreeTreeOptions(options: Record<string, unknown>, args: string[]): ParsedTreeTreeOptions {
  if (args.length > 1) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, "Invalid path: expected at most one directory path.");
  }

  const positionalPath = args[0];
  const rawLevel = options.level;
  let level: number | undefined;
  let path = positionalPath ?? ".";

  if (rawLevel !== undefined) {
    if (typeof rawLevel !== "string") {
      throw new TreeTreeCommandError(TREE_TREE_INVALID_LEVEL, "Invalid --level: expected a non-negative integer.");
    }

    try {
      level = parseTreeLevel(rawLevel);
    } catch (error) {
      if (positionalPath === undefined && !looksLikeNumericLevelInput(rawLevel)) {
        path = rawLevel;
      } else {
        throw error;
      }
    }
  }

  return {
    level,
    pattern: asString(options.pattern),
    path,
  };
}

function normalizeSnapshotOptions(options: ReadContextTreeSnapshotOptions): ReadContextTreeSnapshotOptions {
  const normalized: ReadContextTreeSnapshotOptions = {};

  if (options.level !== undefined) {
    normalized.level = options.level;
  }

  if (options.pattern !== undefined) {
    normalized.pattern = options.pattern;
  }

  if (options.path !== undefined) {
    normalized.path = options.path;
  }

  return normalized;
}

function resolveTreeTarget(cwd: string, path: string): ResolvedTreeTarget {
  const repoRoot = findGitRoot(cwd);

  if (repoRoot === undefined) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, "Path must be inside a git repository.");
  }

  const targetPath = resolve(cwd, path);

  if (!isDirectory(targetPath)) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, `Path "${path}" is not an existing directory.`);
  }

  if (!isPathInsideOrEqual(repoRoot, targetPath)) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, `Path "${path}" is outside the git repository.`);
  }

  return {
    repoRoot,
    targetRelativePath: toPosixRelativePath(repoRoot, targetPath),
  };
}

function resolveSnapshotTarget(root: string, target: string | undefined): ResolvedTreeTarget {
  const repoRoot = resolve(root);
  const targetPath = resolve(repoRoot, target ?? "");

  if (!isPathInsideOrEqual(repoRoot, targetPath)) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, `Path "${target ?? "."}" is outside the git repository.`);
  }

  if (!isDirectory(targetPath)) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, `Path "${target ?? "."}" is not an existing directory.`);
  }

  return {
    repoRoot,
    targetRelativePath: toPosixRelativePath(repoRoot, targetPath),
  };
}

function hasDirectoryNode(node: ContextTreeNode, relativePath: string): boolean {
  if (node.kind === "directory" && node.relativePath === relativePath) {
    return true;
  }

  return node.children.some((child) => hasDirectoryNode(child, relativePath));
}

export function readContextTreeSnapshot(
  root: string,
  options: ReadContextTreeSnapshotOptions = {},
): ContextTreeSnapshot {
  const resolvedTarget = resolveSnapshotTarget(root, options.target);
  const rootName = basename(resolvedTarget.repoRoot) || resolvedTarget.repoRoot;
  const targetSegments = splitRelativePath(resolvedTarget.targetRelativePath);
  const discovered = buildDirectoryNode(resolvedTarget.repoRoot, resolvedTarget.repoRoot, 0, rootName, targetSegments);

  if (discovered === null) {
    throw new Error(`No valid Context Tree root node found at ${NODE_FILE}.`);
  }

  if (!hasDirectoryNode(discovered, resolvedTarget.targetRelativePath)) {
    throw new Error(
      `Target path "${formatTargetForMessage(resolvedTarget.targetRelativePath)}" is not a valid Context Tree directory node.`,
    );
  }

  const depthLimited = cloneWithTargetDepthLimit(discovered, options.level, targetSegments.length);

  if (depthLimited === null) {
    throw new Error("Context Tree root was excluded by the depth limit.");
  }

  const patternFiltered =
    options.pattern === undefined
      ? depthLimited
      : cloneWithPattern(depthLimited, globToRegex(options.pattern), resolvedTarget.targetRelativePath, true);

  if (patternFiltered === null) {
    throw new Error("Context Tree root was removed by the pattern filter.");
  }

  return {
    root: resolvedTarget.repoRoot,
    target: resolvedTarget.targetRelativePath,
    options: normalizeSnapshotOptions(options),
    tree: patternFiltered,
  };
}

function renderContextTreeSnapshot(snapshot: ContextTreeSnapshot): string {
  const lines: string[] = [];
  collectRenderedLines(snapshot.tree, "", true, lines);
  return lines.join("\n");
}

export function renderContextTree(root: string, options: RenderContextTreeOptions = {}): string {
  return renderContextTreeSnapshot(
    readContextTreeSnapshot(root, {
      level: options.maxDepth,
      pattern: options.pattern,
      path: options.path,
      target: options.path,
    }),
  );
}

function configureTreeTreeCommand(command: Command): void {
  command
    .argument("[path]", "directory path to browse, resolved relative to the current working directory")
    .allowExcessArguments(false)
    .option("-L, --level <depth>", "max descendant depth below the target directory")
    .option(
      "-P, --pattern <pattern>",
      "shell-style glob filter matched against path, filename, title, and description",
    );
}

export function runTreeTreeCommand(context: CommandContext): void {
  try {
    const options = context.command.opts<Record<string, unknown>>();
    const parsedOptions = parseTreeTreeOptions(options, context.command.args);
    const resolvedTarget = resolveTreeTarget(process.cwd(), parsedOptions.path);
    const snapshot = readContextTreeSnapshot(resolvedTarget.repoRoot, {
      level: parsedOptions.level,
      pattern: parsedOptions.pattern,
      path: parsedOptions.path,
      target: resolvedTarget.targetRelativePath,
    });

    if (context.options.json || isJsonMode()) {
      print.result(snapshot);
      return;
    }

    print.line(`${renderContextTreeSnapshot(snapshot)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof TreeTreeCommandError
        ? error.code
        : message.startsWith("Invalid --level")
          ? TREE_TREE_INVALID_LEVEL
          : TREE_TREE_FAILED;
    print.fail(code, message);
  }
}

export const treeTreeCommand: SubcommandModule = {
  name: "tree",
  alias: "",
  summary: "",
  description: "Browse Context Tree nodes as a hierarchy.",
  configure: configureTreeTreeCommand,
  action: runTreeTreeCommand,
};
