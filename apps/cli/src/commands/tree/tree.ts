import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import type { Command } from "commander";
import matter from "gray-matter";

import { isJsonMode, print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { asString, isRecord } from "./shared.js";

export type NodeMetadata = {
  title: string;
  description: string;
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
};

export type ReadContextTreeSnapshotOptions = {
  level?: number;
  pattern?: string;
};

export type ContextTreeSnapshot = {
  root: string;
  options: ReadContextTreeSnapshotOptions;
  tree: ContextTreeNode;
};

const NODE_FILE = "NODE.md";
const LEAF_FILE_EXCLUDES = new Set([NODE_FILE, "AGENTS.md", "CLAUDE.md"]);
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]);
const MISSING_METADATA = "-";
const TREE_TREE_INVALID_LEVEL = "TREE_TREE_INVALID_LEVEL";
const TREE_TREE_FAILED = "TREE_TREE_FAILED";

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function toPosixRelativePath(root: string, target: string): string {
  return relative(root, target).replace(/\\/gu, "/");
}

function fileHasMarkdownExtension(name: string): boolean {
  return name.endsWith(".md");
}

function readFrontmatterMetadata(path: string): NodeMetadata {
  try {
    const parsed = matter(readFileSync(path, "utf-8"));
    const data: unknown = parsed.data;

    if (!isRecord(data)) {
      return { title: MISSING_METADATA, description: MISSING_METADATA };
    }

    return {
      title: asString(data.title) ?? MISSING_METADATA,
      description: asString(data.description) ?? MISSING_METADATA,
    };
  } catch {
    return { title: MISSING_METADATA, description: MISSING_METADATA };
  }
}

function escapeDisplayValue(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .replace(/\t/gu, "\\t");
}

function formatMetadata(metadata: NodeMetadata): string {
  return `title="${escapeDisplayValue(metadata.title)}" description="${escapeDisplayValue(metadata.description)}"`;
}

function formatNodeLine(node: ContextTreeNode): string {
  if (node.kind === "file") {
    return `${node.name} ${formatMetadata(node.metadata)}`;
  }

  const nodeMarker = node.hasNode ? " [NODE.md]" : "";
  return `${node.name}/${nodeMarker} ${formatMetadata(node.metadata)}`;
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

function buildDirectoryNode(root: string, path: string, depth: number, name: string): ContextTreeNode {
  const nodePath = join(path, NODE_FILE);
  const hasNode = isFile(nodePath);
  const metadata = readFrontmatterMetadata(nodePath);
  const relativePath = toPosixRelativePath(root, path);
  const children: ContextTreeNode[] = [];

  for (const entry of readDirectoryEntries(path)) {
    const entryName = entry.name;
    const childPath = join(path, entryName);

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entryName)) {
        continue;
      }

      children.push(buildDirectoryNode(root, childPath, depth + 1, entryName));
      continue;
    }

    if (!entry.isFile() || shouldSkipFile(entryName)) {
      continue;
    }

    children.push({
      kind: "file",
      name: entryName,
      relativePath: toPosixRelativePath(root, childPath),
      depth: depth + 1,
      metadata: readFrontmatterMetadata(childPath),
      hasNode: false,
      children: [],
    });
  }

  return {
    kind: "directory",
    name,
    relativePath,
    depth,
    metadata,
    hasNode,
    children,
  };
}

function cloneWithDepthLimit(node: ContextTreeNode, maxDepth: number | undefined): ContextTreeNode | null {
  if (maxDepth !== undefined && node.depth > maxDepth) {
    return null;
  }

  return {
    ...node,
    children: node.children
      .map((child) => cloneWithDepthLimit(child, maxDepth))
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
  return [node.relativePath, node.name, node.metadata.title, node.metadata.description].some((candidate) =>
    pattern.test(candidate),
  );
}

function cloneWithPattern(node: ContextTreeNode, pattern: RegExp, forceKeep: boolean): ContextTreeNode | null {
  const children = node.children
    .map((child) => cloneWithPattern(child, pattern, false))
    .filter((child): child is ContextTreeNode => child !== null);
  const selfMatches = nodeMatchesPattern(node, pattern);
  const keepDirectoryAncestor = node.kind === "directory" && children.length > 0;

  if (!forceKeep && !selfMatches && !keepDirectoryAncestor) {
    return null;
  }

  return {
    ...node,
    children,
  };
}

function pruneRenderableDirectories(node: ContextTreeNode, forceKeep: boolean): ContextTreeNode | null {
  const children = node.children
    .map((child) => pruneRenderableDirectories(child, false))
    .filter((child): child is ContextTreeNode => child !== null);
  const isRenderableDirectory = node.kind === "directory" && (node.hasNode || children.length > 0 || forceKeep);

  if (node.kind === "file" || isRenderableDirectory) {
    return { ...node, children };
  }

  return null;
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

function normalizeSnapshotOptions(options: ReadContextTreeSnapshotOptions): ReadContextTreeSnapshotOptions {
  const normalized: ReadContextTreeSnapshotOptions = {};

  if (options.level !== undefined) {
    normalized.level = options.level;
  }

  if (options.pattern !== undefined) {
    normalized.pattern = options.pattern;
  }

  return normalized;
}

export function readContextTreeSnapshot(
  root: string,
  options: ReadContextTreeSnapshotOptions = {},
): ContextTreeSnapshot {
  const resolvedRoot = resolve(root);
  const rootName = basename(resolvedRoot) || resolvedRoot;
  const discovered = buildDirectoryNode(resolvedRoot, resolvedRoot, 0, rootName);
  const depthLimited = cloneWithDepthLimit(discovered, options.level);

  if (depthLimited === null) {
    throw new Error("Context Tree root was excluded by the depth limit.");
  }

  const patternFiltered =
    options.pattern === undefined ? depthLimited : cloneWithPattern(depthLimited, globToRegex(options.pattern), true);
  const renderable = patternFiltered === null ? null : pruneRenderableDirectories(patternFiltered, true);

  if (renderable === null) {
    throw new Error("Context Tree root was removed by the renderable node filter.");
  }

  return {
    root: resolvedRoot,
    options: normalizeSnapshotOptions(options),
    tree: renderable,
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
    }),
  );
}

function configureTreeTreeCommand(command: Command): void {
  command
    .option("-L, --level <depth>", "max display depth, where the current directory is depth 0")
    .option(
      "-P, --pattern <pattern>",
      "shell-style glob filter matched against path, filename, title, and description",
    );
}

export function runTreeTreeCommand(context: CommandContext): void {
  try {
    const options = context.command.opts<Record<string, unknown>>();
    const snapshot = readContextTreeSnapshot(process.cwd(), {
      level: parseTreeLevel(options.level),
      pattern: asString(options.pattern),
    });

    if (context.options.json || isJsonMode()) {
      print.result(snapshot);
      return;
    }

    print.line(`${renderContextTreeSnapshot(snapshot)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("Invalid --level") ? TREE_TREE_INVALID_LEVEL : TREE_TREE_FAILED;
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
