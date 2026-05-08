import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  ContextTreeChange,
  ContextTreeChangeType,
  ContextTreeEdge,
  ContextTreeNode,
  ContextTreeNodeKind,
  ContextTreeSnapshot,
  ContextTreeSummary,
  ContextTreeUpdate,
} from "@agent-team-foundation/first-tree-hub-shared";
import matter from "gray-matter";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);
const ROOT_NODE_ID = "root";
const NODE_FILE = "NODE.md";

type ParsedMarkdown = {
  content: string;
  data: unknown;
};

type SourceFile = {
  relativePath: string;
  parsed: ParsedMarkdown;
};

type TreeBuildResult = {
  nodes: ContextTreeNode[];
  edges: ContextTreeEdge[];
  nodeBySourcePath: Map<string, ContextTreeNode>;
  nodeByTreePath: Map<string, ContextTreeNode>;
};

type DiffEntry = {
  type: ContextTreeChangeType;
  path: string;
  changedBy: string | null;
  summary: string | null;
};

export async function getContextTreeSnapshot(config: Config, since: string | undefined): Promise<ContextTreeSnapshot> {
  const repo = config.contextTree?.repo ?? null;
  const branch = config.contextTree?.branch ?? null;
  const resolved = resolveContextTreeRoot(repo);

  if (!resolved.root) {
    return unavailableSnapshot(repo, branch, resolved.reason);
  }

  const now = new Date().toISOString();
  try {
    const headCommit = await gitOutput(resolved.root, ["rev-parse", "HEAD"]);
    const files = await readMarkdownFiles(resolved.root);
    const tree = buildTree(files);
    const comparisonBaseCommit = since ?? (await safeGitOutput(resolved.root, ["rev-parse", "HEAD~20"]));
    const diffEntries = comparisonBaseCommit ? await readDiffEntries(resolved.root, comparisonBaseCommit) : [];
    const changes = buildChanges(diffEntries, tree, headCommit);
    const nodes = applyChangesToNodes(tree.nodes, changes);
    const nodesWithGhosts = addRemovedGhostNodes(nodes, changes);
    const summary = summarizeChanges(changes);
    const updates = buildUpdates(changes, nodesWithGhosts);

    return {
      repo,
      branch: branch ?? (await safeGitOutput(resolved.root, ["rev-parse", "--abbrev-ref", "HEAD"])),
      headCommit,
      syncedAt: now,
      snapshotStatus: "active",
      contextStatus: {
        label: "Team context is current",
        detail: "Agents have a synced team context snapshot available.",
        severity: "ok",
      },
      summary,
      updates,
      nodes: nodesWithGhosts,
      edges: tree.edges,
      changes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read Context Tree snapshot";
    return unavailableSnapshot(repo, branch, message);
  }
}

function resolveContextTreeRoot(repo: string | null): { root: string | null; reason: string } {
  const envPath = process.env.FIRST_TREE_HUB_CONTEXT_TREE_PATH;
  const candidate = envPath && envPath.trim().length > 0 ? envPath : repo;
  if (!candidate) {
    return { root: null, reason: "Context Tree is not configured." };
  }

  const normalized = candidate.startsWith("file://") ? candidate.slice("file://".length) : candidate;
  const root = isAbsolute(normalized) ? normalize(normalized) : resolve(process.cwd(), normalized);
  if (existsSync(root)) {
    return { root, reason: "ok" };
  }

  if (/^https?:\/\//.test(normalized) || /^[^/]+\/[^/]+$/.test(normalized)) {
    return {
      root: null,
      reason:
        "Context Tree repo is configured as a remote URL. Set FIRST_TREE_HUB_CONTEXT_TREE_PATH to a readable local checkout for this version.",
    };
  }

  return { root: null, reason: `Context Tree checkout not found at ${root}.` };
}

function unavailableSnapshot(repo: string | null, branch: string | null, detail: string): ContextTreeSnapshot {
  return {
    repo,
    branch,
    headCommit: null,
    syncedAt: null,
    snapshotStatus: "unavailable",
    contextStatus: {
      label: "Team context unavailable",
      detail,
      severity: "error",
    },
    summary: { addedCount: 0, editedCount: 0, removedCount: 0, changedNodeCount: 0 },
    updates: [],
    nodes: [],
    edges: [],
    changes: [],
  };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function safeGitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await gitOutput(cwd, args);
  } catch {
    return null;
  }
}

