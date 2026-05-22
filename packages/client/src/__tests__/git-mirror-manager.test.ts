import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeRepoUrl,
  createGitMirrorManager,
  deriveSessionBranchName,
  GitMirrorAuthError,
  GitMirrorError,
  type GitMirrorManager,
  GitMirrorWorktreeConflictError,
  hashUrl,
  httpsToSshBaseRewrite,
  isLikelyHttpsAuthFailure,
  isLikelySshAuthFailure,
  sshToHttpsBaseRewrite,
} from "../runtime/git-mirror-manager.js";

let workRoot: string;
let fixtureRepo: string;
let fixtureUrl: string;
let initialMainSha: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "ftt-mirror-"));
  fixtureRepo = join(workRoot, "fixture-bare.git");
  const seed = join(workRoot, "fixture-seed");
  mkdirSync(seed, { recursive: true });
  execSync("git init -q -b main", { cwd: seed });
  execSync("git config user.email test@example.com && git config user.name test", { cwd: seed });
  writeFileSync(join(seed, "README.md"), "hello");
  execSync("git add . && git commit -q -m initial", { cwd: seed });
  writeFileSync(join(seed, "README.md"), "hello v2");
  execSync("git add . && git commit -q -m second", { cwd: seed });
  execSync(`git clone -q --bare ${seed} ${fixtureRepo}`);
  fixtureUrl = fixtureRepo;
  initialMainSha = execSync("git rev-parse main", { cwd: fixtureRepo }).toString().trim();
});

afterAll(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

function makeManager(): GitMirrorManager {
  return createGitMirrorManager({
    dataDir: mkdtempSync(join(tmpdir(), "ftt-mgr-")),
    cloneTimeoutMs: 30_000,
  });
}

function gitIn(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd }).toString().trim();
}

/**
 * Spawn a detached, long-lived child whose cwd is `dir`. Used by the orphan-
 * cleanup tests to model a vite/esbuild process still holding the worktree
 * after its parent session died. The caller MUST clean the pid up in a
 * `finally` block — vitest will otherwise hang at process exit waiting for it.
 *
 * Uses `node` (always on PATH where the suite runs) over `sleep` because
 * `sleep` is signalled instantly on SIGTERM whereas a node script keeps the
 * promise-based wait honest (and a future test could swap in a custom signal
 * handler if it needs to model a misbehaving holder).
 */
async function spawnLongLivedChildInDir(dir: string): Promise<{ pid: number; proc: ChildProcess }> {
  const proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  if (proc.pid === undefined) {
    throw new Error("failed to spawn long-lived test child");
  }
  // Wait briefly so lsof sees the cwd before the test calls into the manager.
  await new Promise((r) => setTimeout(r, 50));
  return { pid: proc.pid, proc };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Any other error (e.g. EPERM) implies the pid exists but we can't signal
    // — count as alive to avoid false-negative assertions.
    return true;
  }
}

function tryGitIn(cwd: string, args: string): { ok: boolean; stdout: string } {
  try {
    return {
      ok: true,
      stdout: execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .trim(),
    };
  } catch (err) {
    return { ok: false, stdout: (err as { stdout?: Buffer }).stdout?.toString() ?? "" };
  }
}

