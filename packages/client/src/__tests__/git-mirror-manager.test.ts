import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeRepoUrl,
  createGitMirrorManager,
  deriveSessionBranchName,
  GitMirrorAuthError,
  GitMirrorError,
  type GitMirrorManager,
  GitMirrorTimeoutError,
  GitMirrorWorktreeConflictError,
  hashUrl,
  httpsToSshBaseRewrite,
  isConfigLockError,
  isLikelyAuthFailure,
  isLikelyHttpsAuthFailure,
  isLikelySshAuthFailure,
  isLikelyTransientNetworkError,
  retryOnTransientNetwork,
  sshToHttpsBaseRewrite,
} from "../runtime/git-mirror-manager.js";
import { isUnderManagedRoot } from "../runtime/worktree-cleanup.js";

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

function makeLogSpies() {
  const spies = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    spies,
    log: spies as unknown as Parameters<typeof createGitMirrorManager>[0]["log"],
  };
}

function createFakeBareMirror(dataDir: string, url: string): string {
  const mirrorPath = join(dataDir, "git-mirrors", hashUrl(url));
  mkdirSync(join(mirrorPath, "objects"), { recursive: true });
  writeFileSync(join(mirrorPath, "HEAD"), "ref: refs/heads/main\n");
  return mirrorPath;
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

async function waitForProcessExit(proc: ChildProcess, pid: number, timeoutMs = 2_000): Promise<boolean> {
  if (!processIsAlive(pid)) return true;
  if (proc.exitCode !== null || proc.signalCode !== null) return !processIsAlive(pid);

  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });

  return !processIsAlive(pid);
}

async function withFakeLsofPid(pid: number, run: () => Promise<void>): Promise<void> {
  const binDir = mkdtempSync(join(tmpdir(), "ftt-fake-lsof-"));
  const oldPath = process.env.PATH;
  writeFileSync(join(binDir, "lsof"), `#!/bin/sh\nprintf 'p${pid}\\n'\n`, {
    encoding: "utf-8",
    mode: 0o755,
  });
  process.env.PATH = [binDir, oldPath].filter(Boolean).join(delimiter);

  try {
    await run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    rmSync(binDir, { recursive: true, force: true });
  }
}