async function readMarkdownFiles(root: string): Promise<SourceFile[]> {
  const paths = await walkMarkdown(root, root);
  const files: SourceFile[] = [];
  for (const path of paths) {
    const raw = await readFile(join(root, path), "utf8");
    files.push({ relativePath: path, parsed: parseMarkdown(raw) });
  }
  return files;
}

function parseMarkdown(raw: string): ParsedMarkdown {
  try {
    const parsed = matter(raw);
    return { content: parsed.content, data: parsed.data };
  } catch {
    return parseMarkdownFallback(raw);
  }
}

function parseMarkdownFallback(raw: string): ParsedMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { content: raw, data: {} };
  const frontmatter = match[1] ?? "";
  const data: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    const key = field[1];
    const value = field[2] ?? "";
    if (key === "title") {
      data.title = value.replace(/^["']|["']$/g, "");
      continue;
    }
    if (key === "owners" || key === "soft_links") {
      data[key] = parseInlineStringList(value);
    }
  }
  return { content: raw.slice(match[0].length), data };
}

function parseInlineStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.length > 0);
}

async function walkMarkdown(root: string, current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walkMarkdown(root, absolute)));
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      paths.push(toPosix(relative(root, absolute)));
    }
  }
  paths.sort((a, b) => a.localeCompare(b));
  return paths;
}

function buildTree(files: SourceFile[]): TreeBuildResult {
  const nodeBySourcePath = new Map<string, ContextTreeNode>();
  const nodeByTreePath = new Map<string, ContextTreeNode>();
  const dirNodeContent = new Map<string, SourceFile>();
  const leafFiles: SourceFile[] = [];
  const directories = new Set<string>([""]);

  for (const file of files) {
    const dir = sourceDir(file.relativePath);
    addDirectoryAncestors(directories, dir);
    if (file.relativePath.endsWith(`/${NODE_FILE}`) || file.relativePath === NODE_FILE) {
      dirNodeContent.set(dir, file);
    } else {
      leafFiles.push(file);
    }
  }

  const rootNode: ContextTreeNode = {
    id: ROOT_NODE_ID,
    path: "",
    sourcePath: NODE_FILE,
    title: titleFromFile(dirNodeContent.get("")?.parsed.data, "Context Tree"),
    kind: "root",
    owners: ownersFromFile(dirNodeContent.get("")?.parsed.data),
    parentId: null,
    preview: previewFromContent(dirNodeContent.get("")?.parsed.content ?? ""),
    relatedNodeIds: [],
    affectedContextArea: "root",
    changeType: null,
    changedAtCommit: null,
  };
  const nodes: ContextTreeNode[] = [rootNode];
  nodeByTreePath.set("", rootNode);
  if (dirNodeContent.has("")) nodeBySourcePath.set(NODE_FILE, rootNode);

  const sortedDirs = [...directories].filter((dir) => dir.length > 0).sort((a, b) => a.localeCompare(b));
  for (const dir of sortedDirs) {
    const source = dirNodeContent.get(dir);
    const node: ContextTreeNode = {
      id: dirNodeId(dir),
      path: dir,
      sourcePath: source?.relativePath ?? null,
      title: titleFromFile(source?.parsed.data, titleFromPath(dir)),
      kind: kindForDirectory(dir),
      owners: ownersFromFile(source?.parsed.data),
      parentId: parentDir(dir) ? dirNodeId(parentDir(dir)) : ROOT_NODE_ID,
      preview: previewFromContent(source?.parsed.content ?? ""),
      relatedNodeIds: [],
      affectedContextArea: contextAreaFromPath(dir),
      changeType: null,
      changedAtCommit: null,
    };
    nodes.push(node);
    nodeByTreePath.set(dir, node);
    if (source) nodeBySourcePath.set(source.relativePath, node);
  }

  for (const file of leafFiles) {
    const treePath = stripMarkdownExtension(file.relativePath);
    const dir = sourceDir(file.relativePath);
    const node: ContextTreeNode = {
      id: fileNodeId(file.relativePath),
      path: treePath,
      sourcePath: file.relativePath,
      title: titleFromFile(file.parsed.data, titleFromPath(treePath)),
      kind: "leaf",
      owners: ownersFromFile(file.parsed.data),
      parentId: dir ? dirNodeId(dir) : ROOT_NODE_ID,
      preview: previewFromContent(file.parsed.content),
      relatedNodeIds: [],
      affectedContextArea: contextAreaFromPath(treePath),
      changeType: null,
      changedAtCommit: null,
    };
    nodes.push(node);
    nodeByTreePath.set(treePath, node);
    nodeBySourcePath.set(file.relativePath, node);
  }

  const edges = parentEdges(nodes);
  const relatedEdges = relatedEdgesForFiles(files, nodeByTreePath, nodeBySourcePath);
  const relatedByNode = new Map<string, Set<string>>();
  for (const edge of relatedEdges) {
    if (!relatedByNode.has(edge.source)) relatedByNode.set(edge.source, new Set<string>());
    relatedByNode.get(edge.source)?.add(edge.target);
  }

  const nodesWithRelated = nodes.map((node) => ({
    ...node,
    relatedNodeIds: [...(relatedByNode.get(node.id) ?? new Set<string>())],
  }));

  return {
    nodes: nodesWithRelated,
    edges: [...edges, ...relatedEdges],
    nodeBySourcePath,
    nodeByTreePath,
  };
}