describe("GitMirrorManager — lifecycle", () => {
  it("ensureMirror bootstraps once and is idempotent", async () => {
    const m = makeManager();
    const first = await m.ensureMirror(fixtureUrl);
    expect(first.cloned).toBe(true);
    expect(existsSync(join(first.mirrorPath, "HEAD"))).toBe(true);

    const second = await m.ensureMirror(fixtureUrl);
    expect(second.cloned).toBe(false);
    expect(second.mirrorPath).toBe(first.mirrorPath);
  });

  it("ensureMirror configures the mirror with remote-tracking fetch refspec (no mirror flag)", async () => {
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    expect(gitIn(mirrorPath, "config --get remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(tryGitIn(mirrorPath, "config --get remote.origin.mirror").ok).toBe(false);
    expect(gitIn(mirrorPath, "config --get remote.origin.url")).toBe(fixtureUrl);
  });

  it("createWorktree creates a session branch, attached (not detached)", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "wt-attached");
    const { worktreePath, headCommit, branchName } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "chat-1",
      agentName: "agent-x",
    });
    expect(worktreePath).toBe(target);
    expect(headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(branchName).toBe(deriveSessionBranchName("chat-1", "agent-x", fixtureUrl));
    // HEAD should be a symbolic ref to the session branch (not detached).
    expect(gitIn(target, "symbolic-ref HEAD")).toBe(`refs/heads/${branchName}`);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  it("different session keys produce disjoint branches on the same mirror", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const a = join(workRoot, "two-sess-a");
    const b = join(workRoot, "two-sess-b");
    const ra = await m.createWorktree({ url: fixtureUrl, targetPath: a, sessionKey: "chat-A", agentName: "agent-x" });
    const rb = await m.createWorktree({ url: fixtureUrl, targetPath: b, sessionKey: "chat-B", agentName: "agent-x" });
    expect(ra.branchName).not.toBe(rb.branchName);
    writeFileSync(join(a, "scratch.txt"), "in A only");
    expect(existsSync(join(a, "scratch.txt"))).toBe(true);
    expect(existsSync(join(b, "scratch.txt"))).toBe(false);
  });

  it("(sameSessionKey, differentAgents) produces disjoint branches — fixes group-chat collision", async () => {
    // Reproduces the bug from docs/workspace-session-branch-collision-fix-design.md
    // §1: in a group chat, multiple agents reach `createWorktree` with the
    // SAME `sessionKey` (= chatId). Pre-fix the derived branch name was
    // `(sessionKey, url)`-only, so the second agent's `git worktree add`
    // failed with `fatal: '<branch>' is already used by worktree at ...`.
    // Post-fix the branch name also folds in `agentName`, so peer agents
    // get disjoint branches and both worktrees succeed.
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const sharedChat = "shared-chat-1";
    const targetA = join(workRoot, "peer-agent-a");
    const targetB = join(workRoot, "peer-agent-b");
    const ra = await m.createWorktree({
      url: fixtureUrl,
      targetPath: targetA,
      sessionKey: sharedChat,
      agentName: "architect",
    });
    const rb = await m.createWorktree({
      url: fixtureUrl,
      targetPath: targetB,
      sessionKey: sharedChat,
      agentName: "developer",
    });
    expect(ra.branchName).not.toBe(rb.branchName);
    expect(ra.branchName).toBe(deriveSessionBranchName(sharedChat, "architect", fixtureUrl));
    expect(rb.branchName).toBe(deriveSessionBranchName(sharedChat, "developer", fixtureUrl));
    // Both worktrees materialise — pre-fix the second one would have thrown.
    expect(existsSync(join(targetA, "README.md"))).toBe(true);
    expect(existsSync(join(targetB, "README.md"))).toBe(true);
  });

  it("createWorktree rejects a non-Hub occupant (D13)", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const occupied = join(workRoot, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "user-data.txt"), "important");
    await expect(
      m.createWorktree({ url: fixtureUrl, targetPath: occupied, sessionKey: "chat-C", agentName: "agent-x" }),
    ).rejects.toBeInstanceOf(GitMirrorWorktreeConflictError);
    expect(existsSync(join(occupied, "user-data.txt"))).toBe(true);
  });

  it("createWorktree auto-recovers when a leftover sits in a hub-managed root", async () => {
    // Reproduces the production incident: previous session left a directory
    // tree at the worktree target (typical cause: orphaned vite/.vite dep
    // cache rewritten by a daemonised dev server after the worktree was
    // removed). Without self-heal the next session start throws D13. With
    // `hubManagedRoots` configured, the manager rm -rf's the leftover and
    // proceeds with `worktree add`.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-heal-"));
    const managedRoot = join(dataDir, "workspaces");
    mkdirSync(managedRoot, { recursive: true });
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    await m.ensureMirror(fixtureUrl);

    const target = join(managedRoot, "agent-x", "chat-X", "agent-worktree");
    // Recreate the production shape — packages/web/.vite/deps/_metadata.json,
    // no `.git` marker.
    mkdirSync(join(target, "packages", "web", ".vite", "deps"), { recursive: true });
    writeFileSync(join(target, "packages", "web", ".vite", "deps", "_metadata.json"), "{}");

    const created = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "chat-X",
      agentName: "agent-x",
    });
    expect(created.worktreePath).toBe(target);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    // The leftover cache dir is gone — the new checkout doesn't carry
    // `packages/web/` because the fixture repo doesn't have one.
    expect(existsSync(join(target, "packages"))).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("createWorktree still throws D13 for occupants outside every managed root", async () => {
    // Belt-and-braces for the safety guard: even with `hubManagedRoots`
    // configured, targets OUTSIDE every managed root must still fail loud
    // rather than silently delete operator data.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-heal-guard-"));
    const managedRoot = join(dataDir, "workspaces");
    mkdirSync(managedRoot, { recursive: true });
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    await m.ensureMirror(fixtureUrl);

    // Target lives outside `managedRoot` — operator-supplied path.
    const outside = join(workRoot, "operator-dir");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "user-data.txt"), "important");
    await expect(
      m.createWorktree({ url: fixtureUrl, targetPath: outside, sessionKey: "chat-O", agentName: "agent-x" }),
    ).rejects.toBeInstanceOf(GitMirrorWorktreeConflictError);
    expect(existsSync(join(outside, "user-data.txt"))).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("createWorktree kills a process holding the leftover before recovery", async () => {
    // Simulates the actual orphan: a long-running child (e.g. vite) whose cwd
    // is the leftover dir. Without the pre-rm kill the rm -rf races against
    // the child's writes and the worktree add can find the dir non-empty
    // again. After the fix, the child gets SIGTERM'd, the rm sticks, and
    // `git worktree add` succeeds.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-heal-kill-"));
    const managedRoot = join(dataDir, "workspaces");
    mkdirSync(managedRoot, { recursive: true });
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    await m.ensureMirror(fixtureUrl);

    const target = join(managedRoot, "agent-x", "chat-Y", "agent-worktree");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "leftover.txt"), "cache");

    // Spawn an orphan with cwd inside the leftover. Detach so it survives
    // its parent; the test process kills it via the manager's recovery path.
    const child = await spawnLongLivedChildInDir(target);
    expect(processIsAlive(child.pid)).toBe(true);

    try {
      const created = await m.createWorktree({
        url: fixtureUrl,
        targetPath: target,
        sessionKey: "chat-Y",
        agentName: "agent-x",
      });
      expect(created.worktreePath).toBe(target);
      expect(existsSync(join(target, "README.md"))).toBe(true);
      expect(existsSync(join(target, "leftover.txt"))).toBe(false);
      // Give the kernel a beat to mark the pid as zombie/reaped.
      await new Promise((r) => setTimeout(r, 100));
      expect(processIsAlive(child.pid)).toBe(false);
    } finally {
      // Belt-and-braces in case the recovery path didn't kill it.
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore — already reaped
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("removeWorktree kills processes whose cwd is inside the worktree before deleting", async () => {
    // The other half of the orphan story: when a session ends with a child
    // (vite / esbuild / test watcher) still holding the worktree as cwd,
    // `git worktree remove --force` may succeed but the child immediately
    // recreates files under the deleted path. We pre-kill so the next session
    // start sees an empty parent and the `worktree add` is clean.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-rm-kill-"));
    const managedRoot = join(dataDir, "workspaces");
    mkdirSync(managedRoot, { recursive: true });
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    await m.ensureMirror(fixtureUrl);
    const target = join(managedRoot, "agent-x", "chat-Z", "agent-worktree");
    const { branchName } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "chat-Z",
      agentName: "agent-x",
    });
    const child = await spawnLongLivedChildInDir(target);
    expect(processIsAlive(child.pid)).toBe(true);

    try {
      await m.removeWorktree({ url: fixtureUrl, path: target, branchName });
      expect(existsSync(target)).toBe(false);
      await new Promise((r) => setTimeout(r, 100));
      expect(processIsAlive(child.pid)).toBe(false);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore — already reaped
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("removeWorktree deletes both the worktree and the session branch", async () => {
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "remove-target");
    const { branchName } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "chat-rm",
      agentName: "agent-x",
    });
    expect(tryGitIn(mirrorPath, `rev-parse --verify --quiet refs/heads/${branchName}`).ok).toBe(true);
    await m.removeWorktree({ url: fixtureUrl, path: target, branchName });
    expect(existsSync(target)).toBe(false);
    expect(tryGitIn(mirrorPath, `rev-parse --verify --quiet refs/heads/${branchName}`).ok).toBe(false);
  });

  it("gcMirrors removes mirrors not in the referenced set", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    expect(readdirSync(m.mirrorsRoot).length).toBe(1);
    const { removed } = await m.gcMirrors(new Set());
    expect(removed).toHaveLength(1);
    expect(readdirSync(m.mirrorsRoot).length).toBe(0);
  });

  it("gcMirrors keeps mirrors still referenced", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const { removed } = await m.gcMirrors(new Set([fixtureUrl]));
    expect(removed).toEqual([]);
  });

  it("gcOrphanSessionBranches removes hub-session branches that no live worktree holds", async () => {
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    // One live worktree — its branch must survive the sweep.
    const liveTarget = join(workRoot, "gc-live");
    const { branchName: liveBranch } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: liveTarget,
      sessionKey: "gc-live",
      agentName: "agent-x",
    });
    // Two orphans: a `hub-session-` branch with no worktree, and an unrelated
    // local branch the sweep must NOT touch (only `hub-session-*` is in scope).
    const baseSha = gitIn(mirrorPath, `rev-parse refs/heads/${liveBranch}`);
    execSync(`git branch hub-session-orphan-aaaaaaaa ${baseSha}`, { cwd: mirrorPath });
    execSync(`git branch unrelated-feature ${baseSha}`, { cwd: mirrorPath });
    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/heads/hub-session-orphan-aaaaaaaa").ok).toBe(true);

    const result = await m.gcOrphanSessionBranches();
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/heads/hub-session-orphan-aaaaaaaa").ok).toBe(false);
    // Live worktree's branch is untouched.
    expect(tryGitIn(mirrorPath, `rev-parse --verify --quiet refs/heads/${liveBranch}`).ok).toBe(true);
    // Non-session branch is out of scope and stays.
    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/heads/unrelated-feature").ok).toBe(true);
  });

  it("gcOrphanSessionBranches is a no-op when the mirrors root is empty", async () => {
    const m = makeManager();
    const result = await m.gcOrphanSessionBranches();
    expect(result).toEqual({ scanned: 0, deleted: 0, failed: 0 });
  });
});

