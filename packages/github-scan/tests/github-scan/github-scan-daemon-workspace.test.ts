import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceManager,
  sanitizeFilename,
  type GitRunner,
} from "../../src/github-scan/engine/daemon/workspace.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `github-scan-ws-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

describe("sanitizeFilename", () => {
  it("replaces unsafe chars with underscore", () => {
    expect(sanitizeFilename("owner/repo")).toBe("owner_repo");
    expect(sanitizeFilename("weird name!")).toBe("weird_name_");
    expect(sanitizeFilename("")).toBe("_");
  });
});

describe("WorkspaceManager.prepare", () => {
  function makeFakeRunner(): {
    runner: GitRunner;
    calls: string[][];
    rev: string;
  } {
    const calls: string[][] = [];
    const runner: GitRunner = async ({ args }) => {
      calls.push(args);
      // Handle `rev-parse HEAD`: return a fake SHA.
      if (args.includes("rev-parse") && args.includes("HEAD")) {
        return { stdout: "deadbeefcafe\n", stderr: "", statusCode: 0 };
      }
      return { stdout: "", stderr: "", statusCode: 0 };
    };
    return { runner, calls, rev: "deadbeefcafe" };
  }

  it("creates a worktree for a non-PR task via HEAD", async () => {
    const root = makeTempDir("nopr");
    const reposDir = join(root, "repos");
    const workspacesDir = join(root, "workspaces");
    const { runner, calls, rev } = makeFakeRunner();

    // Pre-create mirror dir so `ensureMirror` skips clone.
    const mirrorDir = join(reposDir, "owner__repo.git");
    mkdirSync(mirrorDir, { recursive: true });

    const mgr = new WorkspaceManager({
      reposDir,
      workspacesDir,
      identity: { host: "github.com", login: "bob" },
      runGit: runner,
    });

    const lease = await mgr.prepare({
      repo: "owner/repo",
      kind: "issue",
      stableId: "42",
    });

    expect(lease.mirrorDir).toBe(mirrorDir);
    expect(lease.workspaceDir).toBe(
      join(workspacesDir, "owner__repo", "issue-42"),
    );
    expect(lease.repoUrl).toBe("https://github.com/owner/repo.git");

    // Worktree add should have been invoked with the resolved SHA.
    const addCall = calls.find((c) => c.includes("worktree") && c.includes("add"));
    expect(addCall).toBeDefined();
    expect(addCall).toContain(rev);

    // Git identity seeded.
    expect(
      calls.some(
        (c) =>
          c.includes("config") &&
          c.includes("user.name") &&
          c.some((a) => a.includes("bob via github-scan-runner")),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.includes("user.email") &&
          c.some((a) => a.includes("bob@users.noreply.github.com")),
      ),
    ).toBe(true);
  });

  it("fetches PR head when prNumber is set", async () => {
    const root = makeTempDir("pr");
    const reposDir = join(root, "repos");
    const workspacesDir = join(root, "workspaces");
    const { runner, calls } = makeFakeRunner();
    mkdirSync(join(reposDir, "o__r.git"), { recursive: true });

    const mgr = new WorkspaceManager({
      reposDir,
      workspacesDir,
      identity: { host: "github.com", login: "alice" },
      runGit: runner,
    });

    const lease = await mgr.prepare({
      repo: "o/r",
      kind: "pr",
      stableId: "pr-267",
      prNumber: 267,
    });

    expect(lease.workspaceDir).toContain("pr-pr-267");

    // Should fetch refs/pull/267/head:...github-scan-runner-pr-267.
    const fetchCall = calls.find(
      (c) => c.includes("fetch") && c.some((a) => a.includes("refs/pull/267/head")),
    );
    expect(fetchCall).toBeDefined();
    const addCall = calls.find((c) => c.includes("worktree") && c.includes("add"));
    expect(addCall).toContain(
      "refs/remotes/origin/github-scan-runner-pr-267",
    );
  });

  it("throws when a checked git command fails", async () => {
    const root = makeTempDir("fail");
    const reposDir = join(root, "repos");
    mkdirSync(join(reposDir, "o__r.git"), { recursive: true });
    const runner: GitRunner = async ({ args }) => {
      if (args.includes("rev-parse")) {
        return { stdout: "", stderr: "bad head", statusCode: 128 };
      }
      return { stdout: "", stderr: "", statusCode: 0 };
    };
    const mgr = new WorkspaceManager({
      reposDir,
      workspacesDir: join(root, "workspaces"),
      identity: { host: "github.com", login: "alice" },
      runGit: runner,
    });
    await expect(
      mgr.prepare({ repo: "o/r", kind: "issue", stableId: "1" }),
    ).rejects.toThrow(/resolve mirror HEAD/);
  });

  it("serializes prepare calls that target the same repo mirror", async () => {
    const root = makeTempDir("serial");
    const reposDir = join(root, "repos");
    const workspacesDir = join(root, "workspaces");
    mkdirSync(join(reposDir, "o__r.git"), { recursive: true });

    let active = 0;
    let maxActive = 0;
    const runner: GitRunner = async ({ args }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (args.includes("rev-parse")) {
        return { stdout: "deadbeef\n", stderr: "", statusCode: 0 };
      }
      return { stdout: "", stderr: "", statusCode: 0 };
    };

    const mgr = new WorkspaceManager({
      reposDir,
      workspacesDir,
      identity: { host: "github.com", login: "alice" },
      runGit: runner,
    });

    await Promise.all([
      mgr.prepare({ repo: "o/r", kind: "issue", stableId: "1" }),
      mgr.prepare({ repo: "o/r", kind: "issue", stableId: "2" }),
    ]);

    expect(maxActive).toBe(1);
  });
});
