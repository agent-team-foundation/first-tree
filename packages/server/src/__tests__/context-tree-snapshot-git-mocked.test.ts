import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const RECORD_SEPARATOR = "\x1e";

type GitHandler = (args: string[]) => string | Error | unknown;

async function loadSnapshotServiceWithGit(handler: GitHandler) {
  vi.resetModules();
  const execFile = vi.fn((command: string, args: string[], options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb !== "function") return;
    if (command !== "git") {
      cb(new Error(`unexpected command ${command}`));
      return;
    }
    const result = handler(args);
    if (result instanceof Error || typeof result !== "string") {
      cb(result);
      return;
    }
    cb(null, { stdout: result, stderr: "" });
  });
  vi.doMock("node:child_process", () => ({ execFile }));
  const service = await import("../services/context-tree-snapshot.js");
  return { execFile, service };
}

describe("Context Tree snapshot service with mocked git", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("parses unusual git diff and log records through defensive fallbacks", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);
    const metadataCommit = "c".repeat(40);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") {
        return [
          "\t",
          "R100\told.md\tnew.md",
          "R100\told-only.md",
          "R100\t\tnew-only.md",
          "A\t",
          "M\tmodified.md",
          "D\tdeleted.md",
          "X\tignored.md",
        ].join("\n");
      }
      if (args[0] === "log") {
        return [
          `${RECORD_SEPARATOR}${metadataCommit}\x00\x00\x00Merge pull request #12 from acme/context\nmodified.md`,
          `${RECORD_SEPARATOR}not-a-safe-commit\x002026-01-01T00:00:00.000Z\x00bot\x00docs: invalid\nignored.md`,
          `${RECORD_SEPARATOR}${"d".repeat(40)}\x002026-01-02T00:00:00.000Z\x00bot\x00docs: header only`,
        ].join("");
      }
      return "";
    });

    const diff = await service.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead);

    expect(diff.truncated).toBe(true);
    expect(diff.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "removed", path: "old.md", commit: safeHead }),
        expect.objectContaining({ type: "added", path: "new.md", commit: safeHead }),
        expect.objectContaining({ type: "removed", path: "old-only.md", commit: safeHead }),
        expect.objectContaining({ type: "removed", path: "new-only.md", commit: safeHead }),
        expect.objectContaining({
          type: "edited",
          path: "modified.md",
          commit: metadataCommit,
          changedAt: null,
          changedBy: null,
          summary: "Merge pull request #12 from acme/context",
          prNumber: 12,
        }),
        expect.objectContaining({ type: "removed", path: "deleted.md", commit: safeHead }),
      ]),
    );
    expect(diff.entries.some((entry) => entry.path === "ignored.md")).toBe(false);
  });

  it("uses fallback diff metadata when git log has empty records", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") return "A\tnew.md";
      if (args[0] === "log") return "";
      return "";
    });

    const diff = await service.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead);

    expect(diff.entries).toEqual([
      expect.objectContaining({
        type: "added",
        path: "new.md",
        commit: safeHead,
        changedAt: null,
        changedBy: null,
        summary: null,
        prNumber: null,
      }),
    ]);
  });

  it("handles empty diff path sets and missing git log subject fields", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);
    const metadataCommit = "c".repeat(40);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") return "A\t";
      if (args[0] === "log") return `${RECORD_SEPARATOR}${metadataCommit}\x002026-01-01T00:00:00.000Z\x00bot\nnew.md`;
      return "";
    });

    await expect(service.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead)).resolves.toEqual({
      entries: [],
      truncated: true,
    });

    const { service: serviceWithPath } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") return "A\tnew.md";
      if (args[0] === "log") return `${RECORD_SEPARATOR}${metadataCommit}\x002026-01-01T00:00:00.000Z\x00bot\nnew.md`;
      return "";
    });
    const diff = await serviceWithPath.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead);
    expect(diff.entries[0]).toMatchObject({
      path: "new.md",
      commit: metadataCommit,
      summary: null,
      prNumber: null,
    });
  });

  it("caches non-Error remote sync failures without leaking an error message", async () => {
    const cacheRoot = join(tmpdir(), `context-tree-mocked-failure-${crypto.randomUUID()}`);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args.includes("clone")) return { reason: "clone failed as object" };
      return "";
    });

    try {
      await expect(
        service.contextTreeSnapshotTestInternals.materializeRemoteContextTree(
          "https://github.com/acme/context-tree",
          "main",
          cacheRoot,
        ),
      ).rejects.toEqual({ reason: "clone failed as object" });
      await expect(
        service.contextTreeSnapshotTestInternals.materializeRemoteContextTree(
          "https://github.com/acme/context-tree",
          "main",
          cacheRoot,
        ),
      ).rejects.toThrow("Previous Context Tree sync failed recently.");
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("uses fallback snapshot status when mocked git has no branch and no recent diff", async () => {
    const root = join(tmpdir(), `context-tree-mocked-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "NODE.md"), "---\ntitle: Mocked\n---\nBody\n");
    const head = "e".repeat(40);
    const timings: Array<{ name: string; hit?: boolean }> = [];
    try {
      const { service } = await loadSnapshotServiceWithGit((args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return new Error("branch unavailable");
        if (args[0] === "rev-list") return "";
        if (args[0] === "diff") return "";
        return "";
      });

      const snapshot = await service.getContextTreeSnapshot({ localPath: root }, "7d", {
        timing: (name, _ms, fields) =>
          timings.push({ name, hit: typeof fields?.hit === "boolean" ? fields.hit : undefined }),
      });

      expect(snapshot.snapshotStatus).toBe("active");
      expect(snapshot.branch).toBeNull();
      expect(snapshot.headCommit).toBe(head);
      expect(snapshot.contextStatus.label).toBe("Context Tree is up to date");
      expect(timings).toEqual(expect.arrayContaining([{ name: "snapshot_cache_lookup", hit: false }]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces the generic unavailable snapshot message for non-Error git failures", async () => {
    const root = join(tmpdir(), `context-tree-mocked-error-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const { service } = await loadSnapshotServiceWithGit((args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { reason: "git exploded" };
        return "";
      });

      const snapshot = await service.getContextTreeSnapshot({ localPath: root }, "7d");

      expect(snapshot.snapshotStatus).toBe("unavailable");
      expect(snapshot.contextStatus.detail).toBe("Unable to read Context Tree snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