describe("GitMirrorManager — session isolation regressions", () => {
  it("incident 1: fetch does not mutate session branches when upstream advances", async () => {
    // Reproduce the original data-loss scenario: session branch is attached in
    // a worktree, upstream force-moves main to a new commit, fetch runs — the
    // session branch and the worktree's HEAD must survive untouched.
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "incident-1");
    const { branchName, headCommit } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "incident-1",
      agentName: "agent-x",
    });

    // Advance upstream by one commit (plain commit, not force-push — good enough
    // because the old mirror refspec would still force-overwrite local main).
    const upstreamClone = mkdtempSync(join(tmpdir(), "ftt-upstream-"));
    execSync(`git clone -q ${fixtureUrl} ${upstreamClone}`);
    execSync("git config user.email test@example.com && git config user.name test", { cwd: upstreamClone });
    writeFileSync(join(upstreamClone, "README.md"), "advanced");
    execSync("git add . && git commit -q -m advance", { cwd: upstreamClone });
    execSync("git push -q origin main", { cwd: upstreamClone });

    await m.fetchMirror(fixtureUrl);

    expect(gitIn(mirrorPath, `rev-parse refs/heads/${branchName}`)).toBe(headCommit);
    expect(gitIn(target, "rev-parse HEAD")).toBe(headCommit);
    expect(gitIn(mirrorPath, "rev-parse refs/remotes/origin/main")).not.toBe(headCommit);

    // Restore fixture upstream to its original HEAD so later tests see the
    // expected baseline state.
    execSync(`git reset --hard ${initialMainSha}`, { cwd: upstreamClone });
    execSync("git push -q --force origin main", { cwd: upstreamClone });
    rmSync(upstreamClone, { recursive: true, force: true });
  });

  it("incident 2: fetch --prune does not remove local heads that never had an upstream counterpart", async () => {
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    // Create a local branch directly in the mirror that upstream never had.
    const localOnlySha = gitIn(mirrorPath, "rev-parse refs/remotes/origin/main");
    execSync(`git branch local-only ${localOnlySha}`, { cwd: mirrorPath });
    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/heads/local-only").ok).toBe(true);

    await m.fetchMirror(fixtureUrl);

    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/heads/local-only").ok).toBe(true);
  });

  it("incident 3: fetchMirror succeeds even when multiple session branches are checked out", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const a = join(workRoot, "incident-3-a");
    const b = join(workRoot, "incident-3-b");
    await m.createWorktree({ url: fixtureUrl, targetPath: a, sessionKey: "incident-3-A", agentName: "agent-x" });
    await m.createWorktree({ url: fixtureUrl, targetPath: b, sessionKey: "incident-3-B", agentName: "agent-x" });
    await expect(m.fetchMirror(fixtureUrl)).resolves.toBeDefined();
  });
});