function parentEdges(nodes: ContextTreeNode[]): ContextTreeEdge[] {
  return nodes
    .filter((node) => node.parentId)
    .map((node) => ({ source: node.parentId ?? ROOT_NODE_ID, target: node.id, kind: "parent" }));
}

function relatedEdgesForFiles(
  files: SourceFile[],
  nodeByTreePath: Map<string, ContextTreeNode>,
  nodeBySourcePath: Map<string, ContextTreeNode>,
): ContextTreeEdge[] {
  const edges: ContextTreeEdge[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const sourceNode = nodeBySourcePath.get(file.relativePath);
    if (!sourceNode) continue;
    const softLinks = stringArrayField(file.parsed.data, "soft_links");
    for (const link of softLinks) {
      const target = resolveLinkedNode(link, file.relativePath, nodeByTreePath);
      if (!target) continue;
      const key = `${sourceNode.id}:soft_link:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: sourceNode.id, target: target.id, kind: "soft_link" });
    }

    for (const link of markdownLinks(file.parsed.content)) {
      const target = resolveLinkedNode(link, file.relativePath, nodeByTreePath);
      if (!target) continue;
      const key = `${sourceNode.id}:markdown_link:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: sourceNode.id, target: target.id, kind: "markdown_link" });
    }
  }

  return edges;
}

async function readDiffEntries(root: string, since: string): Promise<DiffEntry[]> {
  try {
    const output = await gitOutput(root, ["diff", "--name-status", `${since}..HEAD`, "--", "*.md"]);
    if (!output) return [];
    const entries: DiffEntry[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("\t").filter(Boolean);
      const status = parts[0];
      if (!status) continue;
      if (status.startsWith("R")) {
        const oldPath = parts[1];
        const newPath = parts[2];
        if (oldPath) entries.push(await hydrateDiffEntry(root, { type: "removed", path: toPosix(oldPath) }));
        if (newPath) entries.push(await hydrateDiffEntry(root, { type: "added", path: toPosix(newPath) }));
        continue;
      }
      const path = parts[1];
      if (!path) continue;
      if (status === "A") entries.push(await hydrateDiffEntry(root, { type: "added", path: toPosix(path) }));
      if (status === "M") entries.push(await hydrateDiffEntry(root, { type: "edited", path: toPosix(path) }));
      if (status === "D") entries.push(await hydrateDiffEntry(root, { type: "removed", path: toPosix(path) }));
    }
    return entries;
  } catch {
    return [];
  }
}

async function hydrateDiffEntry(root: string, entry: Pick<DiffEntry, "type" | "path">): Promise<DiffEntry> {
  const changedBy = await safeGitOutput(root, ["log", "-1", "--format=%an", "HEAD", "--", entry.path]);
  return {
    ...entry,
    changedBy,
    summary: await summarizeDiffEntry(root, entry),
  };
}

