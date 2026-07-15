import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  ContextTreeChange,
  ContextTreeChangeType,
  ContextTreeEdge,
  ContextTreeIoSummary,
  ContextTreeNode,
  ContextTreeNodeKind,
  ContextTreeSnapshot,
  ContextTreeSummary,
  ContextTreeUpdate,
  ContextTreeUsageSummary,
  ContextTreeWriteEvent,
} from "@first-tree/shared";
import { contextTreeBranchSchema } from "@first-tree/shared";
import { defaultDataDir } from "@first-tree/shared/config";
import matter from "gray-matter";
import { type TimingSink, timeSyncWithSink, timeWithSink } from "../observability/timing.js";

const execFileAsync = promisify(execFile);
const ROOT_NODE_ID = "root";
const NODE_FILE = "NODE.md";
const EMPTY_TREE_COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF_ENTRIES = 200;
const MAX_MARKDOWN_FILES = 1_000;
const MAX_MARKDOWN_FILE_BYTES = 512 * 1024;
const SNAPSHOT_CACHE_TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 5_000;
const GIT_SYNC_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_LOG_RECORD_SEPARATOR = "\x1e";
const REMOTE_SYNC_TTL_MS = 60_000;
const REMOTE_FAILURE_TTL_MS = 30_000;
const CONTEXT_TREE_SNAPSHOT_WINDOWS = {
  ONE_DAY: "1d",
  SEVEN_DAYS: "7d",
  THIRTY_DAYS: "30d",
} as const;

export type ContextTreeSnapshotWindow =
  (typeof CONTEXT_TREE_SNAPSHOT_WINDOWS)[keyof typeof CONTEXT_TREE_SNAPSHOT_WINDOWS];

const WINDOW_DAYS: Record<ContextTreeSnapshotWindow, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

export function contextTreeSnapshotWindowDays(window: ContextTreeSnapshotWindow): number {
  return WINDOW_DAYS[window];
}

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
  commit: string;
  changedAt: string | null;
  changedBy: string | null;
  summary: string | null;
  prNumber: number | null;
};

type DiffEntryInput = Pick<DiffEntry, "type" | "path">;

type ChangeMetadata = Pick<DiffEntry, "commit" | "changedAt" | "changedBy" | "summary" | "prNumber">;

type DiffReadResult = {
  entries: DiffEntry[];
  truncated: boolean;
};

type SnapshotCacheEntry = {
  expiresAt: number;
  snapshot: ContextTreeSnapshot;
};

type ResolvedContextTreeRoot = {
  root: string | null;
  reason: string;
  staleReason: string | null;
};

type RemoteSyncResult = {
  staleReason: string | null;
};

type RemoteSyncFailure = {
  failedAt: number;
  reason: string;
};

type GitOutputOptions = {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  disableHooks?: boolean;
};

const snapshotCache = new Map<string, SnapshotCacheEntry>();
const remoteSyncPromises = new Map<string, Promise<RemoteSyncResult>>();
const remoteLastSyncedAt = new Map<string, number>();
const remoteLastSyncWarnings = new Map<string, string>();
const remoteLastFailures = new Map<string, RemoteSyncFailure>();

/**
 * Per-organization Context Tree binding. Resolved from `organization_settings`
 * by the calling route — this service stays decoupled from any single-tenant
 * global config so each org gets its own tree.
 */
export type ContextTreeBinding = {
  repo?: string;
  branch?: string;
  localPath?: string;
  githubToken?: string;
};

export type ContextTreeSnapshotOptions = {
  timing?: TimingSink;
};