describe("GitMirrorManager — migration from legacy mirror config", () => {
  it("ensureMirror rewrites legacy --mirror config to the safe refspec", async () => {
    const tmpData = mkdtempSync(join(tmpdir(), "ftt-legacy-"));
    const m = createGitMirrorManager({ dataDir: tmpData, cloneTimeoutMs: 30_000 });

    // Hand-roll a legacy mirror: `git clone --mirror` sets
    // `fetch = +refs/*:refs/*` and `mirror = true`.
    const legacyPath = join(tmpData, "git-mirrors", createHash("sha256").update(fixtureUrl).digest("hex").slice(0, 32));
    mkdirSync(join(tmpData, "git-mirrors"), { recursive: true });
    execSync(`git clone -q --mirror ${fixtureUrl} ${legacyPath}`);
    expect(gitIn(legacyPath, "config --get remote.origin.mirror")).toBe("true");

    // Run ensureMirror — should rewrite the config in-place.
    const result = await m.ensureMirror(fixtureUrl);
    expect(result.cloned).toBe(false);
    expect(gitIn(legacyPath, "config --get remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(tryGitIn(legacyPath, "config --get remote.origin.mirror").ok).toBe(false);

    // Second call is a no-op (idempotent).
    await m.ensureMirror(fixtureUrl);
    expect(gitIn(legacyPath, "config --get remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  });
});

describe("GitMirrorManager — crash recovery", () => {
  it("reattaches to an existing session branch when the worktree directory is missing", async () => {
    // Simulate a crashed session: branch exists in the mirror, path has been
    // manually cleaned up. Next session start must attach the branch to a new
    // worktree path rather than failing because the branch already exists.
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    const firstTarget = join(workRoot, "crash-first");
    const { branchName, headCommit } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: firstTarget,
      sessionKey: "crashy",
      agentName: "agent-x",
    });
    // User or an external process removed the worktree dir without running
    // `git worktree remove`. Git marks it prunable on next access.
    rmSync(firstTarget, { recursive: true, force: true });
    execSync("git worktree prune", { cwd: mirrorPath });
    expect(tryGitIn(mirrorPath, `rev-parse --verify --quiet refs/heads/${branchName}`).ok).toBe(true);

    const reopened = await m.createWorktree({
      url: fixtureUrl,
      targetPath: firstTarget,
      sessionKey: "crashy",
      agentName: "agent-x",
    });
    expect(reopened.branchName).toBe(branchName);
    expect(reopened.headCommit).toBe(headCommit);
    expect(existsSync(join(firstTarget, "README.md"))).toBe(true);
  });

  it("self-heals when origin/HEAD is missing on createWorktree without an explicit ref", async () => {
    // Reproduces the production failure mode: a mirror created before the
    // bidirectional-fallback fix had `set-head --auto` run over a protocol
    // whose creds were missing — `gitOk` swallowed the failure and left
    // `refs/remotes/origin/HEAD` unset. Subsequent `createWorktree({ ref:
    // undefined })` (the default-branch path) blew up in `resolveBase`.
    //
    // Now `resolveBase` self-heals: if origin/HEAD is missing, it retries
    // `set-head --auto` (via the fallback-aware path) before giving up.
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    // Force the broken state: remove origin/HEAD that bootstrap had set.
    rmSync(join(mirrorPath, "refs", "remotes", "origin", "HEAD"), { force: true });
    // Sanity check the precondition we're reproducing.
    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/remotes/origin/HEAD").ok).toBe(false);

    // createWorktree without an explicit `ref` exercises the default-branch
    // path through resolveBase — this used to throw with
    // "Cannot resolve default branch: refs/remotes/origin/HEAD is missing".
    const target = join(workRoot, "self-heal");
    const result = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "self-heal-1",
      agentName: "agent-x",
    });
    expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(tryGitIn(mirrorPath, "rev-parse --verify --quiet refs/remotes/origin/HEAD").ok).toBe(true);
  });

  it("prunes a stale worktree registration before re-creating at the same path", async () => {
    // PR #393 dogfood: the bare mirror retained a "prunable" worktree
    // admin record after an external `rm -rf` of the worktree directory.
    // Subsequent `git worktree add -b <newBranch> <samePath> ...` failed
    // with `fatal: '<path>' is a missing but already registered worktree`.
    // The fix runs `git worktree prune` inside `createWorktree` so dead
    // records are cleared before the add attempt.
    //
    // Setup: create a worktree, rm -rf the dir WITHOUT running prune
    // (mimics the dogfood crash), then call `createWorktree` for a
    // DIFFERENT sessionKey/branch at the same path. Without the fix git
    // would error; with the fix it succeeds.
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "prune-collision");

    // 1. First session: writes a worktree + branch + registration.
    const first = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "session-A",
      agentName: "agent-x",
    });
    expect(existsSync(target)).toBe(true);

    // 2. Simulate external wipe: directory gone, branch + worktree admin
    //    record still in the bare mirror. (No `git worktree prune` here.)
    rmSync(target, { recursive: true, force: true });
    expect(existsSync(target)).toBe(false);
    // Sanity: the admin record is still around — `git worktree list` shows
    // the path as prunable.
    const listed = execSync("git worktree list --porcelain", { cwd: mirrorPath }).toString();
    expect(listed).toContain(target);

    // 3. New session targets the same path with a NEW branch (different
    //    sessionKey → different hash). Without the prune fix this throws
    //    "missing but already registered worktree".
    const second = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "session-B-different-key",
      agentName: "agent-x",
    });
    expect(second.branchName).not.toBe(first.branchName);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  it("refuses to proceed when the worktree path exists but the session branch is missing", async () => {
    // Simulates ref-level corruption: the worktree directory survives on disk,
    // but the session branch in the mirror has vanished (manual ref tampering,
    // disk restore from a partial backup, etc.). createWorktree must refuse
    // rather than silently recreate an unrelated branch at the same path.
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "crash-ghost");
    const { branchName } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "ghosty",
      agentName: "agent-x",
    });
    // Bypass git's safety net and delete the ref file directly. Works against
    // loose refs; a freshly-created branch never reaches packed-refs.
    const refPath = join(mirrorPath, "refs", "heads", branchName);
    rmSync(refPath, { force: true });

    await expect(
      m.createWorktree({ url: fixtureUrl, targetPath: target, sessionKey: "ghosty", agentName: "agent-x" }),
    ).rejects.toBeInstanceOf(GitMirrorError);
  });
});

