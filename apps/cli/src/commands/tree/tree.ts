import type { Dirent } from "node:fs";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { Command } from "commander";
import {
  type ContextTreeReadSnapshotIdentity,
  InvalidContextTreeReadSnapshotError,
  readContextTreeReadSnapshotIdentity,
} from "../../core/context-tree-read.js";
import { isJsonMode, print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { classifyContextContent } from "./content-class.js";
import type { NodeMetadata } from "./context-document.js";
import { readNodeMetadata } from "./context-document.js";
import { asString, findGitRoot, runCommand } from "./shared.js";

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

type ContextTreeBranchInfo = {
  name: string;
  isMainline: boolean;
  warning: string | null;
};

type ContextTreeCommandData = ContextTreeSnapshot & {
  branch: ContextTreeBranchInfo;
  readSnapshot: ContextTreeReadSnapshotIdentity | null;
};

type ParsedTreeTreeOptions = {
  level?: number;
  pattern?: string;
  path: string;
  /**
   * When true (the default), refresh the resolved Context Tree repo with
   * `git pull --ff-only` before reading it, so the listing always reflects
   * upstream. `--no-pull` turns this off for offline use or when the caller
   * wants a stable snapshot within a task.
   */
  pull: boolean;
};

type ResolvedTreeTarget = {
  repoRoot: string;
  targetRelativePath: string;
};

const NODE_FILE = "NODE.md";
const LEAF_FILE_EXCLUDES = new Set([NODE_FILE]);
const TREE_TREE_INVALID_LEVEL = "TREE_TREE_INVALID_LEVEL";
const TREE_TREE_INVALID_PATH = "TREE_TREE_INVALID_PATH";
const TREE_TREE_FAILED = "TREE_TREE_FAILED";
const MAINLINE_BRANCHES = new Set(["main", "master", "origin/main"]);

class TreeTreeCommandError extends Error {
  constructor(
    public readonly code: typeof TREE_TREE_INVALID_LEVEL | typeof TREE_TREE_INVALID_PATH | typeof TREE_TREE_FAILED,
    message: string,
  ) {
    super(message);
    this.name = "TreeTreeCommandError";
  }
}

function toPosixRelativePath(root: string, target: string): string {
  return relative(root, target).replace(/\\/gu, "/");
}

function fileHasMarkdownExtension(name: string): boolean {
  return name.endsWith(".md");
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

function shouldSkipDirectory(relativePath: string): boolean {
  return classifyContextContent(relativePath) === "repo-infra";
}

function shouldSkipFile(name: string, relativePath: string): boolean {
  return (
    classifyContextContent(relativePath) === "repo-infra" ||
    !fileHasMarkdownExtension(name) ||
    LEAF_FILE_EXCLUDES.has(name)
  );
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

function isRealPathInsideOrEqual(root: string, target: string): boolean {
  return isPathInsideOrEqual(realpathSync(root), realpathSync(target));
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
  const metadata = readNodeMetadata(nodePath);
  const relativePath = toPosixRelativePath(root, path);
  const children: ContextTreeNode[] = [];

  if (!hasNode || metadata === null) {
    return null;
  }

  if (targetSegments.length > 0) {
    const [nextSegment, ...remainingSegments] = targetSegments;
    const nextRelativePath = relativePath.length === 0 ? nextSegment : `${relativePath}/${nextSegment}`;

    if (!shouldSkipDirectory(nextRelativePath)) {
      const child = buildDirectoryNode(root, join(path, nextSegment), depth + 1, nextSegment, remainingSegments);

      if (child !== null) {
        children.push(child);
      }
    }
  } else {
    for (const entry of readDirectoryEntries(path)) {
      const entryName = entry.name;
      const childPath = join(path, entryName);
      const childRelativePath = toPosixRelativePath(root, childPath);

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(childRelativePath)) {
          continue;
        }

        const child = buildDirectoryNode(root, childPath, depth + 1, entryName, []);

        if (child !== null) {
          children.push(child);
        }

        continue;
      }

      if (!entry.isFile() || shouldSkipFile(entryName, childRelativePath)) {
        continue;
      }

      const childMetadata = readNodeMetadata(childPath);

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
    // Commander maps `--no-pull` to `options.pull === false`; the flag is
    // absent (undefined) by default, which we treat as pull-enabled.
    pull: options.pull !== false,
  };
}

/**
 * Refresh the resolved Context Tree repo before reading it, so the listing
 * (and the file reads the agent does right after) reflect upstream — moving
 * tree freshness from a soft "remember to pull first" convention into a hard
 * tool guarantee.
 *
 * Best-effort by design: a `git pull --ff-only` failure (offline, missing
 * credentials, a dirty/diverged working tree) is reported to stderr and the
 * command continues against the local copy. A tree read must never be blocked
 * by an unreachable remote — a slightly stale tree beats no tree. `runCommand`
 * already runs git with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails
 * fast instead of hanging.
 */
function pullContextTreeRepo(root: string): void {
  try {
    runCommand("git", ["pull", "--ff-only"], root);
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const detail = (stderr || (error instanceof Error ? error.message : String(error))).split("\n")[0];
    print.status("⚠️", `tree pull --ff-only skipped — reading local copy (${detail})`);
  }
}

function branchWarning(name: string): string {
  return `Warning: current branch "${name}" is not main/master; it may be stale. Switch to main/master.`;
}

function readCurrentBranchName(root: string): string {
  try {
    const branch = runCommand("git", ["branch", "--show-current"], root);

    if (branch.length > 0) {
      return branch;
    }
  } catch {
    return "unknown";
  }

  try {
    const head = runCommand("git", ["rev-parse", "--verify", "HEAD"], root);
    const originMain = runCommand("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], root);

    if (head.length > 0 && head === originMain) {
      return "origin/main";
    }
  } catch {
    // Detached checkouts without an origin/main ref still fall through to the
    // stable detached:<shortSha> label below.
  }

  try {
    const shortSha = runCommand("git", ["rev-parse", "--short", "HEAD"], root);

    if (shortSha.length > 0) {
      return `detached:${shortSha}`;
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function readContextTreeBranch(
  root: string,
  readSnapshot: ContextTreeReadSnapshotIdentity | null,
): ContextTreeBranchInfo {
  if (readSnapshot !== null) {
    return {
      name: `snapshot:${readSnapshot.commit.slice(0, 12)}`,
      isMainline: false,
      warning: null,
    };
  }

  const name = readCurrentBranchName(root);
  const isMainline = MAINLINE_BRANCHES.has(name);

  return {
    name,
    isMainline,
    warning: isMainline ? null : branchWarning(name),
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

  if (!isRealPathInsideOrEqual(repoRoot, targetPath)) {
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

  if (!isDirectory(targetPath)) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, `Path "${target ?? "."}" is not an existing directory.`);
  }

  if (!isRealPathInsideOrEqual(repoRoot, targetPath)) {
    throw new TreeTreeCommandError(TREE_TREE_INVALID_PATH, `Path "${target ?? "."}" is outside the git repository.`);
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

function renderContextTreeCommandData(data: ContextTreeCommandData): string {
  const lines = [`Branch: ${data.branch.name}`];

  if (data.branch.warning !== null) {
    lines.push(data.branch.warning);
  }

  if (data.readSnapshot !== null) {
    lines.push(`Team: ${data.readSnapshot.teamId}`);
    lines.push(`Binding: ${data.readSnapshot.binding.repo}#${data.readSnapshot.binding.branch}`);
    lines.push(`Exact commit: ${data.readSnapshot.commit}`);
  }

  lines.push(renderContextTreeSnapshot(data));
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
    .option("-P, --pattern <pattern>", "shell-style glob filter matched against path, filename, title, and description")
    .option(
      "--no-pull",
      "skip the automatic `git pull --ff-only` refresh and read the local checkout as-is (offline / stable-snapshot use)",
    );
}

export function runTreeTreeCommand(context: CommandContext): void {
  try {
    const options = context.command.opts<Record<string, unknown>>();
    const parsedOptions = parseTreeTreeOptions(options, context.command.args);
    const resolvedTarget = resolveTreeTarget(process.cwd(), parsedOptions.path);
    const readSnapshot = readContextTreeReadSnapshotIdentity(resolvedTarget.repoRoot);
    // Refresh the tree before reading it (hard freshness guarantee), unless
    // the caller opted out with --no-pull. An activated BYO task snapshot is
    // already pinned to an exact commit and must never refresh per selector.
    // Managed checkouts retain their existing best-effort stale fallback.
    if (parsedOptions.pull && readSnapshot === null) {
      pullContextTreeRepo(resolvedTarget.repoRoot);
    }
    const snapshot = readContextTreeSnapshot(resolvedTarget.repoRoot, {
      level: parsedOptions.level,
      pattern: parsedOptions.pattern,
      path: parsedOptions.path,
      target: resolvedTarget.targetRelativePath,
    });
    const data: ContextTreeCommandData = {
      ...snapshot,
      branch: readContextTreeBranch(resolvedTarget.repoRoot, readSnapshot),
      readSnapshot,
    };

    if (context.options.json || isJsonMode()) {
      print.result(data);
      return;
    }

    print.line(`${renderContextTreeCommandData(data)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof TreeTreeCommandError
        ? error.code
        : error instanceof InvalidContextTreeReadSnapshotError
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
