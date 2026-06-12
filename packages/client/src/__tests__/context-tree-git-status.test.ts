import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContextTreeGitWriteTracker } from "../runtime/context-tree-git-status.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("createContextTreeGitWriteTracker", () => {
  let root: string;
  let tree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "first-tree-git-status-"));
    tree = join(root, "tree");
    mkdirSync(join(tree, "domains"), { recursive: true });
    git(root, "init", "tree");
    git(tree, "config", "user.email", "agent@example.com");
    git(tree, "config", "user.name", "Agent");
    writeFileSync(join(tree, "NODE.md"), "root\n");
    git(tree, "add", ".");
    git(tree, "commit", "-m", "initial");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits git status delta refs for newly dirty tree paths once", () => {
    const tracker = createContextTreeGitWriteTracker({
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    writeFileSync(join(tree, "NODE.md"), "updated\n");
    writeFileSync(join(tree, "domains", "new.md"), "new\n");

    const refs = tracker.refsForSuccessfulToolCall({
      toolName: "Bash",
      toolUseId: "tu-shell-write",
      existingRefs: [],
    });

    expect(refs).toEqual([
      {
        origin: "git_status_delta",
        localPath: join(tree, "NODE.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
        metadata: {
          gitStatus: " M",
          toolName: "Bash",
          toolUseId: "tu-shell-write",
        },
      },
      {
        origin: "git_status_delta",
        localPath: join(tree, "domains", "new.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "domains/new.md",
        pathKind: "file",
        metadata: {
          gitStatus: "??",
          toolName: "Bash",
          toolUseId: "tu-shell-write",
        },
      },
    ]);

    expect(
      tracker.refsForSuccessfulToolCall({
        toolName: "Bash",
        toolUseId: "tu-shell-write-again",
        existingRefs: [],
      }),
    ).toEqual([]);
  });

  it("does not reassign paths that are absorbed into the baseline after a failed tool", () => {
    const tracker = createContextTreeGitWriteTracker({
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    writeFileSync(join(tree, "NODE.md"), "failed write\n");
    tracker.captureBaseline();

    expect(
      tracker.refsForSuccessfulToolCall({
        toolName: "Bash",
        toolUseId: "tu-next-success",
        existingRefs: [],
      }),
    ).toEqual([]);
  });
});