describe("GitMirrorManager — HTTPS auth failure heuristic (isLikelyHttpsAuthFailure)", () => {
  it.each([
    // The canonical systemd / launchd background-service failure that
    // motivated this code path — taken verbatim from a production log.
    "git fetch --prune origin exited with code 128: fatal: could not read Username for 'GitHub · Change is constant.': No such device or address",
    "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
    "remote: HTTP Basic: Access denied",
    "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 401",
    "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 403",
    "remote: Invalid username or password.",
    "fatal: could not read Password for 'https://x@github.com'",
    "fatal: terminal prompts disabled",
  ])("matches HTTPS credential-shaped error: %s", (msg) => {
    expect(isLikelyHttpsAuthFailure(msg)).toBe(true);
  });

  it.each([
    "",
    "fatal: Could not resolve host: github.com",
    "ssh: connect to host github.com port 22: Connection refused",
    "fatal: couldn't find remote ref refs/heads/missing",
    "fatal: repository 'https://example.com/none.git/' not found",
    "fatal: unable to access 'https://example.com/x.git/': SSL certificate problem: self signed certificate",
    "fatal: index file corrupt",
    "error: Could not write config file",
    // SSH-side failures — should NOT be misclassified as HTTPS.
    "git@github.com: Permission denied (publickey).",
    "Host key verification failed.",
  ])("does NOT match: %s", (msg) => {
    expect(isLikelyHttpsAuthFailure(msg)).toBe(false);
  });
});