export async function getContextTreeSnapshot(
  binding: ContextTreeBinding,
  window: ContextTreeSnapshotWindow = CONTEXT_TREE_SNAPSHOT_WINDOWS.SEVEN_DAYS,
  options: ContextTreeSnapshotOptions = {},
): Promise<ContextTreeSnapshot> {
  const repo = binding.repo ?? null;
  const branch = binding.branch ?? null;
  const timing = options.timing;
  const resolved = await timeWithSink(timing, "resolve_root", () =>
    resolveContextTreeRoot(repo, binding.localPath, branch, binding.githubToken, timing),
  );

  if (!resolved.root) {
    return unavailableSnapshot(repo, branch, resolved.reason);
  }

  const now = new Date().toISOString();
  try {
    const { headCommit, actualBranch } = await timeWithSink(timing, "git_head", async () => ({
      headCommit: await gitOutput(resolved.root ?? "", ["rev-parse", "HEAD"]),
      actualBranch: await safeGitOutput(resolved.root ?? "", ["rev-parse", "--abbrev-ref", "HEAD"]),
    }));
    if (branch && actualBranch && actualBranch !== branch) {
      return unavailableSnapshot(
        repo,
        actualBranch,
        `Context Tree checkout is on branch "${actualBranch}", but the configured Context Tree branch is "${branch}".`,
      );
    }

    const comparisonBaseCommit = await timeWithSink(timing, "comparison_base", () =>
      comparisonBaseForWindow(resolved.root ?? "", window),
    );
    const cacheKey = snapshotCacheKey(resolved.root, actualBranch ?? branch, headCommit, comparisonBaseCommit, window);
    const cached = snapshotCache.get(cacheKey);
    timing?.("snapshot_cache_lookup", 0, { hit: !!cached });
    if (cached && cached.expiresAt > Date.now()) {
      const staleCacheRecovered = cached.snapshot.snapshotStatus === "stale" && !resolved.staleReason;
      if (!staleCacheRecovered) {
        return withSnapshotStatus(cached.snapshot, now, statusWarningFromResolved(resolved.staleReason, null));
      }
    }

    const files = await timeWithSink(timing, "read_markdown_files", () => readMarkdownFiles(resolved.root ?? ""));
    timing?.("read_markdown_files_count", 0, { fileCount: files.length });
    const tree = timeSyncWithSink(timing, "build_tree", () => buildTree(files), { fileCount: files.length });
    timing?.("build_tree_count", 0, { nodeCount: tree.nodes.length, edgeCount: tree.edges.length });
    const diffResult = comparisonBaseCommit
      ? await timeWithSink(timing, "read_diff_entries", () =>
          readDiffEntries(resolved.root ?? "", comparisonBaseCommit, headCommit),
        )
      : { entries: [], truncated: false };
    timing?.("read_diff_entries_count", 0, { changeCount: diffResult.entries.length, truncated: diffResult.truncated });
    const snapshot = timeSyncWithSink(timing, "build_snapshot", () => {
      const changes = buildChanges(diffResult.entries, tree);
      const nodes = applyChangesToNodes(tree.nodes, changes);
      const nodesWithGhosts = addRemovedGhostNodes(nodes, changes);
      const summary = summarizeChanges(changes);
      const updates = buildUpdates(changes, nodesWithGhosts);
      // Git-derived writes are cacheable with the rest of the snapshot — they
      // depend only on the repo's git history, not on the viewer or any DB
      // state. The route enriches them with session-telemetry agent attribution
      // (which is viewer-dependent) after this cached snapshot is read.
      const writes = buildWriteEvents(changes, nodesWithGhosts);
      const statusWarning = statusWarningFromResolved(resolved.staleReason, diffResult.truncated);

      return {
        repo,
        branch: actualBranch ?? branch,
        headCommit,
        syncedAt: now,
        snapshotStatus: statusWarning?.stale ? "stale" : "active",
        contextStatus: contextStatus(statusWarning),
        summary,
        usage: emptyUsageSummary(window),
        io: { ...emptyIoSummary(window), writes, writesTotal: writes.length },
        updates,
        nodes: nodesWithGhosts,
        edges: tree.edges,
        changes,
      } satisfies ContextTreeSnapshot;
    });
    snapshotCache.set(cacheKey, { expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS, snapshot });
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read Context Tree snapshot";
    return unavailableSnapshot(repo, branch, message);
  }
}

function snapshotCacheKey(
  root: string,
  branch: string | null | undefined,
  headCommit: string,
  comparisonBase: string | null,
  window: ContextTreeSnapshotWindow,
): string {
  return [root, branch ?? "unknown", headCommit, comparisonBase ?? "none", window].join(":");
}

