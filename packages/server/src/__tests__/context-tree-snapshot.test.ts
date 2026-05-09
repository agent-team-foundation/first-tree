import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ContextTreeChange, ContextTreeNode } from "@agent-team-foundation/first-tree-hub-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextTreeSnapshotTestInternals } from "../services/context-tree-snapshot.js";

const execFileAsync = promisify(execFile);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "context-tree-snapshot-"));
});

afterEach(async () => {
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

  it("materializes a remote repo into a managed checkout", async () => {
    const remoteDir = join(testDir, "remote-source");
    const cacheRoot = join(testDir, "managed-cache");
    await initRepoAt(remoteDir);
    await writeFile(join(remoteDir, "NODE.md"), "---\ntitle: Remote Context\n---\nGuidance\n");
    await commitAllAt(remoteDir, "docs: add remote context");

    const managedRoot = await contextTreeSnapshotTestInternals.materializeRemoteContextTree(
      remoteDir,
      "main",
      cacheRoot,
    );

    expect(managedRoot.startsWith(cacheRoot)).toBe(true);
    expect(managedRoot).not.toBe(remoteDir);
    await expect(readFile(join(managedRoot, "NODE.md"), "utf8")).resolves.toContain("Remote Context");
  });
});