describe("GitMirrorManager — SSH auth failure heuristic (isLikelySshAuthFailure)", () => {
  it.each([
    "git@github.com: Permission denied (publickey).",
    "Permission denied, please try again.",
    "Permission denied (publickey,password,keyboard-interactive).",
    "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    "Host key verification failed.\nfatal: Could not read from remote repository.",
    "Unable to negotiate with 1.2.3.4 port 22: no matching host key type found.",
    "Unable to negotiate: no mutual signature algorithm",
  ])("matches SSH credential-shaped error: %s", (msg) => {
    expect(isLikelySshAuthFailure(msg)).toBe(true);
  });

  it.each([
    "",
    "ssh: connect to host github.com port 22: Connection refused",
    "ssh: connect to host github.com port 22: Connection timed out",
    "ssh: Could not resolve hostname github.com: Name or service not known",
    "fatal: couldn't find remote ref refs/heads/missing",
    // HTTPS-side failures — should NOT be misclassified as SSH.
    "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
    "fatal: could not read Username for 'https://github.com'",
  ])("does NOT match: %s", (msg) => {
    expect(isLikelySshAuthFailure(msg)).toBe(false);
  });
});

describe("GitMirrorManager — https→ssh URL rewrite (httpsToSshBaseRewrite)", () => {
  it("maps the common github.com case to scp-like ssh", () => {
    expect(httpsToSshBaseRewrite("https://github.com/owner/repo.git")).toEqual({
      httpsBase: "https://github.com/",
      sshBase: "git@github.com:",
    });
  });

  it("preserves the path-less form (rewrite is on the host base, not the full URL)", () => {
    expect(httpsToSshBaseRewrite("https://gitlab.com/group/sub/project")).toEqual({
      httpsBase: "https://gitlab.com/",
      sshBase: "git@gitlab.com:",
    });
  });

  it("returns null when the URL carries a non-default port (no portable HTTPS↔SSH port mapping)", () => {
    expect(httpsToSshBaseRewrite("https://gitlab.example.com:8443/x/y.git")).toBeNull();
  });

  it("treats the explicit default port 443 as no-port", () => {
    expect(httpsToSshBaseRewrite("https://github.com:443/owner/repo.git")).toEqual({
      httpsBase: "https://github.com/",
      sshBase: "git@github.com:",
    });
  });

  it("ignores non-HTTPS URLs (file://, ssh://, git@, http://)", () => {
    expect(httpsToSshBaseRewrite("file:///tmp/repo")).toBeNull();
    expect(httpsToSshBaseRewrite("ssh://git@github.com/foo/bar.git")).toBeNull();
    expect(httpsToSshBaseRewrite("git@github.com:foo/bar.git")).toBeNull();
    expect(httpsToSshBaseRewrite("http://github.com/foo/bar.git")).toBeNull();
  });

  it("refuses URLs with embedded credentials (never silently downgrade auth strength)", () => {
    expect(httpsToSshBaseRewrite("https://user:token@github.com/foo/bar.git")).toBeNull();
    expect(httpsToSshBaseRewrite("https://user@github.com/foo/bar.git")).toBeNull();
  });

  it("returns null on parse failure / empty input", () => {
    expect(httpsToSshBaseRewrite("")).toBeNull();
    expect(httpsToSshBaseRewrite("not a url")).toBeNull();
  });
});