async function summarizeDiffEntry(root: string, entry: Pick<DiffEntry, "path">): Promise<string | null> {
  const subject = await safeGitOutput(root, ["log", "-1", "--format=%s", "HEAD", "--", entry.path]);
  return cleanCommitSubject(subject);
}

function cleanCommitSubject(subject: string | null): string | null {
  if (!subject) return null;
  const cleaned = subject
    .trim()
    .replace(/^(feat|fix|docs|chore|refactor|test|style|perf|ci|build)(\([^)]+\))?:\s*/i, "")
    .replace(/\s+/g, " ");
  if (cleaned.length < 12) return null;
  if (cleaned.length > 140) return `${cleaned.slice(0, 137)}...`;
  if (/^(merge|wip|update|updated|change|changes)$/i.test(cleaned)) return null;
  return cleaned;
}

function buildChanges(entries: DiffEntry[], tree: TreeBuildResult, headCommit: string): ContextTreeChange[] {
  return entries.map((entry) => {
    const node = tree.nodeBySourcePath.get(entry.path) ?? tree.nodeByTreePath.get(stripMarkdownExtension(entry.path));
    return {
      path: entry.path,
      nodeId: node?.id ?? ghostNodeId(entry.path),
      type: entry.type,
      commit: headCommit,
      changedAt: null,
      changedBy: entry.changedBy,
      summary: entry.summary,
    };
  });
}

function applyChangesToNodes(nodes: ContextTreeNode[], changes: ContextTreeChange[]): ContextTreeNode[] {
  const changeByNode = new Map<string, ContextTreeChange>();
  for (const change of changes) {
    if (change.nodeId) changeByNode.set(change.nodeId, change);
  }
  return nodes.map((node) => {
    const change = changeByNode.get(node.id);
    if (!change) return node;
    return { ...node, changeType: change.type, changedAtCommit: change.commit };
  });
}

function addRemovedGhostNodes(nodes: ContextTreeNode[], changes: ContextTreeChange[]): ContextTreeNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const ghosts: ContextTreeNode[] = [];
  for (const change of changes) {
    if (change.type !== "removed" || !change.nodeId || nodeIds.has(change.nodeId)) continue;
    const treePath = stripMarkdownExtension(change.path);
    const dir = sourceDir(change.path);
    ghosts.push({
      id: change.nodeId,
      path: treePath,
      sourcePath: change.path,
      title: titleFromPath(treePath),
      kind: "leaf",
      owners: [],
      parentId: dir ? dirNodeId(dir) : ROOT_NODE_ID,
      preview: null,
      relatedNodeIds: [],
      affectedContextArea: contextAreaFromPath(treePath),
      changeType: "removed",
      changedAtCommit: change.commit,
    });
  }
  return [...nodes, ...ghosts];
}

function summarizeChanges(changes: ContextTreeChange[]): ContextTreeSummary {
  let addedCount = 0;
  let editedCount = 0;
  let removedCount = 0;
  for (const change of changes) {
    if (change.type === "added") addedCount += 1;
    if (change.type === "edited") editedCount += 1;
    if (change.type === "removed") removedCount += 1;
  }
  return {
    addedCount,
    editedCount,
    removedCount,
    changedNodeCount: changes.length,
  };
}

function buildUpdates(changes: ContextTreeChange[], nodes: ContextTreeNode[]): ContextTreeUpdate[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const updates = changes.map((change): ContextTreeUpdate => {
    const node = change.nodeId ? nodeById.get(change.nodeId) : undefined;
    const path = node?.path ?? stripMarkdownExtension(change.path);
    const title = node?.title ?? titleFromPath(path);
    const affectedContextArea = node?.affectedContextArea ?? contextAreaFromPath(path);
    return {
      id: `update:${change.type}:${change.path}`,
      nodeId: change.nodeId,
      path,
      title,
      changeType: change.type,
      affectedContextArea,
      reason: reasonForUpdate(change.type, affectedContextArea),
      summary: changeSummaryForUpdate(change, node),
      changedBy: change.changedBy,
      owners: node?.owners ?? [],
      relatedNodeIds: node?.relatedNodeIds ?? [],
      sourceCommit: change.commit,
      riskLevel: riskLevelForChange(change.type, node?.kind),
    };
  });

  updates.sort((a, b) => updateRank(a) - updateRank(b) || a.path.localeCompare(b.path));
  return updates;
}

