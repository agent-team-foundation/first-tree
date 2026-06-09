// Integration tests for the state-based cleanup wiring inside
// `prepareSourceRepos`. Helper-level coverage lives in
// `managed-state.test.ts`; this file proves the actual reconcile loop
// inside `prepareSourceRepos` correctly diffs prev-vs-current, applies the
// safety guards, and updates `.agent/managed.json`. The P0-2 regression
// (`payload: undefined` → mass-delete) and P1-3 (no integration coverage)
// from PR #869's code-reviewer feedback are guarded by the tests below.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitMirrorManager, SourceRepoOutcome } from "../runtime/git-mirror-manager.js";
import type { SessionContext } from "../runtime/handler.js";
import { readManagedState, writeManagedState } from "../runtime/managed-state.js";
import { prepareSourceRepos } from "../runtime/source-repos.js";

type EnsureArgs = Parameters<GitMirrorManager["ensureSourceRepo"]>[0];

function makeManager(): { manager: GitMirrorManager; calls: EnsureArgs[] } {
  const calls: EnsureArgs[] = [];
  const manager = {
    ensureSourceRepo: vi.fn(async (args: EnsureArgs) => {
      calls.push(args);
      // Ensure the target directory exists so the test can verify "still
      // present after reconcile". Skip when the test already pre-populated it.
      if (!existsSync(args.clonePath)) {
        mkdirSync(args.clonePath, { recursive: true });
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: args.clonePath });
      }
      return {
        clonePath: args.clonePath,
        headCommit: "deadbeef",
        branch: "main",
        outcome: "cloned" as SourceRepoOutcome,
      };
    }),
    removeSourceRepo: vi.fn(async () => {}),
    sweepLegacyMirrors: vi.fn(async () => ({ removed: [] })),
    legacyMirrorsRoot: "/tmp/legacy",
  } as unknown as GitMirrorManager;
  return { manager, calls };
}

function makeCtx(): SessionContext {
  return {
    chatId: `chat-${Math.random().toString(36).slice(2, 10)}`,
    log: vi.fn(),
    agent: { agentId: "agent-x" },
  } as unknown as SessionContext;
}

function payloadFor(localPaths: readonly string[]): AgentRuntimeConfigPayload {
  return {
    gitRepos: localPaths.map((localPath) => ({
      url: `git@github.com:example/${localPath}.git`,
      localPath,
    })),
  } as unknown as AgentRuntimeConfigPayload;
}

/**
 * Build a real `git init`'d clone at `<workspace>/<name>/`, useful for the
 * cleanup paths which probe HEAD / status / worktree-list. Commits a single
 * file by default so HEAD exists; `dirty` adds an extra untracked file the
 * dirty-guard should catch; `ahead` adds an upstream-less commit so the
 * ahead-of-upstream guard's "no tracking → skip" path triggers.
 */
function plantClone(workspace: string, name: string, opts?: { dirty?: boolean; withWorktreeRef?: string }): string {
  const target = join(workspace, name);
  mkdirSync(target, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: target });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: target });
  execFileSync("git", ["config", "user.name", "t"], { cwd: target });
  writeFileSync(join(target, "README.md"), "seed\n");
  execFileSync("git", ["add", "."], { cwd: target });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: target });
  // Connect a fake upstream so the ahead-of-upstream probe has a tracking
  // branch — important for the "clean, deletable" path. We can't fetch
  // (the URL is bogus) but `git rev-list @{u}..HEAD` just reads local refs.
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/seed.git"], { cwd: target });
  // Configure tracking: branch.main.remote=origin + branch.main.merge=refs/heads/main
  execFileSync("git", ["config", "branch.main.remote", "origin"], { cwd: target });
  execFileSync("git", ["config", "branch.main.merge", "refs/heads/main"], { cwd: target });
  // Make origin/main resolve to current HEAD so we're 0 commits ahead.
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf-8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", headSha], { cwd: target });

  if (opts?.dirty) {
    writeFileSync(join(target, "dirty.txt"), "uncommitted change\n");
  }
  if (opts?.withWorktreeRef) {
    // Adding a real worktree requires somewhere to put it. The cleanup
    // probe just counts `git worktree list --porcelain` blank-line records,
    // so a registered (even broken) worktree suffices.
    const linkedTarget = join(workspace, opts.withWorktreeRef);
    execFileSync("git", ["worktree", "add", "--detach", linkedTarget, "HEAD"], { cwd: target });
  }
  return target;
}