async function withFakePath(files: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const binDir = mkdtempSync(join(tmpdir(), "ftt-fake-path-"));
  const oldPath = process.env.PATH;
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(binDir, name), body, { encoding: "utf-8", mode: 0o755 });
  }
  process.env.PATH = binDir;

  try {
    await run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    rmSync(binDir, { recursive: true, force: true });
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

  it("ensureMirror logs a fresh mirror bootstrap when a logger is configured", async () => {
    const { spies, log } = makeLogSpies();
    const m = createGitMirrorManager({
      dataDir: mkdtempSync(join(tmpdir(), "ftt-ensure-log-")),
      cloneTimeoutMs: 30_000,
      log,
    });

    await m.ensureMirror(fixtureUrl);

    expect(spies.debug).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: fixtureUrl, cloned: true }),
      "mirror ensured",
    );
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

  it("createWorktree accepts an explicit commit SHA ref", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "wt-explicit-sha");
    const result = await m.createWorktree({
      url: fixtureUrl,
      ref: initialMainSha,
      targetPath: target,
      sessionKey: "chat-sha",
      agentName: "agent-x",
    });

    expect(result.headCommit).toBe(initialMainSha);
    expect(gitIn(target, "rev-parse HEAD")).toBe(initialMainSha);
  });

  it("throws when creating or fetching without a mirror", async () => {
    const m = makeManager();
    await expect(
      m.createWorktree({
        url: fixtureUrl,
        targetPath: join(workRoot, "missing-mirror-wt"),
        sessionKey: "missing",
        agentName: "agent-x",
      }),
    ).rejects.toThrow(`Cannot create worktree — no mirror exists for "${fixtureUrl}"`);
    await expect(m.fetchMirror(fixtureUrl)).rejects.toThrow(`Cannot fetch — no mirror exists for "${fixtureUrl}"`);
  });

  it("gcMirrors no-ops when the mirror root does not exist and skips non-bare entries", async () => {
    const m = makeManager();
    expect(await m.gcMirrors(new Set())).toEqual({ removed: [] });

    mkdirSync(join(m.mirrorsRoot, "not-a-bare-repo"), { recursive: true });
    expect(await m.gcMirrors(new Set())).toEqual({ removed: [] });
    expect(existsSync(join(m.mirrorsRoot, "not-a-bare-repo"))).toBe(true);
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

  it("reuses an already-attached worktree for the same session branch", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "reuse-same-session");
    const first = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "reuse-chat",
      agentName: "agent-x",
    });
    const second = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "reuse-chat",
      agentName: "agent-x",
    });

    expect(second.branchName).toBe(first.branchName);
    expect(second.headCommit).toBe(first.headCommit);
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

  it("createWorktree classifies file and special-file D13 occupants and logs conflicts", async () => {
    const { spies, log } = makeLogSpies();
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-d13-kind-"));
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, log });
    await m.ensureMirror(fixtureUrl);

    const occupiedFile = join(workRoot, "occupied-file");
    writeFileSync(occupiedFile, "important");
    await expect(
      m.createWorktree({ url: fixtureUrl, targetPath: occupiedFile, sessionKey: "chat-file", agentName: "agent-x" }),
    ).rejects.toThrow("occupied by file");

    const occupiedGitRepo = join(workRoot, "occupied-git-repo");
    mkdirSync(join(occupiedGitRepo, ".git"), { recursive: true });
    await expect(
      m.createWorktree({
        url: fixtureUrl,
        targetPath: occupiedGitRepo,
        sessionKey: "chat-git-repo",
        agentName: "agent-x",
      }),
    ).rejects.toThrow("occupied by git-repo");

    const occupiedFifo = join(workRoot, "occupied-fifo");
    execSync(`mkfifo "${occupiedFifo}"`);
    try {
      await expect(
        m.createWorktree({ url: fixtureUrl, targetPath: occupiedFifo, sessionKey: "chat-fifo", agentName: "agent-x" }),
      ).rejects.toThrow("occupied by other");
    } finally {
      rmSync(occupiedFifo, { force: true });
    }

    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: occupiedFile, occupantKind: "file" }),
      "worktree create conflict",
    );
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: occupiedGitRepo, occupantKind: "git-repo" }),
      "worktree create conflict",
    );
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: occupiedFifo, occupantKind: "other" }),
      "worktree create conflict",
    );

    rmSync(dataDir, { recursive: true, force: true });
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

  it("createWorktree logs hub-managed leftover auto-recovery", async () => {
    const { spies, log } = makeLogSpies();
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-heal-log-"));
    const managedRoot = join(dataDir, "workspaces");
    mkdirSync(managedRoot, { recursive: true });
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot], log });
    await m.ensureMirror(fixtureUrl);

    const target = join(managedRoot, "agent-x", "chat-log", "agent-worktree");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "leftover.txt"), "cache");

    await m.createWorktree({ url: fixtureUrl, targetPath: target, sessionKey: "chat-log", agentName: "agent-x" });

    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: target, occupantKind: "directory", hubManagedRoots: [managedRoot] }),
      "worktree target occupied inside hub-managed root — auto-recovering (kill holders + rm -rf)",
    );

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("createWorktree fails loudly when hub-managed leftover cleanup cannot remove the target", async () => {
    if (process.getuid?.() === 0) return;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-heal-rm-fail-"));
    const managedRoot = join(dataDir, "workspaces");
    const lockedParent = join(managedRoot, "locked");
    const target = join(lockedParent, "agent-worktree");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "leftover.txt"), "cache");
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    await m.ensureMirror(fixtureUrl);

    chmodSync(lockedParent, 0o555);
    try {
      await expect(
        m.createWorktree({ url: fixtureUrl, targetPath: target, sessionKey: "chat-rm-fail", agentName: "agent-x" }),
      ).rejects.toThrow("cleanup failed after killing holders");
    } finally {
      chmodSync(lockedParent, 0o755);
      rmSync(dataDir, { recursive: true, force: true });
    }
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
      await withFakeLsofPid(child.pid, async () => {
        const created = await m.createWorktree({
          url: fixtureUrl,
          targetPath: target,
          sessionKey: "chat-Y",
          agentName: "agent-x",
        });
        expect(created.worktreePath).toBe(target);
      });
      expect(existsSync(join(target, "README.md"))).toBe(true);
      expect(existsSync(join(target, "leftover.txt"))).toBe(false);
      expect(await waitForProcessExit(child.proc, child.pid)).toBe(true);
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
      await withFakeLsofPid(child.pid, async () => {
        await m.removeWorktree({ url: fixtureUrl, path: target, branchName });
      });
      expect(existsSync(target)).toBe(false);
      expect(await waitForProcessExit(child.proc, child.pid)).toBe(true);
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

  it("removeWorktree removes orphan directories when the mirror is already gone", async () => {
    const m = makeManager();
    const orphan = join(workRoot, "orphan-no-mirror");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "leftover.txt"), "orphan");

    await m.removeWorktree({ url: fixtureUrl, path: orphan, branchName: "hub-session-orphan" });

    expect(existsSync(orphan)).toBe(false);
  });

  it("removeWorktree prunes stale bookkeeping when the path is already gone", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "remove-already-gone");
    const { branchName } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "remove-gone",
      agentName: "agent-x",
    });
    rmSync(target, { recursive: true, force: true });

    await m.removeWorktree({ url: fixtureUrl, path: target, branchName });

    expect(existsSync(target)).toBe(false);
  });

  it("removeWorktree removes an orphan dir when git worktree remove cannot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-remove-orphan-"));
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000 });
    createFakeBareMirror(dataDir, fixtureUrl);
    const target = join(workRoot, "remove-orphan-dir");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "orphan.txt"), "leftover");

    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *"worktree remove"*) exit 1 ;;
  *"rev-parse --verify"*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        await m.removeWorktree({ url: fixtureUrl, path: target, branchName: "hub-session-orphan" });
      },
    );

    expect(existsSync(target)).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("removeWorktree logs when branch deletion fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-remove-branch-fail-"));
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const m = createGitMirrorManager({
      dataDir,
      cloneTimeoutMs: 30_000,
      log: log as unknown as Parameters<typeof createGitMirrorManager>[0]["log"],
    });
    createFakeBareMirror(dataDir, fixtureUrl);

    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *"rev-parse --verify"*) exit 0 ;;
  *"branch -D"*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        await m.removeWorktree({
          url: fixtureUrl,
          path: join(workRoot, "missing-remove-path"),
          branchName: "hub-session-leak",
        });
      },
    );

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "hub-session-leak" }),
      "branch -D failed during removeWorktree — config segment will leak until next gcOrphanSessionBranches",
    );
    rmSync(dataDir, { recursive: true, force: true });
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

  it("gcOrphanSessionBranches skips non-bare entries under the mirrors root", async () => {
    const m = makeManager();
    mkdirSync(join(m.mirrorsRoot, "not-bare"), { recursive: true });

    const result = await m.gcOrphanSessionBranches();

    expect(result).toEqual({ scanned: 0, deleted: 0, failed: 0 });
  });

  it("gcOrphanSessionBranches skips a mirror when worktree listing fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-gc-worktree-list-fail-"));
    const { spies, log } = makeLogSpies();
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, log });
    createFakeBareMirror(dataDir, fixtureUrl);

    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *"worktree list"*) exit 2 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        await expect(m.gcOrphanSessionBranches()).resolves.toEqual({ scanned: 0, deleted: 0, failed: 0 });
      },
    );

    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: hashUrl(fixtureUrl) }),
      "gcOrphanSessionBranches: worktree list failed — skipping mirror",
    );
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("gcOrphanSessionBranches skips a mirror when branch listing fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-gc-branch-list-fail-"));
    const { spies, log } = makeLogSpies();
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, log });
    createFakeBareMirror(dataDir, fixtureUrl);

    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *"worktree list"*) exit 0 ;;
  *"for-each-ref"*) exit 2 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        await expect(m.gcOrphanSessionBranches()).resolves.toEqual({ scanned: 0, deleted: 0, failed: 0 });
      },
    );

    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: hashUrl(fixtureUrl) }),
      "gcOrphanSessionBranches: branch listing failed — skipping mirror",
    );
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("gcOrphanSessionBranches counts a failed orphan branch deletion", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-gc-delete-fail-"));
    const { spies, log } = makeLogSpies();
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, log });
    createFakeBareMirror(dataDir, fixtureUrl);

    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *"worktree list"*) exit 0 ;;
  *"for-each-ref"*) echo "hub-session-orphan-aaaaaaaa"; exit 0 ;;
  *"branch -D"*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        await expect(m.gcOrphanSessionBranches()).resolves.toEqual({ scanned: 1, deleted: 0, failed: 1 });
      },
    );

    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: hashUrl(fixtureUrl), branch: "hub-session-orphan-aaaaaaaa" }),
      "gcOrphanSessionBranches: branch -D failed",
    );
    expect(spies.info).toHaveBeenCalledWith(
      { scanned: 1, deleted: 0, failed: 1 },
      "gcOrphanSessionBranches: swept orphan session branches",
    );
    rmSync(dataDir, { recursive: true, force: true });
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

