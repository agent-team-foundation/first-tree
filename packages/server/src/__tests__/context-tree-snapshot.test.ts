import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ContextTreeChange, ContextTreeNode } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextTreeSnapshotTestInternals,
  getContextTreeSnapshot,
  isGithubRemoteBinding,
} from "../services/context-tree-snapshot.js";

const execFileAsync = promisify(execFile);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "context-tree-snapshot-"));
});

afterEach(async () => {
  contextTreeSnapshotTestInternals.clearRemoteSyncState();
  await rm(testDir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  return initRepoAt(testDir);
}

async function initRepoAt(cwd: string): Promise<string> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", "Context Reviewer"]);
  await git(cwd, ["config", "user.email", "context-reviewer@example.com"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  await git(cwd, ["config", "tag.gpgSign", "false"]);
  return cwd;
}

async function commitAll(message: string): Promise<string> {
  return commitAllAt(testDir, message);
}

async function commitAllAt(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", message]);
  return gitOutput(cwd, ["rev-parse", "HEAD"]);
}

async function commitAllAtDate(cwd: string, message: string, isoDate: string): Promise<string> {
  await git(cwd, ["add", "."]);
  await execFileAsync("git", ["commit", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  });
  return gitOutput(cwd, ["rev-parse", "HEAD"]);
}

describe("Context Tree snapshot service", () => {
  it("parses fallback frontmatter lists", () => {
    const parsed = contextTreeSnapshotTestInternals.parseMarkdownFallback(`---
title: "Client Runtime"
owners: ["alice", bob]
soft_links: ["../roadmap.md", "/agent-hub#runtime"]
---

Body`);

    expect(parsed.content.trim()).toBe("Body");
    expect(parsed.data).toEqual({
      title: "Client Runtime",
      owners: ["alice", "bob"],
      soft_links: ["../roadmap.md", "/agent-hub#runtime"],
    });
  });

  it("handles fallback frontmatter without valid YAML fields", () => {
    expect(contextTreeSnapshotTestInternals.parseMarkdownFallback("Plain body")).toEqual({
      content: "Plain body",
      data: {},
    });

    const parsed = contextTreeSnapshotTestInternals.parseMarkdownFallback(`---
title: 'Broken Lists'
owners: alice
ignored
soft_links: []
---
Body`);

    expect(parsed).toEqual({
      content: "Body",
      data: {
        title: "Broken Lists",
        owners: [],
        soft_links: [],
      },
    });
  });

  it("uses fallback frontmatter parsing when gray-matter rejects malformed YAML", () => {
    const tree = contextTreeSnapshotTestInternals.buildTreeFromRawFiles([
      {
        relativePath: "NODE.md",
        raw: "---\ntitle: [unterminated\nowners: [alice]\n---\nBody",
      },
    ]);

    expect(tree.nodes[0]).toMatchObject({
      id: "root",
      title: "[unterminated",
      owners: ["alice"],
      preview: "Body",
    });
  });

  it("builds soft-link and markdown-link edges without anchors", () => {
    const tree = contextTreeSnapshotTestInternals.buildTreeFromRawFiles([
      { relativePath: "NODE.md", raw: "---\ntitle: Context Tree\n---\nRoot" },
      {
        relativePath: "agent-hub/NODE.md",
        raw: '---\ntitle: Agent Hub\nsoft_links: ["/product-direction.md#north-star"]\n---\nHub',
      },
      {
        relativePath: "agent-hub/runtime.md",
        raw: "---\ntitle: Runtime\n---\nSee [direction](../product-direction.md#agent-runtime).",
      },
      { relativePath: "product-direction.md", raw: "---\ntitle: Product Direction\n---\nDirection" },
    ]);

    expect(tree.edges).toContainEqual({
      source: "dir:agent-hub",
      target: "file:product-direction.md",
      kind: "soft_link",
    });
    expect(tree.edges).toContainEqual({
      source: "file:agent-hub/runtime.md",
      target: "file:product-direction.md",
      kind: "markdown_link",
    });
  });

  it("builds directory metadata, deduplicates related edges, and skips unresolved links", () => {
    const longPreview = "x".repeat(260);
    const tree = contextTreeSnapshotTestInternals.buildTreeFromRawFiles([
      { relativePath: "NODE.md", raw: "---\ntitle: Context Tree\nowners: [root-owner]\n---\n# Heading\nRoot body" },
      {
        relativePath: "product-area/NODE.md",
        raw: '---\ntitle: Product Area\nowners: [alice]\nsoft_links: ["../shared.md", "../shared.md", "../missing.md"]\n---\nDomain body',
      },
      {
        relativePath: "product-area/runtime/NODE.md",
        raw: "---\ntitle: Runtime\n---\nSubdomain body",
      },
      {
        relativePath: "product-area/runtime/details.md",
        raw: `---\ntitle: Details\nowners: [bob, ""]\n---\n${longPreview}\n[shared](../../shared.md)\n[shared again](../../shared.md#section)\n[external](https://example.test)\n[anchor](#local)`,
      },
      { relativePath: "shared.md", raw: "---\ntitle: Shared\n---\nShared body" },
    ]);

    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "root", title: "Context Tree", owners: ["root-owner"], preview: "Root body" }),
        expect.objectContaining({ id: "dir:product-area", kind: "domain", owners: ["alice"] }),
        expect.objectContaining({ id: "dir:product-area/runtime", kind: "subdomain" }),
        expect.objectContaining({
          id: "file:product-area/runtime/details.md",
          owners: ["bob"],
          preview: `${"x".repeat(237)}...`,
          affectedContextArea: "product area / runtime / details",
        }),
      ]),
    );
    expect(tree.edges.filter((edge) => edge.kind === "soft_link")).toEqual([
      { source: "dir:product-area", target: "file:shared.md", kind: "soft_link" },
    ]);
    expect(tree.edges.filter((edge) => edge.kind === "markdown_link")).toEqual([
      { source: "file:product-area/runtime/details.md", target: "file:shared.md", kind: "markdown_link" },
    ]);
  });

  it("uses tree-building fallbacks when NODE metadata is absent or empty", () => {
    const tree = contextTreeSnapshotTestInternals.buildTreeFromRawFiles([
      {
        relativePath: "domain/empty.md",
        raw: '---\ntitle: ""\nowners: owner\nsoft_links: ["/domain/"]\n---\n# Heading only\n[missing](missing.md)',
      },
      {
        relativePath: "domain/target.md",
        raw: "---\ntitle: Target\n---\nTarget body",
      },
    ]);

    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "root",
          title: "Context Tree",
          preview: null,
          owners: [],
          affectedContextArea: "root",
        }),
        expect.objectContaining({
          id: "dir:domain",
          sourcePath: null,
          title: "Domain",
          parentId: "root",
          preview: null,
        }),
        expect.objectContaining({
          id: "file:domain/empty.md",
          title: "Empty",
          owners: [],
          preview: "[missing](missing.md)",
          relatedNodeIds: ["dir:domain"],
        }),
      ]),
    );
    expect(tree.edges).toContainEqual({ source: "file:domain/empty.md", target: "dir:domain", kind: "soft_link" });
  });

  it("handles empty tree paths and anchor-only soft links without resolving them", () => {
    const tree = contextTreeSnapshotTestInternals.buildTreeFromRawFiles([
      {
        relativePath: "",
        raw: '---\nowners: []\nsoft_links: ["#local"]\n---\nEmpty path body',
      },
      {
        relativePath: "target.md",
        raw: "---\ntitle: Target\n---\nTarget body",
      },
    ]);

    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "file:",
          path: "",
          title: "Context Tree",
          affectedContextArea: "root",
          relatedNodeIds: [],
        }),
      ]),
    );
    expect(tree.edges.some((edge) => edge.kind === "soft_link" && edge.source === "file:")).toBe(false);
  });

  it("mounts removed ghost nodes at root when their parent no longer exists", () => {
    const nodes: ContextTreeNode[] = [
      {
        id: "root",
        path: "",
        sourcePath: "NODE.md",
        title: "Context Tree",
        kind: "root",
        owners: [],
        parentId: null,
        preview: null,
        relatedNodeIds: [],
        affectedContextArea: "root",
        changeType: null,
        changedAtCommit: null,
      },
    ];
    const changes: ContextTreeChange[] = [
      {
        path: "removed-area/old.md",
        nodeId: "removed:removed-area/old.md",
        type: "removed",
        commit: "1111111111111111111111111111111111111111",
        changedAt: "2026-05-08T00:00:00.000Z",
        changedBy: "alice",
        summary: "remove old guidance",
        prNumber: null,
      },
    ];

    const withGhosts = contextTreeSnapshotTestInternals.addRemovedGhostNodes(nodes, changes);

    expect(withGhosts).toContainEqual(
      expect.objectContaining({
        id: "removed:removed-area/old.md",
        parentId: "root",
        changeType: "removed",
        changedAtCommit: "1111111111111111111111111111111111111111",
      }),
    );
  });

  it("mounts root-level removed ghost nodes directly under root", () => {
    const nodes: ContextTreeNode[] = [
      {
        id: "root",
        path: "",
        sourcePath: "NODE.md",
        title: "Context Tree",
        kind: "root",
        owners: [],
        parentId: null,
        preview: null,
        relatedNodeIds: [],
        affectedContextArea: "root",
        changeType: null,
        changedAtCommit: null,
      },
    ];
    const changes: ContextTreeChange[] = [
      {
        path: "old.md",
        nodeId: "removed:old.md",
        type: "removed",
        commit: "2222222222222222222222222222222222222222",
        changedAt: null,
        changedBy: null,
        summary: null,
        prNumber: null,
      },
    ];

    const withGhosts = contextTreeSnapshotTestInternals.addRemovedGhostNodes(nodes, changes);

    expect(withGhosts).toContainEqual(
      expect.objectContaining({
        id: "removed:old.md",
        parentId: "root",
        affectedContextArea: "old",
      }),
    );
  });

  it("resolves local roots and reports missing bindings", async () => {
    await mkdir(join(testDir, "local-tree"), { recursive: true });

    await expect(contextTreeSnapshotTestInternals.resolveContextTreeRoot(null, null, null)).resolves.toEqual({
      root: null,
      reason: "Context Tree is not configured.",
      staleReason: null,
      contentAvailability: { status: "unavailable", accessMode: null, reason: "not_configured" },
    });
    await expect(
      contextTreeSnapshotTestInternals.resolveContextTreeRoot(null, `file://${join(testDir, "local-tree")}`, null),
    ).resolves.toEqual({
      root: join(testDir, "local-tree"),
      reason: "ok",
      staleReason: null,
      contentAvailability: { status: "available", accessMode: "local" },
    });

    const missingLocal = join(testDir, "missing-local");
    await expect(contextTreeSnapshotTestInternals.resolveContextTreeRoot(null, missingLocal, null)).resolves.toEqual({
      root: null,
      reason: `Context Tree checkout not found at ${missingLocal}.`,
      staleReason: null,
      contentAvailability: { status: "unavailable", accessMode: "local", reason: "sync_failed" },
    });

    await expect(
      contextTreeSnapshotTestInternals.resolveContextTreeRoot(join(testDir, "local-tree"), null, null),
    ).resolves.toEqual({
      root: join(testDir, "local-tree"),
      reason: "ok",
      staleReason: null,
      contentAvailability: { status: "available", accessMode: "local" },
    });

    const missingRepoPath = join(process.cwd(), "not a repo url");
    await expect(
      contextTreeSnapshotTestInternals.resolveContextTreeRoot("not a repo url", null, null),
    ).resolves.toEqual({
      root: null,
      reason: `Context Tree checkout not found at ${missingRepoPath}.`,
      staleReason: null,
      contentAvailability: { status: "unavailable", accessMode: "local", reason: "sync_failed" },
    });
  });

  it("rejects each unsafe remote branch shape and defaults remote branches to main", async () => {
    for (const branch of ["bad..name", "bad@{name", "bad\\name"]) {
      await expect(
        contextTreeSnapshotTestInternals.resolveContextTreeRoot("https://github.com/example/tree", null, branch),
      ).resolves.toEqual({
        root: null,
        reason: `Configured Context Tree branch "${branch}" is invalid.`,
        staleReason: null,
        contentAvailability: { status: "unavailable", accessMode: "anonymous", reason: "invalid_binding" },
      });
    }

    const missingRemote = `file://${join(testDir, "missing-remote")}`;
    const resolved = await contextTreeSnapshotTestInternals.resolveContextTreeRoot(missingRemote, null, null);

    expect(resolved.root).toBeNull();
    expect(resolved.reason).toContain('branch "main"');
  });

  it("classifies GitHub remote bindings without treating local bindings as remote", () => {
    expect(isGithubRemoteBinding({ localPath: testDir, repo: "owner/repo" })).toBe(false);
    expect(isGithubRemoteBinding({ localPath: "  ", repo: "owner/repo" })).toBe(true);
    expect(isGithubRemoteBinding({})).toBe(false);
    expect(isGithubRemoteBinding({ repo: "owner/repo" })).toBe(true);
    expect(isGithubRemoteBinding({ repo: "owner/repo.git" })).toBe(true);
    expect(isGithubRemoteBinding({ repo: "https://github.com/owner/repo" })).toBe(true);
    expect(isGithubRemoteBinding({ repo: "file:///tmp/repo" })).toBe(false);
    expect(isGithubRemoteBinding({ repo: "https://example.test/owner/repo" })).toBe(false);
    expect(isGithubRemoteBinding({ repo: "not a repo url" })).toBe(false);
  });

  it("reports remote root sync failures through resolveContextTreeRoot", async () => {
    const missingRemote = `file://${join(testDir, "missing-remote")}`;

    const resolved = await contextTreeSnapshotTestInternals.resolveContextTreeRoot(missingRemote, null, "main");

    expect(resolved.root).toBeNull();
    expect(resolved.staleReason).toBeNull();
    expect(resolved.reason).toContain("First Tree could not sync the configured Context Tree repo.");
    expect(resolved.reason).toContain('branch "main"');
  });

  it("splits renames and keeps real commit metadata", async () => {
    await initRepo();
    await writeFile(join(testDir, "old.md"), "---\ntitle: Old\n---\nOld guidance\n");
    const baseCommit = await commitAll("docs: add old guidance");
    await git(testDir, ["mv", "old.md", "new.md"]);
    await writeFile(join(testDir, "new.md"), "---\ntitle: New\n---\nNew guidance\n");
    const renameCommit = await commitAll("docs: rename runtime guidance");

    const diff = await contextTreeSnapshotTestInternals.readDiffEntries(testDir, baseCommit, renameCommit);

    expect(diff.truncated).toBe(false);
    expect(diff.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "removed",
          path: "old.md",
          commit: renameCommit,
          changedBy: "Context Reviewer",
          summary: "rename runtime guidance",
        }),
        expect.objectContaining({
          type: "added",
          path: "new.md",
          commit: renameCommit,
          changedBy: "Context Reviewer",
          summary: "rename runtime guidance",
        }),
      ]),
    );
    expect(diff.entries).toHaveLength(2);
    expect(diff.entries.every((entry) => entry.changedAt !== null)).toBe(true);
  });

  it("splits git rename status entries into removed and added changes", async () => {
    await initRepo();
    await writeFile(join(testDir, "old.md"), "---\ntitle: Old\n---\nOld guidance\n");
    const baseCommit = await commitAll("docs: add old guidance");
    await git(testDir, ["mv", "old.md", "new.md"]);
    const renameCommit = await commitAll("docs: move old guidance");

    const diff = await contextTreeSnapshotTestInternals.readDiffEntries(testDir, baseCommit, renameCommit);

    expect(diff.entries.map((entry) => `${entry.type}:${entry.path}`)).toEqual(["removed:old.md", "added:new.md"]);
  });

  it("uses null summaries for terse commit subjects while preserving git metadata", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Tree\n---\nRoot\n");
    const baseCommit = await commitAll("docs: add root node");
    await writeFile(join(testDir, "new.md"), "---\ntitle: New\n---\nNew\n");
    const headCommit = await commitAll("x");

    const diff = await contextTreeSnapshotTestInternals.readDiffEntries(testDir, baseCommit, headCommit);

    expect(diff.entries).toEqual([
      expect.objectContaining({
        type: "added",
        path: "new.md",
        commit: headCommit,
        changedBy: "Context Reviewer",
        summary: null,
        prNumber: null,
      }),
    ]);
    expect(diff.entries[0]?.changedAt).not.toBeNull();
  });

  it("truncates long commit subjects in diff metadata", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Tree\n---\nRoot\n");
    const baseCommit = await commitAll("docs: add root node");
    await writeFile(join(testDir, "long.md"), "---\ntitle: Long\n---\nLong\n");
    const subject = `docs: ${"long summary ".repeat(20)}`;
    const headCommit = await commitAll(subject);

    const diff = await contextTreeSnapshotTestInternals.readDiffEntries(testDir, baseCommit, headCommit);

    expect(diff.entries[0]).toMatchObject({
      type: "added",
      path: "long.md",
      commit: headCommit,
    });
    expect(diff.entries[0]?.summary).toHaveLength(140);
    expect(diff.entries[0]?.summary?.endsWith("...")).toBe(true);
  });

  it("rejects unsafe comparison bases before invoking git diff", async () => {
    await initRepo();
    await writeFile(join(testDir, "node.md"), "---\ntitle: Node\n---\nGuidance\n");
    const headCommit = await commitAll("docs: add node");
    const payloadPath = join(testDir, "payload.diff");

    const diff = await contextTreeSnapshotTestInternals.readDiffEntries(testDir, `--output=${payloadPath}`, headCommit);

    expect(diff.entries).toEqual([]);
    expect(existsSync(payloadPath)).toBe(false);
    expect(existsSync(`${payloadPath}..HEAD`)).toBe(false);
  });

  it("returns an empty diff when git diff fails", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);

    await expect(contextTreeSnapshotTestInternals.readDiffEntries(testDir, safeBase, safeHead)).resolves.toEqual({
      entries: [],
      truncated: false,
    });
  });

  it("returns an empty diff when git reports no markdown changes", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root\n---\nRoot\n");
    const headCommit = await commitAll("docs: add root node");

    await expect(contextTreeSnapshotTestInternals.readDiffEntries(testDir, headCommit, headCommit)).resolves.toEqual({
      entries: [],
      truncated: false,
    });
  });

  it("materializes a remote repo into a managed checkout", async () => {
    const remoteDir = join(testDir, "remote-source");
    const cacheRoot = join(testDir, "managed-cache");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Remote Context\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");

    const materialized = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(
      remoteDir,
      "main",
      cacheRoot,
    );

    const { root: managedRoot } = materialized;
    expect(managedRoot.startsWith(cacheRoot)).toBe(true);
    expect(managedRoot).not.toBe(remoteDir);
    await expect(readFile(join(managedRoot, "NODE.md"), "utf8")).resolves.toContain("Remote Context");
  });

  it("reuses recent managed checkouts and waits on in-flight syncs", async () => {
    const remoteDir = join(testDir, "remote-source");
    const cacheRoot = join(testDir, "managed-cache");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Concurrent Context\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");
    const timings: string[] = [];

    const [first, second] = await Promise.all([
      contextTreeSnapshotTestInternals.materializeRemoteContextTree(remoteDir, "main", cacheRoot, null, (name) =>
        timings.push(name),
      ),
      contextTreeSnapshotTestInternals.materializeRemoteContextTree(remoteDir, "main", cacheRoot, null, (name) =>
        timings.push(name),
      ),
    ]);

    expect(second.root).toBe(first.root);
    expect(timings).toContain("remote_sync_wait_existing");

    const cached = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(
      remoteDir,
      "main",
      cacheRoot,
      null,
      (name) => timings.push(name),
    );
    expect(cached.root).toBe(first.root);
    expect(timings).toContain("remote_sync_skip_ttl");
  });

  it("refreshes an existing managed checkout when the remote branch advances", async () => {
    const remoteDir = join(testDir, "remote-source");
    const cacheRoot = join(testDir, "managed-cache");
    const repoUrl = `file://${remoteDir}`;
    const timings: string[] = [];
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Refreshable Context\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");

    const first = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(repoUrl, "main", cacheRoot);
    contextTreeSnapshotTestInternals.clearRemoteSyncState();
    await writeFile(join(remoteDir, "next.md"), "---\ntitle: Next\n---\nNext guidance\n");
    await commitAllAt(remoteDir, "docs: add next context");

    const second = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(
      repoUrl,
      "main",
      cacheRoot,
      null,
      (name) => timings.push(name),
    );

    expect(second.root).toBe(first.root);
    expect(timings).toContain("remote_fetch_checkout");
    await expect(readFile(join(second.root, "next.md"), "utf8")).resolves.toContain("Next guidance");
  });

  it("uses a full sha256 digest for managed checkout paths", () => {
    const managedPath = contextTreeSnapshotTestInternals.managedContextTreePath(
      "https://github.com/example/tree",
      "main",
      join(testDir, "managed-cache"),
    );
    const hash = managedPath.split("/").at(-1) ?? "";

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds unavailable snapshots for branch mismatches and invalid checkouts", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Local Context\n---\nGuidance\n");
    await commitAll("docs: add local context");

    const mismatch = await getContextTreeSnapshot({ localPath: testDir, branch: "feature" }, "7d");
    expect(mismatch.snapshotStatus).toBe("unavailable");
    expect(mismatch.branch).toBe("main");
    expect(mismatch.contextStatus.detail).toContain('configured Context Tree branch is "feature"');

    const notGitDir = await mkdtemp(join(tmpdir(), "context-tree-not-git-"));
    try {
      const invalid = await getContextTreeSnapshot({ localPath: notGitDir }, "7d");
      expect(invalid.snapshotStatus).toBe("unavailable");
      expect(invalid.contextStatus.detail).toMatch(/not a git repository|not a git repo|fatal/i);
    } finally {
      await rm(notGitDir, { recursive: true, force: true });
    }
  });

  it("serves cached snapshots with a refreshed syncedAt timestamp", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Cached Context\n---\nGuidance\n");
    await commitAll("docs: add cached context");
    const timings: Array<{ name: string; hit?: boolean }> = [];
    const recordTiming = (name: string, _duration: number, metadata?: Record<string, unknown>): void => {
      timings.push({ name, hit: typeof metadata?.hit === "boolean" ? metadata.hit : undefined });
    };

    const first = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d", {
      timing: recordTiming,
    });
    const second = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d", {
      timing: recordTiming,
    });

    expect(first.snapshotStatus).toBe("active");
    expect(second.snapshotStatus).toBe("active");
    expect(second.headCommit).toBe(first.headCommit);
    expect(second.nodes).toEqual(first.nodes);
    expect(timings).toEqual(expect.arrayContaining([{ name: "snapshot_cache_lookup", hit: true }]));
  });

  it("builds a snapshot from an organization remote repo binding", async () => {
    const remoteDir = join(testDir, "remote-source");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Remote Context\nowners: [alice]\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");
    const timings: string[] = [];

    const snapshot = await getContextTreeSnapshot({ repo: `file://${remoteDir}`, branch: "main" }, "7d", {
      timing: (name) => timings.push(name),
    });

    expect(snapshot.snapshotStatus).toBe("active");
    expect(snapshot.repo).toBe(`file://${remoteDir}`);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Remote Context",
          owners: ["alice"],
        }),
      ]),
    );
    expect(timings).toEqual(
      expect.arrayContaining(["resolve_root", "git_head", "comparison_base", "read_markdown_files", "build_tree"]),
    );
  });

  it("rejects unsafe branch names before remote sync", async () => {
    const snapshot = await getContextTreeSnapshot(
      { repo: "https://github.com/example/tree", branch: "--upload-pack=evil" },
      "7d",
    );

    expect(snapshot.snapshotStatus).toBe("unavailable");
    expect(snapshot.contextStatus.detail).toContain("branch");
    expect(snapshot.contextStatus.detail).toContain("invalid");
  });

  it("summarizes added, edited, and removed nodes inside the requested window", async () => {
    await initRepo();
    await mkdir(join(testDir, "system"), { recursive: true });
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nRoot\n");
    await writeFile(join(testDir, "system", "NODE.md"), "---\ntitle: System\nowners: [alice]\n---\nSystem guidance\n");
    await writeFile(join(testDir, "system", "old.md"), "---\ntitle: Old Decision\n---\nOld\n");
    await writeFile(join(testDir, "system", "edit.md"), "---\ntitle: Edit Decision\n---\nEdit\n");
    await commitAllAtDate(testDir, "docs: initial context", "2026-01-01T00:00:00Z");

    await writeFile(
      join(testDir, "system", "NODE.md"),
      "---\ntitle: System\nowners: [alice]\n---\nUpdated system guidance\n",
    );
    await writeFile(join(testDir, "system", "new.md"), "---\ntitle: New Decision\n---\nNew\n");
    await rm(join(testDir, "system", "old.md"));
    await commitAll("docs: update system context (#777)");

    const snapshot = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d");

    expect(snapshot.summary).toEqual({
      addedCount: 1,
      editedCount: 1,
      removedCount: 1,
      changedNodeCount: 3,
    });
    expect(snapshot.updates.map((update) => `${update.changeType}:${update.path}`)).toEqual([
      "removed:system/old",
      "added:system/new",
      "edited:system",
    ]);
    expect(snapshot.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          changeType: "removed",
          title: "Old",
          summary: "update system context (#777)",
          reason: "Agents should stop using the old team knowledge for system / old.",
          riskLevel: "high",
        }),
        expect.objectContaining({
          changeType: "added",
          title: "New Decision",
          reason: "Agents can use new team knowledge when working on system / new.",
          riskLevel: "low",
        }),
        expect.objectContaining({
          changeType: "edited",
          title: "System",
          owners: ["alice"],
          relatedNodeIds: [],
          reason: "Agents can use updated team knowledge when working on system.",
          riskLevel: "medium",
        }),
      ]),
    );
    expect(snapshot.io.writes.map((event) => event.prNumber)).toEqual([777, 777, 777]);
  });

  it("marks active snapshots with attention when the diff is truncated", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nRoot\n");
    await commitAllAtDate(testDir, "docs: initial context", "2026-01-01T00:00:00Z");
    for (let index = 0; index < 205; index += 1) {
      await writeFile(join(testDir, `bulk-${index}.md`), `---\ntitle: Bulk ${index}\n---\nBody ${index}\n`);
    }
    await commitAll("docs: add bulk context");

    const snapshot = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d");

    expect(snapshot.snapshotStatus).toBe("active");
    expect(snapshot.contextStatus).toMatchObject({
      label: "Context Tree needs attention",
      severity: "warning",
    });
    expect(snapshot.contextStatus.detail).toContain("Showing the first 200 changed files.");
    expect(snapshot.changes).toHaveLength(200);
  });

  it("keeps stale remote snapshots available and combines stale plus truncated warnings", async () => {
    const remoteDir = join(testDir, "remote-source");
    const repoUrl = `file://${remoteDir}`;
    const previousFirstTreeHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = join(testDir, "home");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Stale Bulk Context\n---\nRoot\n");
    await commitAllAtDate(remoteDir, "docs: initial context", "2026-01-01T00:00:00Z");
    for (let index = 0; index < 205; index += 1) {
      await writeFile(join(remoteDir, `remote-bulk-${index}.md`), `---\ntitle: Remote Bulk ${index}\n---\nBody\n`);
    }
    await commitAllAt(remoteDir, "docs: add remote bulk context");
    try {
      await contextTreeSnapshotTestInternals.materializeRemoteContextTree(repoUrl, "main");
      contextTreeSnapshotTestInternals.clearRemoteSyncState();
      await rm(remoteDir, { recursive: true, force: true });

      const snapshot = await getContextTreeSnapshot({ repo: repoUrl, branch: "main" }, "7d");

      expect(snapshot.snapshotStatus).toBe("stale");
      expect(snapshot.contextStatus).toMatchObject({
        label: "Context Tree may be stale",
        severity: "warning",
      });
      expect(snapshot.contextStatus.detail).toContain("could not refresh the configured repo");
      expect(snapshot.contextStatus.detail).toContain("Showing the first 200 changed files.");
      expect(snapshot.changes).toHaveLength(200);
    } finally {
      if (previousFirstTreeHome === undefined) {
        delete process.env.FIRST_TREE_HOME;
      } else {
        process.env.FIRST_TREE_HOME = previousFirstTreeHome;
      }
    }
  });

  it("uses default update summaries for terse added and removed commits", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nRoot\n");
    await writeFile(join(testDir, "old.md"), "---\ntitle: Old\n---\nOld\n");
    await commitAllAtDate(testDir, "docs: initial context", "2026-01-01T00:00:00Z");
    await rm(join(testDir, "old.md"));
    await writeFile(join(testDir, "new.md"), "---\ntitle: New\n---\nNew\n");
    await commitAll("x");

    const snapshot = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d");

    expect(snapshot.updates.find((update) => update.changeType === "added")).toMatchObject({
      path: "new",
      summary: "added this team knowledge",
    });
    expect(snapshot.updates.find((update) => update.changeType === "removed")).toMatchObject({
      path: "old",
      summary: "removed this team knowledge",
    });
  });

  it("uses an existing managed checkout when remote refresh fails", async () => {
    const remoteDir = join(testDir, "remote-source");
    const cacheRoot = join(testDir, "managed-cache");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Stale Context\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");

    const first = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(remoteDir, "main", cacheRoot);
    contextTreeSnapshotTestInternals.clearRemoteSyncState();
    await rm(remoteDir, { recursive: true, force: true });

    const second = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(remoteDir, "main", cacheRoot);

    expect(second.root).toBe(first.root);
    expect(second.staleReason).toContain("Showing the last synced Context Tree snapshot");
    await expect(readFile(join(second.root, "NODE.md"), "utf8")).resolves.toContain("Stale Context");

    const cached = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(remoteDir, "main", cacheRoot);
    expect(cached.staleReason).toBe(second.staleReason);
  });

  it("records stale remote timing and recovers a stale cached snapshot after refresh succeeds", async () => {
    const remoteDir = join(testDir, "remote-source");
    const movedRemoteDir = join(testDir, "remote-source-moved");
    const repoUrl = `file://${remoteDir}`;
    const previousFirstTreeHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = join(testDir, "home");
    const timings: string[] = [];
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Recoverable Context\n---\nRoot\n");
    await commitAllAtDate(remoteDir, "docs: initial context", "2026-01-01T00:00:00Z");
    await writeFile(join(remoteDir, "next.md"), "---\ntitle: Next\n---\nNext\n");
    await commitAllAt(remoteDir, "docs: add next context");

    try {
      const active = await getContextTreeSnapshot({ repo: repoUrl, branch: "main" }, "7d");
      expect(active.snapshotStatus).toBe("active");

      contextTreeSnapshotTestInternals.clearRemoteSyncState();
      await rename(remoteDir, movedRemoteDir);
      const stale = await getContextTreeSnapshot({ repo: repoUrl, branch: "main" }, "7d", {
        timing: (name) => timings.push(name),
      });
      expect(stale.snapshotStatus).toBe("stale");
      expect(timings).toContain("remote_sync_stale_fallback");

      contextTreeSnapshotTestInternals.clearRemoteSyncState();
      await rename(movedRemoteDir, remoteDir);
      const recovered = await getContextTreeSnapshot({ repo: repoUrl, branch: "main" }, "7d");
      expect(recovered.snapshotStatus).toBe("active");
      expect(recovered.contextStatus.label).toBe("Context Tree is up to date");
    } finally {
      if (existsSync(movedRemoteDir)) {
        await rename(movedRemoteDir, remoteDir).catch(() => undefined);
      }
      if (previousFirstTreeHome === undefined) {
        delete process.env.FIRST_TREE_HOME;
      } else {
        process.env.FIRST_TREE_HOME = previousFirstTreeHome;
      }
    }
  });

  it("caches first-clone failures briefly to avoid repeated clone attempts", async () => {
    const missingRemote = join(testDir, "missing-remote");
    const cacheRoot = join(testDir, "managed-cache");

    await expect(
      contextTreeSnapshotTestInternals.materializeRemoteContextTree(missingRemote, "main", cacheRoot),
    ).rejects.toThrow();
    await expect(
      contextTreeSnapshotTestInternals.materializeRemoteContextTree(missingRemote, "main", cacheRoot),
    ).rejects.toThrow("Previous Context Tree sync failed recently.");
  });

  it("cleans an incomplete managed checkout before retrying first clone", async () => {
    const remoteDir = join(testDir, "remote-source");
    const cacheRoot = join(testDir, "managed-cache");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Clean Retry\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");
    const managedRoot = contextTreeSnapshotTestInternals.managedContextTreePath(remoteDir, "main", cacheRoot);
    await mkdir(managedRoot, { recursive: true });
    await writeFile(join(managedRoot, "partial-clone-leftover"), "stale");

    const materialized = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(
      remoteDir,
      "main",
      cacheRoot,
    );

    expect(materialized.root).toBe(managedRoot);
    expect(existsSync(join(managedRoot, "partial-clone-leftover"))).toBe(false);
    await expect(readFile(join(managedRoot, "NODE.md"), "utf8")).resolves.toContain("Clean Retry");
  });

  it("wires GitHub token auth through askpass without putting the token in git args", async () => {
    const cacheRoot = join(testDir, "managed-cache");

    const env = await contextTreeSnapshotTestInternals.gitAuthEnv(
      "https://github.com/agent-team-foundation/first-tree-context",
      cacheRoot,
      "ghp_secret",
    );

    expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env?.GIT_USERNAME).toBe("x-access-token");
    expect(env?.GIT_PASSWORD).toBe("ghp_secret");
    expect(env?.GIT_ASKPASS).toBeDefined();
    expect(env?.GIT_ASKPASS).toContain(join("managed-cache", ".tools", "git-askpass.sh"));
    const askpass = await readFile(env?.GIT_ASKPASS ?? "", "utf8");
    expect(askpass).not.toContain("ghp_secret");

    await expect(
      contextTreeSnapshotTestInternals.gitAuthEnv(
        "https://github.com/agent-team-foundation/first-tree-context",
        cacheRoot,
        "ghp_secret",
      ),
    ).resolves.toMatchObject({
      GIT_ASKPASS: env?.GIT_ASKPASS,
    });
    await expect(
      contextTreeSnapshotTestInternals.gitAuthEnv(
        "https://example.test/agent-team-foundation/first-tree-context",
        cacheRoot,
        "ghp_secret",
      ),
    ).resolves.toBeUndefined();
    await expect(
      contextTreeSnapshotTestInternals.gitAuthEnv(
        "https://github.com/agent-team-foundation/first-tree-context",
        cacheRoot,
        null,
      ),
    ).resolves.toBeUndefined();
  });

  it("redacts URL-embedded credentials from surfaced git errors", () => {
    expect(
      contextTreeSnapshotTestInternals.redactSecret(
        "fatal: could not read from https://user:secret@github.com/example/private.git",
      ),
    ).toBe("fatal: could not read from https://[redacted]@github.com/example/private.git");
    for (const prefix of ["ghp", "ghs", "ghu", "gho", "ghr"] as const) {
      expect(contextTreeSnapshotTestInternals.redactSecret(`fatal: token ${prefix}_secret123 failed`)).toBe(
        "fatal: token [redacted] failed",
      );
    }
    expect(contextTreeSnapshotTestInternals.redactSecret("fatal: token github_pat_secret123 failed")).toBe(
      "fatal: token [redacted] failed",
    );
  });

  it("parses the trailing PR number from a merge commit subject", () => {
    const { parsePrNumber } = contextTreeSnapshotTestInternals;
    expect(parsePrNumber("feat: record team deletion semantics (#514)")).toBe(514);
    // GitHub "Create a merge commit" style subject.
    expect(parsePrNumber("Merge pull request #514 from gandy/tenancy")).toBe(514);
    // A subject referencing several PRs takes the last `(#N)` — the merge ref.
    expect(parsePrNumber("revert: undo (#12), reapplied via (#999)")).toBe(999);
    expect(parsePrNumber("docs: no pull request reference here")).toBeNull();
    expect(parsePrNumber("docs: impossible PR reference (#0)")).toBeNull();
    // A bare `#123` (not parenthesized) is an issue mention, not the PR ref.
    expect(parsePrNumber("fix: mentions #123 inline")).toBeNull();
    expect(parsePrNumber(null)).toBeNull();
  });

  it("derives git write rows: PR/risk mapped, agent attribution left null, newest first", () => {
    const node: ContextTreeNode = {
      id: "file:system/x.md",
      path: "system/x",
      sourcePath: "system/x.md",
      title: "X Decision",
      kind: "leaf",
      owners: [],
      parentId: "dir:system",
      preview: null,
      relatedNodeIds: [],
      affectedContextArea: "system",
      changeType: null,
      changedAtCommit: null,
    };
    const changes: ContextTreeChange[] = [
      {
        path: "system/x.md",
        nodeId: "file:system/x.md",
        type: "edited",
        commit: "a".repeat(40),
        changedAt: "2026-06-15T09:00:00.000Z",
        changedBy: "gandy-coder",
        summary: "record team deletion semantics",
        prNumber: 514,
      },
      {
        path: "system/gone.md",
        nodeId: "removed:system/gone.md",
        type: "removed",
        commit: "b".repeat(40),
        changedAt: "2026-06-15T11:00:00.000Z",
        changedBy: "alice",
        summary: null,
        prNumber: null,
      },
    ];

    const events = contextTreeSnapshotTestInternals.buildWriteEvents(changes, [node]);

    // Sorted newest-first by commit time.
    expect(events.map((e) => e.nodePath)).toEqual(["system/gone", "system/x"]);

    const write = events.find((e) => e.prNumber === 514);
    expect(write).toMatchObject({
      nodePath: "system/x",
      title: "X Decision",
      changeType: "edited",
      summary: "record team deletion semantics",
      riskLevel: "low",
      authorName: "gandy-coder",
      commit: "a".repeat(40),
      prNumber: 514,
      // Git alone cannot say which agent — attribution is reconciled later.
      agentId: null,
      agentName: null,
      agentAvatarColorToken: null,
    });

    const removed = events.find((e) => e.changeType === "removed");
    expect(removed?.riskLevel).toBe("high");
    expect(removed?.authorName).toBe("alice");
  });

  it("derives git write rows for uncommitted and invalid timestamps", () => {
    const changes = [
      {
        path: "loose-note.md",
        nodeId: null,
        type: "edited",
        commit: null,
        changedAt: "not-a-date",
        changedBy: null,
        summary: null,
        prNumber: null,
      },
      {
        path: "new-note.md",
        nodeId: null,
        type: "added",
        commit: "c".repeat(40),
        changedAt: null,
        changedBy: null,
        summary: "new note",
        prNumber: 12,
      },
    ] as unknown as ContextTreeChange[];

    const events = contextTreeSnapshotTestInternals.buildWriteEvents(changes, []);

    expect(events).toEqual([
      expect.objectContaining({
        id: "uncommitted:loose-note.md",
        nodePath: "loose-note",
        title: "Loose Note",
        riskLevel: "low",
        createdAt: "not-a-date",
      }),
      expect.objectContaining({
        id: `${"c".repeat(40)}:new-note.md`,
        title: "New Note",
        createdAt: null,
      }),
    ]);
  });

  it("skips oversized markdown files while building a snapshot", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nRoot\n");
    await writeFile(join(testDir, "huge.md"), `${"x".repeat(512 * 1024 + 1)}\n`);
    await commitAll("docs: add root and huge file");

    const snapshot = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d");

    expect(snapshot.nodes.map((node) => node.sourcePath)).not.toContain("huge.md");
  });

  it("summarizes edits to oversized markdown with missing tree node fallbacks", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nRoot\n");
    await writeFile(join(testDir, "huge.md"), `${"x".repeat(512 * 1024 + 1)}\n`);
    await commitAllAtDate(testDir, "docs: initial huge context", "2026-01-01T00:00:00Z");
    await writeFile(join(testDir, "huge.md"), `${"y".repeat(512 * 1024 + 1)}\n`);
    await commitAll("docs: update huge context");

    const snapshot = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d");

    expect(snapshot.updates).toContainEqual(
      expect.objectContaining({
        changeType: "edited",
        path: "huge",
        title: "Huge",
        summary: "update huge context",
      }),
    );
  });

  it("rebuilds a stale cached snapshot after remote refresh succeeds", async () => {
    const remoteDir = join(testDir, "remote-source");
    const movedRemoteDir = join(testDir, "remote-source-moved");
    const repoUrl = `file://${remoteDir}`;
    const previousFirstTreeHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = join(testDir, "home");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Recover Cached Context\n---\nRoot\n");
    await commitAllAtDate(remoteDir, "docs: initial context", "2026-01-01T00:00:00Z");

    let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      await contextTreeSnapshotTestInternals.materializeRemoteContextTree(repoUrl, "main");
      contextTreeSnapshotTestInternals.clearRemoteSyncState();
      await rename(remoteDir, movedRemoteDir);

      const nowValues = [0, 0, 100_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000];
      nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValues.shift() ?? 65_000);
      const stale = await getContextTreeSnapshot({ repo: repoUrl, branch: "main" }, "7d");
      expect(stale.snapshotStatus).toBe("stale");

      await rename(movedRemoteDir, remoteDir);
      const recovered = await getContextTreeSnapshot({ repo: repoUrl, branch: "main" }, "7d");

      expect(recovered.snapshotStatus).toBe("active");
      expect(recovered.contextStatus.label).toBe("Context Tree is up to date");
    } finally {
      nowSpy?.mockRestore();
      if (existsSync(movedRemoteDir)) {
        await rename(movedRemoteDir, remoteDir).catch(() => undefined);
      }
      if (previousFirstTreeHome === undefined) {
        delete process.env.FIRST_TREE_HOME;
      } else {
        process.env.FIRST_TREE_HOME = previousFirstTreeHome;
      }
    }
  });

  it("uses default edited summaries for terse commits with and without tree nodes", async () => {
    await initRepo();
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nRoot\n");
    await writeFile(join(testDir, "huge.md"), `${"x".repeat(512 * 1024 + 1)}\n`);
    await commitAllAtDate(testDir, "docs: initial context", "2026-01-01T00:00:00Z");
    await writeFile(join(testDir, "NODE.md"), "---\ntitle: Root Context\n---\nUpdated root\n");
    await writeFile(join(testDir, "huge.md"), `${"y".repeat(512 * 1024 + 1)}\n`);
    await commitAll("update");

    const snapshot = await getContextTreeSnapshot({ localPath: testDir, branch: "main" }, "7d");
    const rootUpdate = snapshot.updates.find((update) => update.title === "Root Context");
    const hugeUpdate = snapshot.updates.find((update) => update.path === "huge");

    expect(rootUpdate).toMatchObject({
      changeType: "edited",
      summary: "updated Root Context",
    });
    expect(hugeUpdate).toMatchObject({
      changeType: "edited",
      summary: "updated this team knowledge",
    });
  });
});