describe("prepareSourceRepos — state-based reconcile (PR #869 P1-3)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "state-reconcile-"));
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("prev=[A,B], current=[A] and B is clean → B is deleted, state is updated to [A]", async () => {
    plantClone(workspace, "repo-a");
    plantClone(workspace, "repo-b");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      sourceRepos: ["repo-a", "repo-b"],
      skills: [],
    });

    const { manager } = makeManager();
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });

    expect(existsSync(join(workspace, "repo-a"))).toBe(true);
    expect(existsSync(join(workspace, "repo-b"))).toBe(false);
    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a"]);
  });

  it("prev=[A,B], current=[A] but B is dirty → B is kept on disk AND retained in state for retry", async () => {
    plantClone(workspace, "repo-a");
    plantClone(workspace, "repo-b", { dirty: true });
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      sourceRepos: ["repo-a", "repo-b"],
      skills: [],
    });

    const { manager } = makeManager();
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });

    expect(existsSync(join(workspace, "repo-b"))).toBe(true);
    expect(existsSync(join(workspace, "repo-b", "dirty.txt"))).toBe(true);
    // Retry semantics: a guard-skipped delete stays in managed state so the
    // next session re-runs the probes. See `reconcileSourceRepoState`
    // docstring — the operator clearing the dirty state between sessions
    // is exactly the recovery path we want to remain open.
    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a", "repo-b"]);
  });

  it("prev=[A,B], current=[A] but B hosts a dependent worktree → B is kept on disk AND retained in state", async () => {
    plantClone(workspace, "repo-a");
    plantClone(workspace, "repo-b", { withWorktreeRef: "linked-wt" });
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      sourceRepos: ["repo-a", "repo-b"],
      skills: [],
    });

    const { manager } = makeManager();
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });

    expect(existsSync(join(workspace, "repo-b"))).toBe(true);
    // Retained for retry — once the operator removes the dependent worktree,
    // the next reconcile completes the delete.
    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a", "repo-b"]);
  });

  it("dirty B retained → next session, after operator cleans B, is finally removed and dropped from state", async () => {
    plantClone(workspace, "repo-a");
    const repoB = plantClone(workspace, "repo-b", { dirty: true });
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      sourceRepos: ["repo-a", "repo-b"],
      skills: [],
    });

    // Session 1: B dirty → skip + retain in state.
    const { manager } = makeManager();
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });
    expect(existsSync(repoB)).toBe(true);
    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a", "repo-b"]);

    // Operator cleans B between sessions.
    rmSync(join(repoB, "dirty.txt"));

    // Session 2: B is now clean → removed + dropped from state.
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });
    expect(existsSync(repoB)).toBe(false);
    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a"]);
  });

  it("prev=[A,B], payload=undefined (cache miss) → NOTHING is deleted (PR #869 P0-2 regression)", async () => {
    plantClone(workspace, "repo-a");
    plantClone(workspace, "repo-b");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      sourceRepos: ["repo-a", "repo-b"],
      skills: [],
    });
    const stateBefore = readFileSync(join(workspace, ".first-tree-workspace", "managed.json"), "utf-8");

    const { manager } = makeManager();
    await prepareSourceRepos({
      workspace,
      payload: undefined,
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: false,
    });

    // Both repos still present — `payloadResolved: false` gated reconcile.
    expect(existsSync(join(workspace, "repo-a"))).toBe(true);
    expect(existsSync(join(workspace, "repo-b"))).toBe(true);
    // State unchanged — no write happens when reconcile is suppressed.
    const stateAfter = readFileSync(join(workspace, ".first-tree-workspace", "managed.json"), "utf-8");
    expect(stateAfter).toBe(stateBefore);
  });

  it("first run (no managed.json) writes current set without trying to delete anything", async () => {
    plantClone(workspace, "repo-a");

    const { manager } = makeManager();
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: makeCtx(),
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });

    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a"]);
  });

  it("does NOT delete a clone another live chat in this process is still using (PR #869 code-reviewer R2 N-2)", async () => {
    plantClone(workspace, "repo-a");
    plantClone(workspace, "repo-b");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      sourceRepos: ["repo-a", "repo-b"],
      skills: [],
    });

    // Chat A acquires repo-b through a normal prepare call — both repos
    // are in its config so neither is touched, but the live-use registry
    // records chat A against both checkout paths.
    const { manager } = makeManager();
    const chatA = makeCtx();
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a", "repo-b"]),
      sessionCtx: chatA,
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });
    expect(existsSync(join(workspace, "repo-b"))).toBe(true);

    // Chat B starts with a new config that drops repo-b. Without the
    // `isPathInUse` check the reconcile path would `rm` repo-b out from
    // under chat A; the guard must catch this.
    const chatBLogs: string[] = [];
    const chatB = {
      ...makeCtx(),
      log: (msg: string) => chatBLogs.push(msg),
    } as unknown as SessionContext;
    await prepareSourceRepos({
      workspace,
      payload: payloadFor(["repo-a"]),
      sessionCtx: chatB,
      gitMirrorManager: manager,
      agentName: null,
      payloadResolved: true,
    });

    expect(existsSync(join(workspace, "repo-b"))).toBe(true);
    expect(chatBLogs.some((l) => l.toLowerCase().includes("in use by another live chat"))).toBe(true);
    // Retained for retry — when chat A teardown releases the live-use lock,
    // a later session can complete the delete.
    expect(readManagedState(workspace)?.sourceRepos).toEqual(["repo-a", "repo-b"]);
  });
});