function statusWarningFromResolved(
  staleReason: string | null,
  truncated: boolean | null,
): { detail: string; stale: boolean } | null {
  if (staleReason) {
    const suffix = truncated ? ` Showing the first ${MAX_DIFF_ENTRIES} changed files.` : "";
    return { detail: `${staleReason}${suffix}`, stale: true };
  }
  if (truncated) return { detail: `Showing the first ${MAX_DIFF_ENTRIES} changed files.`, stale: false };
  return null;
}

async function resolveContextTreeRoot(
  repo: string | null,
  localPath: string | null | undefined,
  branch: string | null,
  githubToken?: string | null,
  timing?: TimingSink,
): Promise<ResolvedContextTreeRoot> {
  if (localPath && localPath.trim().length > 0) {
    const root = resolveLocalPath(localPath);
    if (existsSync(root)) return { root, reason: "ok", staleReason: null };
    return { root: null, reason: `Context Tree checkout not found at ${root}.`, staleReason: null };
  }

  if (!repo) {
    return { root: null, reason: "Context Tree is not configured.", staleReason: null };
  }

  if (isRemoteRepo(repo)) {
    const resolvedBranch = branch ?? "main";
    if (!contextTreeBranchSchema.safeParse(resolvedBranch).success) {
      return {
        root: null,
        reason: `Configured Context Tree branch "${resolvedBranch}" is invalid.`,
        staleReason: null,
      };
    }
    try {
      const materialized = await materializeRemoteContextTree(repo, resolvedBranch, undefined, githubToken, timing);
      return { root: materialized.root, reason: "ok", staleReason: materialized.staleReason };
    } catch (error) {
      return {
        root: null,
        reason: `First Tree could not sync the configured Context Tree repo. Check repo access and branch "${resolvedBranch}". ${errorMessage(error)}`,
        staleReason: null,
      };
    }
  }

  const root = resolveLocalPath(repo);
  if (existsSync(root)) {
    return { root, reason: "ok", staleReason: null };
  }

  return { root: null, reason: `Context Tree checkout not found at ${root}.`, staleReason: null };
}

function resolveLocalPath(value: string): string {
  const normalized = value.startsWith("file://") ? value.slice("file://".length) : value;
  return isAbsolute(normalized) ? normalize(normalized) : resolve(process.cwd(), normalized);
}

function isRemoteRepo(value: string): boolean {
  return (
    /^https?:\/\//.test(value) || /^file:\/\//.test(value) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)
  );
}

function normalizeRemoteRepoUrl(value: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) {
    return `https://github.com/${value}`;
  }
  return value;
}

/**
 * Whether this binding actually drives a GitHub-hosted remote fetch — the
 * only case where minting a GitHub App installation token is meaningful.
 *
 * Returns false when:
 *  - `localPath` is set (sync code short-circuits to the local checkout
 *    before ever looking at `repo`)
 *  - `repo` is missing
 *  - `repo` is a file:// URL, a non-GitHub HTTPS URL, or otherwise
 *    unparseable
 *
 * Used by the snapshot routes to gate the "install the GitHub App"
 * guidance — without this gate, every unavailable snapshot (missing repo,
 * bad branch, …) gets a misleading App-install hint appended.
 */
export function isGithubRemoteBinding(binding: { repo?: string; localPath?: string }): boolean {
  if (binding.localPath && binding.localPath.trim().length > 0) return false;
  if (!binding.repo) return false;
  return isGithubHttpsRepo(normalizeRemoteRepoUrl(binding.repo));
}

function managedContextTreeCacheRoot(): string {
  return join(defaultDataDir(), "context-tree-repos");
}

function managedContextTreePath(repoUrl: string, branch: string, cacheRoot = managedContextTreeCacheRoot()): string {
  const hash = createHash("sha256").update(`${repoUrl}\0${branch}`).digest("hex");
  return join(cacheRoot, hash);
}