function changeSummaryForUpdate(change: ContextTreeChange, node: ContextTreeNode | undefined): string {
  if (change.summary) return change.summary;
  if (change.type === "added") return "added this team knowledge";
  if (change.type === "removed") return "removed this team knowledge";
  return node ? `updated ${node.title}` : "updated this team knowledge";
}

function updateRank(update: ContextTreeUpdate): number {
  const depth = update.path.split("/").filter(Boolean).length;
  const specificityRank = depth >= 2 ? 0 : depth === 1 ? 1 : 2;
  const typeRank = update.changeType === "removed" ? 0 : update.changeType === "added" ? 1 : 2;
  return specificityRank * 10 + typeRank;
}

function riskLevelForChange(changeType: ContextTreeChangeType, kind: ContextTreeNodeKind | undefined) {
  if (changeType === "removed") return "high";
  if (kind === "root" || kind === "domain" || kind === "subdomain") return "medium";
  return "low";
}

function reasonForUpdate(changeType: ContextTreeChangeType, affectedContextArea: string): string {
  if (changeType === "added") {
    return `Agents can use new team knowledge when working on ${affectedContextArea}.`;
  }
  if (changeType === "removed") {
    return `Agents should stop using the old team knowledge for ${affectedContextArea}.`;
  }
  return `Agents can use updated team knowledge when working on ${affectedContextArea}.`;
}

function titleFromFile(data: unknown, fallback: string): string {
  const title = stringField(data, "title");
  return title ?? fallback;
}

function ownersFromFile(data: unknown): string[] {
  return stringArrayField(data, "owners");
}

function stringField(data: unknown, key: string): string | null {
  if (!isRecord(data)) return null;
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArrayField(data: unknown, key: string): string[] {
  if (!isRecord(data)) return [];
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewFromContent(content: string): string | null {
  const normalized = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(" ");
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function markdownLinks(content: string): string[] {
  const links: string[] = [];
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let match = re.exec(content);
  while (match) {
    const target = match[1];
    if (target && !/^https?:\/\//.test(target) && !target.startsWith("#")) {
      links.push(target.split("#")[0] ?? target);
    }
    match = re.exec(content);
  }
  return links;
}

function resolveLinkedNode(
  link: string,
  fromSourcePath: string,
  nodeByTreePath: Map<string, ContextTreeNode>,
): ContextTreeNode | null {
  const withoutAnchor = link.split("#")[0] ?? link;
  if (!withoutAnchor) return null;
  const baseDir = sourceDir(fromSourcePath);
  const raw = withoutAnchor.startsWith("/") ? withoutAnchor.slice(1) : toPosix(normalize(join(baseDir, withoutAnchor)));
  const cleaned = raw.replace(/^\.\//, "");
  const candidates = [
    stripMarkdownExtension(cleaned),
    stripMarkdownExtension(cleaned.replace(/\/NODE\.md$/i, "")),
    cleaned.replace(/\/$/g, ""),
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    const node = nodeByTreePath.get(candidate);
    if (node) return node;
  }
  return null;
}

function addDirectoryAncestors(directories: Set<string>, dir: string): void {
  if (!dir) return;
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    directories.add(parts.slice(0, i).join("/"));
  }
}

function kindForDirectory(dir: string): ContextTreeNodeKind {
  return dir.includes("/") ? "subdomain" : "domain";
}

function sourceDir(path: string): string {
  const dir = toPosix(dirname(path));
  return dir === "." ? "" : dir;
}

function parentDir(dir: string): string {
  const parent = toPosix(dirname(dir));
  return parent === "." ? "" : parent;
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\/NODE\.md$/i, "").replace(/\.md$/i, "");
}

function titleFromPath(path: string): string {
  const base = path.split("/").filter(Boolean).at(-1) ?? "Context Tree";
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function contextAreaFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  return parts.map((part) => part.replace(/[-_]+/g, " ")).join(" / ");
}

function dirNodeId(dir: string): string {
  return dir ? `dir:${dir}` : ROOT_NODE_ID;
}

function fileNodeId(path: string): string {
  return `file:${path}`;
}

function ghostNodeId(path: string): string {
  return `removed:${path}`;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