describe("GitMirrorManager — ssh→https URL rewrite (sshToHttpsBaseRewrite)", () => {
  it("maps scp-like to https", () => {
    expect(sshToHttpsBaseRewrite("git@github.com:owner/repo.git")).toEqual({
      sshBase: "git@github.com:",
      httpsBase: "https://github.com/",
    });
  });

  it("scp-like without user@ still maps", () => {
    // Edge: `host:path` without explicit user. Not common, but valid ssh.
    expect(sshToHttpsBaseRewrite("github.com:owner/repo.git")).toEqual({
      sshBase: "github.com:",
      httpsBase: "https://github.com/",
    });
  });

  it("maps ssh:// URL form to https (default port)", () => {
    expect(sshToHttpsBaseRewrite("ssh://git@github.com/owner/repo.git")).toEqual({
      sshBase: "ssh://git@github.com/",
      httpsBase: "https://github.com/",
    });
  });

  it("treats explicit ssh port 22 as default and maps", () => {
    expect(sshToHttpsBaseRewrite("ssh://git@github.com:22/owner/repo.git")).toEqual({
      sshBase: "ssh://git@github.com:22/",
      httpsBase: "https://github.com/",
    });
  });

  it("returns null for ssh:// with non-default port (no portable mapping)", () => {
    expect(sshToHttpsBaseRewrite("ssh://git@gitlab.example.com:2222/x/y.git")).toBeNull();
  });

  it("rejects scp-like that looks like host:port (ambiguous)", () => {
    // `host:1234/...` — git would interpret this as ssh://host:1234/...
    expect(sshToHttpsBaseRewrite("github.com:8080/owner/repo.git")).toBeNull();
  });

  it("rejects scp-like whose path starts with `/` (matches shared schema rule)", () => {
    // `git@host:/path` is not legal scp form; the shared schema rejects it on
    // input. Keep client-side rewrite in lockstep so the two layers can't
    // disagree on what's "ssh".
    expect(sshToHttpsBaseRewrite("git@github.com:/owner/repo.git")).toBeNull();
  });

  it("rejects embedded password in either form", () => {
    expect(sshToHttpsBaseRewrite("ssh://git:secret@github.com/x.git")).toBeNull();
    // scp-like has no password field — the regex would reject ":pass@host:path".
    expect(sshToHttpsBaseRewrite("git:secret@github.com:owner/repo.git")).toBeNull();
  });

  it("returns null for non-SSH URLs", () => {
    expect(sshToHttpsBaseRewrite("https://github.com/foo/bar.git")).toBeNull();
    expect(sshToHttpsBaseRewrite("file:///tmp/repo")).toBeNull();
    expect(sshToHttpsBaseRewrite("")).toBeNull();
    expect(sshToHttpsBaseRewrite("not-a-url")).toBeNull();
  });
});