async function materializeRemoteContextTree(
  repo: string,
  branch: string,
  cacheRoot = managedContextTreeCacheRoot(),
  githubToken?: string | null,
  timing?: TimingSink,
): Promise<{ root: string; staleReason: string | null }> {
  const repoUrl = normalizeRemoteRepoUrl(repo);
  const root = managedContextTreePath(repoUrl, branch, cacheRoot);
  const lastSyncedAt = remoteLastSyncedAt.get(root);
  if (lastSyncedAt && Date.now() - lastSyncedAt < REMOTE_SYNC_TTL_MS && existsSync(join(root, ".git"))) {
    timing?.("remote_sync_skip_ttl", 0, { stale: remoteLastSyncWarnings.has(root) });
    return { root, staleReason: remoteLastSyncWarnings.get(root) ?? null };
  }
  const lastFailure = remoteLastFailures.get(root);
  if (lastFailure && Date.now() - lastFailure.failedAt < REMOTE_FAILURE_TTL_MS && !existsSync(join(root, ".git"))) {
    throw new Error(lastFailure.reason);
  }

  const existing = remoteSyncPromises.get(root);
  if (existing) {
    const result = await timeWithSink(timing, "remote_sync_wait_existing", () => existing);
    return { root, staleReason: result.staleReason };
  }

  const syncPromise = syncRemoteContextTree(repoUrl, branch, root, cacheRoot, githubToken, timing);
  remoteSyncPromises.set(root, syncPromise);
  try {
    const syncResult = await syncPromise;
    remoteLastSyncedAt.set(root, Date.now());
    remoteLastFailures.delete(root);
    if (syncResult.staleReason) {
      remoteLastSyncWarnings.set(root, syncResult.staleReason);
    } else {
      remoteLastSyncWarnings.delete(root);
    }
    return { root, staleReason: syncResult.staleReason };
  } catch (error) {
    if (!existsSync(join(root, ".git"))) {
      remoteLastFailures.set(root, {
        failedAt: Date.now(),
        reason: `Previous Context Tree sync failed recently. ${errorMessage(error)}`,
      });
    }
    throw error;
  } finally {
    remoteSyncPromises.delete(root);
  }
}

async function syncRemoteContextTree(
  repoUrl: string,
  branch: string,
  root: string,
  cacheRoot: string,
  githubToken?: string | null,
  timing?: TimingSink,
): Promise<RemoteSyncResult> {
  await mkdir(cacheRoot, { recursive: true });
  const env = await gitAuthEnv(repoUrl, cacheRoot, githubToken);
  if (!existsSync(join(root, ".git"))) {
    await rm(root, { recursive: true, force: true });
    await timeWithSink(
      timing,
      "remote_clone",
      () =>
        gitOutput(cacheRoot, ["clone", "--branch", branch, "--single-branch", repoUrl, root], {
          timeout: GIT_SYNC_TIMEOUT_MS,
          env,
          disableHooks: true,
        }),
      { branch },
    );
    return { staleReason: null };
  }

  try {
    await gitOutput(root, ["remote", "set-url", "origin", repoUrl], {
      timeout: GIT_TIMEOUT_MS,
      disableHooks: true,
    });
    await timeWithSink(
      timing,
      "remote_fetch_checkout",
      async () => {
        await gitOutput(root, ["fetch", "origin", branch, "--prune"], {
          timeout: GIT_SYNC_TIMEOUT_MS,
          env,
          disableHooks: true,
        });
        await gitOutput(root, ["checkout", "-B", branch, `origin/${branch}`], {
          timeout: GIT_TIMEOUT_MS,
          disableHooks: true,
        });
      },
      { branch },
    );
    return { staleReason: null };
  } catch (error) {
    if (existsSync(join(root, ".git"))) {
      timing?.("remote_sync_stale_fallback", 0);
      return {
        staleReason: `Showing the last synced Context Tree snapshot because First Tree could not refresh the configured repo. ${errorMessage(error)}`,
      };
    }
    throw error;
  }
}