describe("GitMirrorManager — git process failures", () => {
  it("classifies config lock errors only for GitMirrorError instances", () => {
    expect(isConfigLockError(new Error("could not lock config file"))).toBe(false);
    expect(isConfigLockError(new GitMirrorError("error: could not lock config file config.lock"))).toBe(true);
  });

  it("surfaces git subprocess timeouts and cleans the partial mirror", async () => {
    await withFakePath(
      {
        git: "#!/bin/sh\n/bin/sleep 5\n",
      },
      async () => {
        const dataDir = mkdtempSync(join(tmpdir(), "ftt-timeout-"));
        const { spies, log } = makeLogSpies();
        const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 5, log });

        await expect(m.ensureMirror(fixtureUrl)).rejects.toBeInstanceOf(GitMirrorTimeoutError);
        expect(existsSync(m.mirrorsRoot)).toBe(true);
        expect(readdirSync(m.mirrorsRoot)).toHaveLength(0);
        expect(spies.warn).toHaveBeenCalledWith(
          expect.objectContaining({ gitUrl: fixtureUrl, timeoutMs: 5, elapsedMs: 5 }),
          "mirror clone timeout",
        );
      },
    );
  });

  it("surfaces git spawn errors when git is not on PATH", async () => {
    await withFakePath({}, async () => {
      const m = createGitMirrorManager({ dataDir: mkdtempSync(join(tmpdir(), "ftt-no-git-")), cloneTimeoutMs: 30_000 });
      await expect(m.ensureMirror(fixtureUrl)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("uses the clone timeout from FIRST_TREE_GIT_CLONE_TIMEOUT_MS when no option is provided", async () => {
    const oldTimeout = process.env.FIRST_TREE_GIT_CLONE_TIMEOUT_MS;
    process.env.FIRST_TREE_GIT_CLONE_TIMEOUT_MS = "5";
    try {
      await withFakePath(
        {
          git: "#!/bin/sh\n/bin/sleep 5\n",
        },
        async () => {
          const m = createGitMirrorManager({ dataDir: mkdtempSync(join(tmpdir(), "ftt-env-timeout-")) });
          await expect(m.ensureMirror(fixtureUrl)).rejects.toBeInstanceOf(GitMirrorTimeoutError);
        },
      );
    } finally {
      if (oldTimeout === undefined) {
        delete process.env.FIRST_TREE_GIT_CLONE_TIMEOUT_MS;
      } else {
        process.env.FIRST_TREE_GIT_CLONE_TIMEOUT_MS = oldTimeout;
      }
    }
  });

  it("fetchMirror logs auth, timeout, and generic git failure categories", async () => {
    const authUrl = "https://github.com/acme/auth-fail.git";
    const authDataDir = mkdtempSync(join(tmpdir(), "ftt-fetch-auth-log-"));
    const authLog = makeLogSpies();
    const authManager = createGitMirrorManager({ dataDir: authDataDir, cloneTimeoutMs: 30_000, log: authLog.log });
    createFakeBareMirror(authDataDir, authUrl);
    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *insteadOf*) echo "git@github.com: Permission denied (publickey)." >&2; exit 128 ;;
  *"fetch --prune origin"*) echo "fatal: Authentication failed for 'https://github.com/acme/auth-fail.git/'" >&2; exit 128 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        await expect(authManager.fetchMirror(authUrl)).rejects.toBeInstanceOf(GitMirrorAuthError);
      },
    );
    expect(authLog.spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: authUrl, errorCode: "auth-failed" }),
      "mirror fetch failed",
    );

    const timeoutUrl = "https://github.com/acme/timeout.git";
    const timeoutDataDir = mkdtempSync(join(tmpdir(), "ftt-fetch-timeout-log-"));
    const timeoutLog = makeLogSpies();
    const timeoutManager = createGitMirrorManager({ dataDir: timeoutDataDir, cloneTimeoutMs: 5, log: timeoutLog.log });
    createFakeBareMirror(timeoutDataDir, timeoutUrl);
    await withFakePath(
      {
        git: "#!/bin/sh\n/bin/sleep 5\n",
      },
      async () => {
        await expect(timeoutManager.fetchMirror(timeoutUrl)).rejects.toBeInstanceOf(GitMirrorTimeoutError);
      },
    );
    expect(timeoutLog.spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: timeoutUrl, errorCode: "timeout" }),
      "mirror fetch failed",
    );

    const gitFailUrl = "https://github.com/acme/git-fail.git";
    const gitFailDataDir = mkdtempSync(join(tmpdir(), "ftt-fetch-git-log-"));
    const gitFailLog = makeLogSpies();
    const gitFailManager = createGitMirrorManager({
      dataDir: gitFailDataDir,
      cloneTimeoutMs: 30_000,
      log: gitFailLog.log,
    });
    createFakeBareMirror(gitFailDataDir, gitFailUrl);
    await withFakePath(
      {
        git: '#!/bin/sh\necho "fatal: repository not found" >&2\nexit 128\n',
      },
      async () => {
        await expect(gitFailManager.fetchMirror(gitFailUrl)).rejects.toBeInstanceOf(GitMirrorError);
      },
    );
    expect(gitFailLog.spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: gitFailUrl, errorCode: "git-failed" }),
      "mirror fetch failed",
    );

    const spawnFailUrl = "https://github.com/acme/spawn-fail.git";
    const spawnFailDataDir = mkdtempSync(join(tmpdir(), "ftt-fetch-spawn-log-"));
    const spawnFailLog = makeLogSpies();
    const spawnFailManager = createGitMirrorManager({
      dataDir: spawnFailDataDir,
      cloneTimeoutMs: 30_000,
      log: spawnFailLog.log,
    });
    createFakeBareMirror(spawnFailDataDir, spawnFailUrl);
    await withFakePath({}, async () => {
      await expect(spawnFailManager.fetchMirror(spawnFailUrl)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(spawnFailLog.spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: spawnFailUrl, errorCode: "unknown" }),
      "mirror fetch failed",
    );

    rmSync(authDataDir, { recursive: true, force: true });
    rmSync(timeoutDataDir, { recursive: true, force: true });
    rmSync(gitFailDataDir, { recursive: true, force: true });
    rmSync(spawnFailDataDir, { recursive: true, force: true });
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

describe("GitMirrorManager — auth failure union helper", () => {
  it("matches either HTTPS or SSH credential failures", () => {
    expect(isLikelyAuthFailure("fatal: Authentication failed for 'https://github.com/foo/bar.git/'")).toBe(true);
    expect(isLikelyAuthFailure("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(isLikelyAuthFailure("fatal: repository not found")).toBe(false);
  });

  it("constructs timeout and auth errors with stable names", () => {
    expect(new GitMirrorTimeoutError("slow").name).toBe("GitMirrorTimeoutError");
    expect(new GitMirrorAuthError("denied").name).toBe("GitMirrorAuthError");
  });
});

describe("GitMirrorManager — SSH auth failure heuristic (isLikelySshAuthFailure)", () => {
  it.each([
    "git@github.com: Permission denied (publickey).",
    "Permission denied, please try again.",
    "Permission denied (publickey,password,keyboard-interactive).",
    // Real multi-line stderr: host-key reject still classifies as auth
    // (matched by `Host key verification failed`, not by the trailing
    // `Could not read from remote repository` line — that line on its own
    // is no longer a signal).
    "Host key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
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
    // `fatal: Could not read from remote repository.` on its own is not an
    // auth signal — git appends it to every SSH transport failure, including
    // network ones. Matching it would re-classify the multi-line network
    // cases below as auth failures and trigger a useless HTTPS retry.
    "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    // Real multi-line stderr observed when port 22 is blocked / GitHub SSH
    // is briefly unreachable. The `Connection timed out` (or refused / DNS)
    // line carries the real cause; the `Could not read from remote` tail
    // is git's generic post-failure boilerplate, not an auth fingerprint.
    "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.",
    "ssh: Could not resolve hostname github.com: Name or service not known\nfatal: Could not read from remote repository.",
    // HTTPS-side failures — should NOT be misclassified as SSH.
    "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
    "fatal: could not read Username for 'https://github.com'",
  ])("does NOT match: %s", (msg) => {
    expect(isLikelySshAuthFailure(msg)).toBe(false);
  });
});

describe("GitMirrorManager — transient network error heuristic (isLikelyTransientNetworkError)", () => {
  it.each([
    // The canonical session-resume failure that motivated the retry path —
    // verbatim from the operator-reported chat error.
    "git fetch --prune origin exited with code 128: fatal: unable to access 'https://github.com/agent-team-foundation/first-tree/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
    "fatal: unable to access 'https://github.com/foo/bar/': OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 54",
    "fatal: unable to access 'https://github.com/x/y/': Recv failure: Connection reset by peer",
    "fatal: unable to access 'https://github.com/x/y/': Failed to connect to 127.0.0.1 port 6152: Connection refused",
    "fatal: unable to access 'https://github.com/x/y/': Operation timed out after 30000 milliseconds",
    "fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com",
    "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
    "fatal: the remote end hung up unexpectedly\nfatal: early EOF\nfatal: index-pack failed",
    "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: PROTOCOL_ERROR (err 1)",
    "error: RPC failed; HTTP 500 curl 22",
    "fatal: unexpected disconnect while reading sideband packet",
    "fetch-pack: unexpected disconnect while reading sideband packet",
    "fatal: TLS handshake failed",
    "GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
    "transfer closed with outstanding read data remaining",
    "ssh: connect to host github.com port 22: Network is unreachable",
    // Multi-line SSH transport timeout (port 22 blocked or briefly
    // unreachable). Real chat-reported failure shape. Used to be hidden
    // behind the over-broad SSH auth heuristic (`Could not read from
    // remote repository` matched as auth, suppressing transient retry);
    // now flows through this path so the next attempt sees the network
    // recover instead of surfacing as a `Session resume failed` to chat.
    "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    // Raw OpenSSL form for a TLS connection the peer closed mid-stream —
    // distinct from `SSL_ERROR_SYSCALL` and distinct from the cert-verify
    // failures (negative case below). Narrow pattern by design.
    "fatal: unable to access 'https://github.com/x/y/': error:0A000126:SSL routines::unexpected eof while reading",
  ])("matches transient network error: %s", (msg) => {
    expect(isLikelyTransientNetworkError(msg)).toBe(true);
  });

  it.each([
    "",
    // Credential failures must NOT be retried — they go through the protocol
    // fallback path, not the same-protocol retry loop.
    "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
    "fatal: could not read Username for 'https://github.com'",
    "remote: HTTP Basic: Access denied",
    "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 401",
    "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 403",
    "git@github.com: Permission denied (publickey).",
    "Host key verification failed.",
    // Even a stderr that mentions a transient-looking word should be classified
    // as credential when the credential pattern matches — switching protocol
    // is the right move, not retrying the same one.
    "fatal: Authentication failed for 'https://github.com/x.git/': SSL connection established",
    // Deterministic content errors — retrying won't help.
    "fatal: repository 'https://example.com/none.git/' not found",
    "fatal: couldn't find remote ref refs/heads/missing",
    // TLS trust failures — retrying would mask the real misconfiguration and
    // burn the full retry budget on a deterministic error. Covers the
    // user-friendly form, the raw OpenSSL form (the regression Codex flagged
    // on PR #548 — earlier `/SSL routines/i` pattern swept this up as
    // transient), and the common variants (expired cert, missing CA bundle).
    "fatal: unable to access 'https://example.com/x.git/': SSL certificate problem: self signed certificate",
    "fatal: unable to access 'https://example.com/x.git/': server certificate verification failed.",
    "fatal: unable to access 'https://example.com/x.git/': error:0A000086:SSL routines::certificate verify failed",
    "fatal: unable to access 'https://example.com/x.git/': error:0A000412:SSL routines::sslv3 alert bad certificate",
    "fatal: unable to access 'https://example.com/x.git/': SSL certificate problem: unable to get local issuer certificate",
    "fatal: unable to access 'https://example.com/x.git/': SSL certificate problem: certificate has expired",
    // Our own per-call timeout — retrying with a fresh full budget is the
    // wrong policy; the op was either making progress or wasn't.
    "git fetch --prune origin timed out after 300000ms",
    // Repo-state / local errors.
    "fatal: index file corrupt",
    "error: Could not write config file",
  ])("does NOT match: %s", (msg) => {
    expect(isLikelyTransientNetworkError(msg)).toBe(false);
  });
});

describe("GitMirrorManager — retryOnTransientNetwork policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const transientErr = new Error("LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443");
  const credentialErr = new Error("fatal: Authentication failed for 'https://github.com/foo.git/'");
  const isRetryable = isLikelyTransientNetworkError;

  /**
   * Drive an async expression to completion under fake timers. Each iteration
   * flushes microtasks (so the awaited `setTimeout` registers its scheduler
   * call) and then drains pending timers. Stops when the promise settles.
   * Mirrors the pattern in sdk-retry.test.ts so behaviour is comparable.
   */
  async function flush<T>(promise: Promise<T>, maxFlushes = 50): Promise<T> {
    let settled = false;
    let result: T | undefined;
    let error: unknown;
    promise.then(
      (v) => {
        result = v;
        settled = true;
      },
      (e) => {
        error = e;
        settled = true;
      },
    );
    for (let i = 0; i < maxFlushes && !settled; i++) {
      await Promise.resolve();
      await vi.runAllTimersAsync();
    }
    if (!settled) throw new Error("flush: promise never settled within maxFlushes iterations");
    if (error !== undefined) throw error;
    return result as T;
  }

  it("returns the first success without sleeping", async () => {
    const op = vi.fn().mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    const result = await flush(retryOnTransientNetwork(op, { delaysMs: [500, 1500, 3000], isRetryable, onRetry }));
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a transient failure up to 4 attempts (1 + 3) and then surfaces it", async () => {
    const op = vi.fn().mockRejectedValue(transientErr);
    const onRetry = vi.fn();
    await expect(
      flush(retryOnTransientNetwork(op, { delaysMs: [500, 1500, 3000], isRetryable, onRetry })),
    ).rejects.toThrow(transientErr);
    expect(op).toHaveBeenCalledTimes(4);
    // 3 retries scheduled → 3 onRetry callbacks
    expect(onRetry).toHaveBeenCalledTimes(3);
    const recordedDelays = onRetry.mock.calls.map((c) => (c[0] as { nextDelayMs: number }).nextDelayMs);
    // Each scheduled delay must be ≥ the base and within 25% jitter window.
    expect(recordedDelays[0]).toBeGreaterThanOrEqual(500);
    expect(recordedDelays[0]).toBeLessThanOrEqual(500 + Math.floor(500 / 4));
    expect(recordedDelays[1]).toBeGreaterThanOrEqual(1500);
    expect(recordedDelays[1]).toBeLessThanOrEqual(1500 + Math.floor(1500 / 4));
    expect(recordedDelays[2]).toBeGreaterThanOrEqual(3000);
    expect(recordedDelays[2]).toBeLessThanOrEqual(3000 + Math.floor(3000 / 4));
  });

  it("recovers when a transient failure is followed by a success", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    const result = await flush(retryOnTransientNetwork(op, { delaysMs: [500, 1500, 3000], isRetryable, onRetry }));
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-transient (credential) failure", async () => {
    const op = vi.fn().mockRejectedValue(credentialErr);
    const onRetry = vi.fn();
    await expect(
      flush(retryOnTransientNetwork(op, { delaysMs: [500, 1500, 3000], isRetryable, onRetry })),
    ).rejects.toThrow(credentialErr);
    expect(op).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("propagates the original error instance unchanged so downstream `instanceof` checks still work", async () => {
    // The fetchOrigin SSH fallback path does `direction.shouldRetry(primaryMessage)`
    // on the terminal error — if the retry helper wrapped the error in something
    // else, the fallback classifier would see the wrapper's message instead of
    // the underlying git stderr and silently miscategorise the failure.
    class AuthErr extends Error {
      readonly tag = "auth";
    }
    const original = new AuthErr("fatal: Authentication failed for 'https://github.com/x.git/'");
    const op = vi.fn().mockRejectedValue(original);
    await expect(flush(retryOnTransientNetwork(op, { delaysMs: [500, 1500], isRetryable }))).rejects.toBe(original);
  });

  it("with an empty delays array, makes exactly one attempt (no retries)", async () => {
    const op = vi.fn().mockRejectedValue(transientErr);
    await expect(flush(retryOnTransientNetwork(op, { delaysMs: [], isRetryable }))).rejects.toThrow(transientErr);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original error when a sparse retry delay is missing", async () => {
    const op = vi.fn().mockRejectedValue(transientErr);
    const sparseDelays: number[] = [];
    sparseDelays.length = 1;

    await expect(flush(retryOnTransientNetwork(op, { delaysMs: sparseDelays, isRetryable }))).rejects.toThrow(
      transientErr,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("handles non-Error throwables by classifying via String(value)", async () => {
    const op = vi.fn().mockRejectedValue("LibreSSL SSL_connect: SSL_ERROR_SYSCALL");
    const onRetry = vi.fn();
    await expect(flush(retryOnTransientNetwork(op, { delaysMs: [500], isRetryable, onRetry }))).rejects.toBe(
      "LibreSSL SSL_connect: SSL_ERROR_SYSCALL",
    );
    expect(op).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("GitMirrorManager — hubManagedRoots safety guards", () => {
  it("isUnderManagedRoot returns false when target === root (refuses to nuke the managed root itself)", () => {
    // Without this guard, a caller that accidentally passes the managed root
    // as a worktree target would let the self-heal branch `rm -rf` the entire
    // `<dataDir>/workspaces` tree (every agent, every session). Worktree
    // targets always sit at least two levels deeper; the exact-match case is
    // never a legitimate request.
    expect(isUnderManagedRoot("/data/ws", ["/data/ws"])).toBe(false);
    expect(isUnderManagedRoot("/data/ws/", ["/data/ws"])).toBe(false);
  });

  it("isUnderManagedRoot returns true for proper descendants", () => {
    expect(isUnderManagedRoot("/data/ws/agent/chat/repo", ["/data/ws"])).toBe(true);
    expect(isUnderManagedRoot("/data/ws/a", ["/data/ws"])).toBe(true);
  });

  it("isUnderManagedRoot returns false for siblings whose name shares a prefix (path traversal guard)", () => {
    // `/data/ws-evil` looks like a sibling of `/data/ws` and a naive
    // `startsWith` check would say it's "inside" — the helper uses `relative`
    // so the result starts with `..` and is correctly rejected.
    expect(isUnderManagedRoot("/data/ws-evil/agent", ["/data/ws"])).toBe(false);
    expect(isUnderManagedRoot("/elsewhere/repo", ["/data/ws"])).toBe(false);
  });

  it("createGitMirrorManager throws when a managed root is outside dataDir (fail-loud against weaponised config)", () => {
    // The dangerous shapes: `["/"]`, `[os.homedir()]`, `[tmpdir()]`. Each one
    // would let the createWorktree self-heal branch `rm -rf` arbitrary host
    // paths. Catch them at construction so the operator sees a startup error
    // rather than a quiet, much-later data-loss event.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-guard-"));
    try {
      expect(() => createGitMirrorManager({ dataDir, hubManagedRoots: ["/"] })).toThrow(GitMirrorError);
      expect(() => createGitMirrorManager({ dataDir, hubManagedRoots: [join(dataDir, "..", "elsewhere")] })).toThrow(
        GitMirrorError,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("createGitMirrorManager aggregates multiple bad roots into one error (operator sees full picture)", () => {
    // Without aggregation an operator who misconfigured 3 roots would have to
    // fix-restart-fix-restart-fix-restart. The combined message names every
    // offending entry up front.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-guard-multi-"));
    try {
      const validRoot = join(dataDir, "workspaces");
      const badA = "/";
      const badB = join(dataDir, "..", "elsewhere");
      expect.assertions(3);
      try {
        createGitMirrorManager({ dataDir, hubManagedRoots: [badA, validRoot, badB] });
      } catch (err) {
        expect(err).toBeInstanceOf(GitMirrorError);
        const msg = err instanceof Error ? err.message : String(err);
        // Both bad roots present; the valid one is NOT in the message.
        expect(msg).toContain(badA);
        expect(msg).toContain("2 entries");
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("createGitMirrorManager throws when a managed root equals dataDir itself", () => {
    // Granting `dataDir` as a managed root would expose `git-mirrors/`,
    // `chats/`, `images/`, etc. to the self-heal rm -rf — too broad. The
    // root must be a STRICT subdir.
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-guard-"));
    try {
      expect(() => createGitMirrorManager({ dataDir, hubManagedRoots: [dataDir] })).toThrow(GitMirrorError);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("createGitMirrorManager accepts a strict subdir of dataDir (the production wiring)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-guard-"));
    try {
      expect(() => createGitMirrorManager({ dataDir, hubManagedRoots: [join(dataDir, "workspaces")] })).not.toThrow();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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
    expect(httpsToSshBaseRewrite("https://[bad")).toBeNull();
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

  it("maps ssh:// URL form without an explicit username", () => {
    expect(sshToHttpsBaseRewrite("ssh://github.com/owner/repo.git")).toEqual({
      sshBase: "ssh://github.com/",
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
    expect(sshToHttpsBaseRewrite("ssh://[bad")).toBeNull();
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

  // 30s vitest timeout: `Connection refused` is in the transient-retry set
  // (intentionally — localhost-proxy listeners commonly bounce), so this
  // test now eats the full ~5s of retry sleeps plus 4 × git-curl-fail-fast
  // attempts before reaching the terminal assertion. On Linux dev machines
  // that pushes wall-clock to ~15s, past vitest's default 5s testTimeout.
  // CI Linux runners aren't affected, but cross-platform portability
  // matters — see PR #548 review feedback.
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
  }, 30_000);
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

  it("retries createWorktree when git reports config.lock contention", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-config-lock-"));
    const { spies, log } = makeLogSpies();
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, log });
    createFakeBareMirror(dataDir, fixtureUrl);
    const target = join(workRoot, "config-lock-retry");
    const counter = join(dataDir, "worktree-add-count");

    await withFakePath(
      {
        git: `#!/bin/sh
case "$*" in
  *"worktree prune"*) exit 0 ;;
  *"rev-parse --verify --quiet refs/heads/"*) exit 1 ;;
  *"cat-file -e"*) exit 0 ;;
  *"worktree add -b"*)
    count=$(/bin/cat "${counter}" 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > "${counter}"
    if [ "$count" = "1" ]; then
      echo "error: could not lock config file config.lock" >&2
      exit 255
    fi
    /bin/mkdir -p "$5"
    exit 0
    ;;
  *"rev-parse HEAD"*) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0 ;;
  *) exit 0 ;;
esac
`,
      },
      async () => {
        const result = await m.createWorktree({
          url: fixtureUrl,
          ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          targetPath: target,
          sessionKey: "lock-chat",
          agentName: "agent-x",
        });
        expect(result.headCommit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      },
    );

    expect(existsSync(target)).toBe(true);
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gitUrl: fixtureUrl, branchName: expect.stringMatching(/^hub-session-/), attempt: 1 }),
      "worktree add hit config lock contention — retrying",
    );
    rmSync(dataDir, { recursive: true, force: true });
  });
});