describe("GitMirrorManager — canonical URL hashing (canonicalizeRepoUrl + hashUrl)", () => {
  it("collapses https / ssh / scp-like for the same upstream into one canonical form", () => {
    const expected = "github.com/owner/repo";
    expect(canonicalizeRepoUrl("https://github.com/owner/repo.git")).toBe(expected);
    expect(canonicalizeRepoUrl("https://github.com/owner/repo")).toBe(expected);
    expect(canonicalizeRepoUrl("git@github.com:owner/repo.git")).toBe(expected);
    expect(canonicalizeRepoUrl("git@github.com:owner/repo")).toBe(expected);
    expect(canonicalizeRepoUrl("ssh://git@github.com/owner/repo.git")).toBe(expected);
    expect(canonicalizeRepoUrl("ssh://git@github.com:22/owner/repo.git")).toBe(expected);
    expect(canonicalizeRepoUrl("https://github.com:443/owner/repo.git")).toBe(expected);
    // Mixed-case host normalises down.
    expect(canonicalizeRepoUrl("https://GitHub.com/owner/repo.git")).toBe(expected);
  });

  it("ignores trailing slash on path (OAuth pickers occasionally emit it)", () => {
    const expected = "github.com/owner/repo";
    expect(canonicalizeRepoUrl("https://github.com/owner/repo/")).toBe(expected);
    expect(canonicalizeRepoUrl("https://github.com/owner/repo.git/")).toBe(expected);
    expect(canonicalizeRepoUrl("ssh://git@github.com/owner/repo/")).toBe(expected);
    // hash collapses too — same mirror dir for slash / no-slash forms.
    expect(hashUrl("https://github.com/owner/repo/")).toBe(hashUrl("https://github.com/owner/repo"));
  });

  it("preserves non-default ports (different upstream → different mirror)", () => {
    expect(canonicalizeRepoUrl("ssh://git@gitlab.example.com:2222/x/y.git")).toBe("gitlab.example.com:2222/x/y");
    expect(canonicalizeRepoUrl("https://gitlab.example.com:8443/x/y.git")).toBe("gitlab.example.com:8443/x/y");
  });

  it("hashUrl is identical for all addressing forms of the same repo", () => {
    const h1 = hashUrl("https://github.com/owner/repo.git");
    const h2 = hashUrl("git@github.com:owner/repo.git");
    const h3 = hashUrl("ssh://git@github.com/owner/repo.git");
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it("hashUrl differs for different repos on the same host", () => {
    expect(hashUrl("https://github.com/a/b.git")).not.toBe(hashUrl("https://github.com/c/d.git"));
  });

  it("falls back to raw input for un-parseable strings", () => {
    expect(canonicalizeRepoUrl("garbage")).toBe("garbage");
  });
});

describe("GitMirrorManager — ssh fallback", () => {
  it("does NOT touch ssh path for non-https origins (file://, ssh://) — failure surfaces raw", async () => {
    // The fixture URL is file:// — even if we point it at a corrupt repo and
    // fetch fails, the manager must surface the raw `GitMirrorError`, not
    // `GitMirrorAuthError`. Fallback is HTTPS-only by design; misclassifying
    // a file:// failure as "try ssh" would mask real bugs and waste a retry.
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    // Corrupt the mirror's origin to an unreachable file:// path.
    execSync("git remote set-url origin file:///nonexistent/path/that/does/not/exist.git", { cwd: mirrorPath });

    let caught: unknown;
    try {
      await m.fetchMirror(fixtureUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitMirrorError);
    expect(caught).not.toBeInstanceOf(GitMirrorAuthError);
  });

  it("does NOT classify a non-credential https failure as auth — bootstrap against an unreachable https URL throws raw GitMirrorError", async () => {
    // Drive `ensureMirror` (which goes through the same `fetchOrigin` helper
    // as `fetchMirror`) against an https URL whose connect() always refuses.
    // The bootstrap MUST fail with the raw `GitMirrorError` — wrapping a
    // connect-refused error in `GitMirrorAuthError` would falsely imply that
    // ssh was tried and also failed for credential reasons.
    //
    // Port 1 is reserved & always refuses connections → fast deterministic
    // failure, no real network egress, safe in any CI sandbox.
    const m = createGitMirrorManager({
      dataDir: mkdtempSync(join(tmpdir(), "ftt-mgr-https-")),
      cloneTimeoutMs: 15_000,
    });
    let caught: unknown;
    try {
      await m.ensureMirror("https://127.0.0.1:1/nope.git");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitMirrorError);
    expect(caught).not.toBeInstanceOf(GitMirrorAuthError);
  });
});

describe("GitMirrorManager — concurrency", () => {
  it("collapses parallel ensureMirror calls onto a single bootstrap", async () => {
    const m = makeManager();
    const [a, b] = await Promise.all([m.ensureMirror(fixtureUrl), m.ensureMirror(fixtureUrl)]);
    // Exactly one of the two saw the cold path.
    expect([a.cloned, b.cloned].sort()).toEqual([false, true]);
    expect(a.mirrorPath).toBe(b.mirrorPath);
  });

  it("serialises parallel createWorktree calls on the same URL (config-lock contention)", async () => {
    // `git worktree add -b` writes to the mirror's `config` file to set
    // upstream tracking. Running two adds in parallel without a lock causes
    // the second to fail with "could not lock config file" (found via E2E).
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const a = join(workRoot, "conc-a");
    const b = join(workRoot, "conc-b");
    const [ra, rb] = await Promise.all([
      m.createWorktree({ url: fixtureUrl, targetPath: a, sessionKey: "conc-A", agentName: "agent-x" }),
      m.createWorktree({ url: fixtureUrl, targetPath: b, sessionKey: "conc-B", agentName: "agent-x" }),
    ]);
    expect(ra.branchName).not.toBe(rb.branchName);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});