async function gitAuthEnv(
  repoUrl: string,
  cacheRoot: string,
  githubToken?: string | null,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (!githubToken || !isGithubHttpsRepo(repoUrl)) return undefined;
  const askpassPath = join(cacheRoot, ".tools", "git-askpass.sh");
  if (!existsSync(askpassPath)) {
    await mkdir(dirname(askpassPath), { recursive: true });
    await writeFile(
      askpassPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        '*Username*) printf "%s\\n" "$GIT_USERNAME" ;;',
        '*) printf "%s\\n" "$GIT_PASSWORD" ;;',
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(askpassPath, 0o700);
  }
  return {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_USERNAME: "x-access-token",
    GIT_PASSWORD: githubToken,
  };
}

function isGithubHttpsRepo(repoUrl: string): boolean {
  try {
    const url = new URL(repoUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function contextStatus(warning: { detail: string; stale: boolean } | null): ContextTreeSnapshot["contextStatus"] {
  if (warning?.stale) {
    return {
      label: "Context Tree may be stale",
      detail: warning.detail,
      severity: "warning",
    };
  }
  if (warning) {
    return {
      label: "Context Tree needs attention",
      detail: warning.detail,
      severity: "warning",
    };
  }
  return {
    label: "Context Tree is up to date",
    detail: "Agents have a synced team context snapshot available.",
    severity: "ok",
  };
}

function withSnapshotStatus(
  snapshot: ContextTreeSnapshot,
  syncedAt: string,
  warning: { detail: string; stale: boolean } | null,
): ContextTreeSnapshot {
  return {
    ...snapshot,
    syncedAt,
    snapshotStatus: warning?.stale ? "stale" : snapshot.snapshotStatus,
    contextStatus: warning ? contextStatus(warning) : snapshot.contextStatus,
  };
}

function emptyUsageSummary(window: ContextTreeSnapshotWindow): ContextTreeUsageSummary {
  return { windowDays: WINDOW_DAYS[window], agentCount: 0, usageCount: 0, recentEvents: [] };
}

function emptyIoSummary(window: ContextTreeSnapshotWindow): ContextTreeIoSummary {
  const emptyBucket = { agentCount: 0, eventCount: 0, targetCount: 0 };
  return {
    windowDays: WINDOW_DAYS[window],
    summary: {
      read: emptyBucket,
      write: emptyBucket,
    },
    agents: [],
    recentEvents: [],
    writes: [],
    writesTotal: 0,
    skipped: { windowDays: WINDOW_DAYS[window], totalEventCount: 0, reasons: [] },
  };
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return "";
  return redactSecret(error.message.trim().split("\n")[0] ?? "");
}

function redactSecret(message: string): string {
  return message
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[redacted]@")
    .replace(/\b(?:ghp|ghs|ghu|gho|ghr)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[redacted]");
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
    usage: emptyUsageSummary(CONTEXT_TREE_SNAPSHOT_WINDOWS.SEVEN_DAYS),
    io: emptyIoSummary(CONTEXT_TREE_SNAPSHOT_WINDOWS.SEVEN_DAYS),
    updates: [],
    nodes: [],
    edges: [],
    changes: [],
  };
}

async function gitOutput(cwd: string, args: string[], options?: GitOutputOptions): Promise<string> {
  const gitArgs = options?.disableHooks ? ["-c", "core.hooksPath=/dev/null", ...args] : args;
  const { stdout } = await execFileAsync("git", gitArgs, {
    cwd,
    timeout: options?.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: options?.env,
  });
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
  const paths = (await walkMarkdown(root, root)).slice(0, MAX_MARKDOWN_FILES);
  const files = await Promise.all(
    paths.map(async (path): Promise<SourceFile | null> => {
      const absolutePath = join(root, path);
      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_MARKDOWN_FILE_BYTES) return null;
      const raw = await readFile(absolutePath, "utf8");
      return { relativePath: path, parsed: parseMarkdown(raw) };
    }),
  );
  return files.filter((file): file is SourceFile => file !== null);
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

async function comparisonBaseForWindow(root: string, window: ContextTreeSnapshotWindow): Promise<string | null> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS[window] * 24 * 60 * 60 * 1000).toISOString();
  const commitBeforeWindow = await safeGitOutput(root, ["rev-list", "-1", `--before=${cutoff}`, "HEAD"]);
  return commitBeforeWindow && commitBeforeWindow.length > 0 ? commitBeforeWindow : EMPTY_TREE_COMMIT;
}

async function readDiffEntries(root: string, comparisonBase: string, headCommit: string): Promise<DiffReadResult> {
  if (!isSafeCommit(comparisonBase) || !isSafeCommit(headCommit)) {
    return { entries: [], truncated: false };
  }
  try {
    const output = await gitOutput(root, ["diff", "--name-status", "-M", comparisonBase, "HEAD", "--", "*.md"]);
    if (!output) return { entries: [], truncated: false };
    const pendingEntries: DiffEntryInput[] = [];
    for (const line of output.split("\n")) {
      if (pendingEntries.length >= MAX_DIFF_ENTRIES) break;
      const parts = line.split("\t").filter(Boolean);
      const status = parts[0];
      if (!status) continue;
      if (status.startsWith("R")) {
        const oldPath = parts[1];
        const newPath = parts[2];
        if (oldPath) pendingEntries.push({ type: "removed", path: toPosix(oldPath) });
        if (pendingEntries.length >= MAX_DIFF_ENTRIES) break;
        if (newPath) pendingEntries.push({ type: "added", path: toPosix(newPath) });
        continue;
      }
      const path = parts[1];
      if (!path) continue;
      if (status === "A") pendingEntries.push({ type: "added", path: toPosix(path) });
      if (status === "M") pendingEntries.push({ type: "edited", path: toPosix(path) });
      if (status === "D") pendingEntries.push({ type: "removed", path: toPosix(path) });
    }
    const metadataByPath = await readChangeMetadataByPath(
      root,
      comparisonBase,
      headCommit,
      pendingEntries.map((entry) => entry.path),
    );
    const entries = pendingEntries.map((entry) => ({
      ...entry,
      ...(metadataByPath.get(entry.path) ?? fallbackChangeMetadata(headCommit)),
    }));
    return { entries, truncated: output.split("\n").filter(Boolean).length > entries.length };
  } catch {
    return { entries: [], truncated: false };
  }
}

async function readChangeMetadataByPath(
  root: string,
  comparisonBase: string,
  headCommit: string,
  paths: string[],
): Promise<Map<string, ChangeMetadata>> {
  const uniquePaths = [...new Set(paths)];
  const metadataByPath = new Map<string, ChangeMetadata>();
  if (uniquePaths.length === 0) return metadataByPath;

  const output = await safeGitOutput(root, [
    "log",
    "--name-only",
    `--format=${GIT_LOG_RECORD_SEPARATOR}%H%x00%cI%x00%an%x00%s`,
    `${comparisonBase}..HEAD`,
    "--",
    ...uniquePaths,
  ]);
  if (!output) return metadataByPath;

  for (const rawRecord of output.split(GIT_LOG_RECORD_SEPARATOR)) {
    const record = rawRecord.trim();
    if (!record) continue;
    const newlineIndex = record.indexOf("\n");
    const header = newlineIndex === -1 ? record : record.slice(0, newlineIndex);
    const changedPaths =
      newlineIndex === -1
        ? []
        : record
            .slice(newlineIndex + 1)
            .split("\n")
            .map((path) => toPosix(path.trim()))
            .filter((path) => path.length > 0);
    const fields = header.split("\x00");
    const commit = fields[0];
    if (!commit || !isSafeCommit(commit)) continue;
    const rawSubject = fields[3] ?? null;
    const metadata: ChangeMetadata = {
      commit,
      changedAt: fields[1] && fields[1].length > 0 ? fields[1] : null,
      changedBy: fields[2] && fields[2].length > 0 ? fields[2] : null,
      summary: cleanCommitSubject(rawSubject),
      prNumber: parsePrNumber(rawSubject),
    };
    for (const changedPath of changedPaths) {
      if (!metadataByPath.has(changedPath)) metadataByPath.set(changedPath, metadata);
    }
  }

  for (const path of uniquePaths) {
    if (!metadataByPath.has(path)) metadataByPath.set(path, fallbackChangeMetadata(headCommit));
  }
  return metadataByPath;
}

function fallbackChangeMetadata(headCommit: string): ChangeMetadata {
  return { commit: headCommit, changedAt: null, changedBy: null, summary: null, prNumber: null };
}

function isSafeCommit(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

// Extract the PR number from a commit subject, covering both GitHub merge
// styles:
//   - squash / rebase: trailing "(#514)", e.g. "feat: record … (#514)"
//   - merge commit:     leading "Merge pull request #514 from …"
// For the squash form we take the LAST "(#N)" so an inline issue reference
// earlier in the subject doesn't win over the real PR id.
function parsePrNumber(subject: string | null): number | null {
  if (!subject) return null;
  const mergeCommit = subject.match(/^Merge pull request #(\d+)\b/i)?.[1];
  const squash = [...subject.matchAll(/\(#(\d+)\)/g)].at(-1)?.[1];
  const raw = mergeCommit ?? squash;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

function buildChanges(entries: DiffEntry[], tree: TreeBuildResult): ContextTreeChange[] {
  return entries.map((entry) => {
    const node = tree.nodeBySourcePath.get(entry.path) ?? tree.nodeByTreePath.get(stripMarkdownExtension(entry.path));
    return {
      path: entry.path,
      nodeId: node?.id ?? ghostNodeId(entry.path),
      type: entry.type,
      commit: entry.commit,
      changedAt: entry.changedAt,
      changedBy: entry.changedBy,
      summary: entry.summary,
      prNumber: entry.prNumber,
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
    const parentNodeId = dir ? dirNodeId(dir) : ROOT_NODE_ID;
    ghosts.push({
      id: change.nodeId,
      path: treePath,
      sourcePath: change.path,
      title: titleFromPath(treePath),
      kind: "leaf",
      owners: [],
      parentId: nodeIds.has(parentNodeId) ? parentNodeId : ROOT_NODE_ID,
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

// Git-derived write rows for the IO feed. One row per changed node in the
// window, carrying the landed commit / PR / risk / summary. Agent attribution
// is left null here — git only knows the *committer* (`changedBy`), not which
// agent authored the change. The route reconciles these against session write
// telemetry (which does carry agent identity) before the feed is served; see
// reconcileContextTreeWrites. `nodes` should include removed ghosts so deleted
// nodes still resolve a title.
function buildWriteEvents(changes: ContextTreeChange[], nodes: ContextTreeNode[]): ContextTreeWriteEvent[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const events = changes.map((change): ContextTreeWriteEvent => {
    const node = change.nodeId ? nodeById.get(change.nodeId) : undefined;
    const nodePath = node?.path ?? stripMarkdownExtension(change.path);
    return {
      id: `${change.commit ?? "uncommitted"}:${change.path}`,
      nodeId: change.nodeId,
      nodePath,
      title: node?.title ?? titleFromPath(nodePath),
      changeType: change.type,
      summary: change.summary,
      riskLevel: riskLevelForChange(change.type, node?.kind),
      authorName: change.changedBy,
      agentId: null,
      agentName: null,
      agentAvatarColorToken: null,
      commit: change.commit,
      prNumber: change.prNumber,
      createdAt: change.changedAt,
    };
  });
  events.sort((a, b) => writeEventTimeKey(b) - writeEventTimeKey(a));
  return events;
}

function writeEventTimeKey(event: ContextTreeWriteEvent): number {
  if (!event.createdAt) return 0;
  const parsed = Date.parse(event.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
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

export const contextTreeSnapshotTestInternals = {
  addRemovedGhostNodes,
  buildWriteEvents,
  parsePrNumber,
  buildTreeFromRawFiles(files: Array<{ relativePath: string; raw: string }>): TreeBuildResult {
    return buildTree(files.map((file) => ({ relativePath: file.relativePath, parsed: parseMarkdown(file.raw) })));
  },
  clearRemoteSyncState(): void {
    snapshotCache.clear();
    remoteLastSyncedAt.clear();
    remoteLastSyncWarnings.clear();
    remoteLastFailures.clear();
    remoteSyncPromises.clear();
  },
  gitAuthEnv,
  managedContextTreePath,
  materializeRemoteContextTree,
  parseMarkdownFallback,
  readDiffEntries,
  redactSecret,
  resolveContextTreeRoot,
};
