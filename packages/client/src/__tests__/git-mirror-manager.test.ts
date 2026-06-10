import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeRepoUrl,
  createGitMirrorManager,
  GitMirrorAuthError,
  GitMirrorError,
  type GitMirrorManager,
  GitMirrorTimeoutError,
  GitMirrorWorktreeConflictError,
  hashUrl,
  httpsToSshBaseRewrite,
  isLikelyAuthFailure,
  isLikelyHttpsAuthFailure,
  isLikelySshAuthFailure,
  isLikelyTransientNetworkError,
  protocolFallbackFailure,
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

// ── per-agent-source-repo: standalone clone lifecycle ─────────────────────

/** Build a throwaway bare upstream with two commits on `main`. */
function seedBareRepo(branch = "main"): { url: string; tip: string; prev: string } {
  const dir = mkdtempSync(join(tmpdir(), "ftt-fixt-"));
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  execSync(`git init -q -b ${branch}`, { cwd: seed });
  execSync("git config user.email t@e.com && git config user.name t", { cwd: seed });
  writeFileSync(join(seed, "README.md"), "v1");
  execSync("git add . && git commit -q -m c1", { cwd: seed });
  const prev = execSync("git rev-parse HEAD", { cwd: seed }).toString().trim();
  writeFileSync(join(seed, "README.md"), "v2");
  execSync("git add . && git commit -q -m c2", { cwd: seed });
  const tip = execSync("git rev-parse HEAD", { cwd: seed }).toString().trim();
  const bare = join(dir, "bare.git");
  execSync(`git clone -q --bare ${seed} ${bare}`);
  return { url: bare, tip, prev };
}

/** Push one new commit to `main` of a bare upstream; returns the new tip sha. */
function pushCommit(url: string, marker: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "ftt-push-"));
  execSync(`git clone -q ${url} ${tmp}`);
  execSync("git config user.email t@e.com && git config user.name t", { cwd: tmp });
  writeFileSync(join(tmp, `n-${marker}.txt`), marker);
  execSync(`git add . && git commit -q -m advance-${marker} && git push -q origin main`, { cwd: tmp });
  const sha = execSync("git rev-parse HEAD", { cwd: tmp }).toString().trim();
  rmSync(tmp, { recursive: true, force: true });
  return sha;
}

function newDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ftt-srcrepo-"));
}

describe("GitMirrorManager — source repo lifecycle (per-agent clone)", () => {
  it("ensureSourceRepo clones a fresh standalone repo on the default branch", async () => {
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    const r = await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    expect(r.outcome).toBe("cloned");
    expect(r.branch).toBe("main");
    // A real standalone clone has a `.git` directory, not a worktree `.git` file.
    expect(statSync(join(clonePath, ".git")).isDirectory()).toBe(true);
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(initialMainSha);
  });

  it("is idempotent — re-running with no upstream change reports unchanged", async () => {
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    const r2 = await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    expect(r2.outcome).toBe("unchanged");
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(initialMainSha);
  });

  it("brings the checkout to the latest default branch when upstream advances", async () => {
    const { url, tip } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    const first = await m.ensureSourceRepo({ url, clonePath });
    expect(first.headCommit).toBe(tip);
    const newTip = pushCommit(url, "adv");
    const r = await m.ensureSourceRepo({ url, clonePath });
    expect(r.outcome).toBe("updated");
    expect(r.headCommit).toBe(newTip);
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(newTip);
  });

  it("leaves a dirty checkout at its current commit (skipped-dirty)", async () => {
    const { url, tip } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    await m.ensureSourceRepo({ url, clonePath });
    writeFileSync(join(clonePath, "README.md"), "locally edited");
    const newTip = pushCommit(url, "dirty");
    expect(newTip).not.toBe(tip);
    const r = await m.ensureSourceRepo({ url, clonePath });
    expect(r.outcome).toBe("skipped-dirty");
    expect(r.headCommit).toBe(tip);
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(tip);
  });

  it("skips the update while another live session is using the checkout (skipped-in-use)", async () => {
    const { url, tip } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    await m.ensureSourceRepo({ url, clonePath });
    pushCommit(url, "inuse");
    const r = await m.ensureSourceRepo({ url, clonePath, activelyInUse: true });
    expect(r.outcome).toBe("skipped-in-use");
    expect(r.headCommit).toBe(tip);
  });

  it("checks out an explicit commit SHA detached (no branch chase)", async () => {
    const { url, prev } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    const r = await m.ensureSourceRepo({ url, ref: prev, clonePath });
    expect(r.outcome).toBe("cloned");
    expect(r.branch).toBeUndefined();
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(prev);
  });

  it("reconciles origin url + default branch when the configured url repoints to a different repo", async () => {
    const a = seedBareRepo("main");
    // Repo B has a DIFFERENT default branch name — exercises the origin/HEAD
    // refresh in reconcileOrigin (a plain fetch would leave origin/HEAD on
    // "main", which doesn't exist in B).
    const b = seedBareRepo("trunk");
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    // First materialise against repo A.
    const r1 = await m.ensureSourceRepo({ url: a.url, clonePath });
    expect(r1.headCommit).toBe(a.tip);
    expect(gitIn(clonePath, "config --get remote.origin.url")).toBe(a.url);
    // Re-point the same checkout at repo B → origin url + origin/HEAD reconciled
    // and the clean working tree moves to B's tip on B's default branch.
    const r2 = await m.ensureSourceRepo({ url: b.url, clonePath });
    expect(gitIn(clonePath, "config --get remote.origin.url")).toBe(b.url);
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(b.tip);
    expect(r2.branch).toBe("trunk");
  });

  it("preserves local commits ahead of upstream instead of resetting (skipped-local-commits)", async () => {
    const { url, tip } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    await m.ensureSourceRepo({ url, clonePath });
    // Commit local work on top of main (clean working tree afterwards).
    execSync("git config user.email t@e.com && git config user.name t", { cwd: clonePath });
    writeFileSync(join(clonePath, "local.txt"), "agent work");
    execSync("git add . && git commit -q -m local-work", { cwd: clonePath });
    const localHead = gitIn(clonePath, "rev-parse HEAD");
    // Upstream advances too — the destructive reset would orphan the local commit.
    const upstream = pushCommit(url, "up");
    const r = await m.ensureSourceRepo({ url, clonePath });
    expect(r.outcome).toBe("skipped-local-commits");
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(localHead); // NOT reset
    expect(existsSync(join(clonePath, "local.txt"))).toBe(true);
    expect(localHead).not.toBe(tip);
    expect(upstream).not.toBe(localHead);
  });

  it("degrades to the existing checkout when a SAME-repo fetch fails transiently (stale-offline)", async () => {
    // Issue #865: an existing, usable clone of the SAME repo + a transient
    // network fetch failure must NOT abort — leave the checkout at its current
    // commit and continue on the last-good source so the agent stays answerable.
    //
    // Deterministic repro of the incident shape: build a real standalone clone
    // whose origin ALREADY matches the configured upstream, then point that
    // upstream at an unreachable endpoint so the next fetch fails transiently
    // (connection refused). Because origin already matches the configured url,
    // reconcileOrigin does NOT repoint (this is the "same repo" path, not a
    // repoint). Port 1 ≠ 443 also disables the https→ssh protocol fallback,
    // keeping it a same-protocol transient failure.
    const { url: bare, tip } = seedBareRepo();
    const clonePath = join(newDataDir(), "repo");
    execSync(`git clone -q ${bare} ${clonePath}`);
    const unreachable = "https://127.0.0.1:1/same-repo.git";
    execSync(`git remote set-url origin ${unreachable}`, { cwd: clonePath });
    const m = makeManager();
    const r = await m.ensureSourceRepo({ url: unreachable, clonePath });
    expect(r.outcome).toBe("stale-offline");
    expect(r.headCommit).toBe(tip); // left at current commit, not aborted
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(tip);
    // gitWithNetworkRetry burns its full transient-retry budget (~3 backed-off
    // attempts) before the degrade fires, so allow more than the 5s default.
  }, 30_000);

  it("fails closed when origin is being repointed to a different repo, even on a transient fetch failure", async () => {
    // Boundary flagged by codex-developer + reproduced by QA on issue #865: the
    // degrade must apply only to "same repo, fetch temporarily unavailable", NOT
    // to "configured repo changed but the confirming fetch could not run". Here
    // the configured url repoints to a DIFFERENT repo whose fetch fails
    // transiently — serving repo A's checkout as repo B would be wrong, so this
    // must fail closed.
    const { url, tip } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    const first = await m.ensureSourceRepo({ url, clonePath });
    expect(first.headCommit).toBe(tip);
    await expect(m.ensureSourceRepo({ url: "https://127.0.0.1:1/different.git", clonePath })).rejects.toBeInstanceOf(
      GitMirrorError,
    );
  }, 30_000);

  it("still degrades when the configured ref already matches the checked-out HEAD", async () => {
    // ref is honored: HEAD is at `tip` and config pins `ref` to that same
    // commit, so the degrade does not advertise a HEAD different from `ref`.
    const { url: bare, tip } = seedBareRepo();
    const clonePath = join(newDataDir(), "repo");
    execSync(`git clone -q ${bare} ${clonePath}`); // HEAD at tip
    const unreachable = "https://127.0.0.1:1/same-repo.git";
    execSync(`git remote set-url origin ${unreachable}`, { cwd: clonePath });
    const m = makeManager();
    const r = await m.ensureSourceRepo({ url: unreachable, ref: tip, clonePath });
    expect(r.outcome).toBe("stale-offline");
    expect(r.headCommit).toBe(tip);
  }, 30_000);

  it("fails closed when a transient fetch cannot confirm a configured ref the checkout is not at", async () => {
    // R4 (codex-assistant): the checkout is on `main` (HEAD = tip), config pins
    // `ref` to a different commit (`prev`) that exists locally but is NOT the
    // current HEAD, and the confirming fetch fails transiently. Returning
    // stale-offline would advertise the repo as being at `ref` while serving
    // `tip` — and break the honor-the-pinned-commit-as-is contract. Must fail
    // closed.
    const { url: bare, tip, prev } = seedBareRepo();
    expect(prev).not.toBe(tip);
    const clonePath = join(newDataDir(), "repo");
    execSync(`git clone -q ${bare} ${clonePath}`); // HEAD at tip, prev is an ancestor present locally
    const unreachable = "https://127.0.0.1:1/same-repo.git";
    execSync(`git remote set-url origin ${unreachable}`, { cwd: clonePath });
    const m = makeManager();
    await expect(m.ensureSourceRepo({ url: unreachable, ref: prev, clonePath })).rejects.toBeInstanceOf(GitMirrorError);
  }, 30_000);

  it("still fails closed on a hard (non-transient) fetch failure even with an existing checkout", async () => {
    // Negative case for the stale-offline degrade: a deterministic, non-network
    // failure (repository does not exist) must still bubble up — degrading would
    // mask a real, non-self-healing problem.
    const { url, tip } = seedBareRepo();
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    const first = await m.ensureSourceRepo({ url, clonePath });
    expect(first.headCommit).toBe(tip);
    await expect(
      m.ensureSourceRepo({ url: "file:///first-tree-nonexistent-repo-865.git", clonePath }),
    ).rejects.toBeInstanceOf(GitMirrorError);
  });

  it("throws a conflict for a non-managed occupant with no managed root (preserves operator data)", async () => {
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    mkdirSync(clonePath, { recursive: true });
    writeFileSync(join(clonePath, "stray.txt"), "operator data");
    await expect(m.ensureSourceRepo({ url: fixtureUrl, clonePath })).rejects.toBeInstanceOf(
      GitMirrorWorktreeConflictError,
    );
    expect(existsSync(join(clonePath, "stray.txt"))).toBe(true);
  });

  it("auto-recovers a non-managed occupant inside a managed root", async () => {
    const dataDir = newDataDir();
    const managedRoot = join(dataDir, "workspaces");
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    const clonePath = join(managedRoot, "agent", "repo");
    mkdirSync(clonePath, { recursive: true });
    writeFileSync(join(clonePath, "stray.txt"), "leftover");
    const r = await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    expect(r.outcome).toBe("cloned");
    expect(statSync(join(clonePath, ".git")).isDirectory()).toBe(true);
    expect(existsSync(join(clonePath, "stray.txt"))).toBe(false);
  });

  it("migrates a legacy shared-mirror worktree (.git file) to a standalone clone", async () => {
    const dataDir = newDataDir();
    const managedRoot = join(dataDir, "workspaces");
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    const clonePath = join(managedRoot, "agent", "repo");
    mkdirSync(clonePath, { recursive: true });
    // Simulate the old layout: a `.git` FILE pointing into git-mirrors.
    writeFileSync(join(clonePath, ".git"), "gitdir: /some/old/git-mirrors/deadbeef/worktrees/x\n");
    writeFileSync(join(clonePath, "README.md"), "stale worktree content");
    const r = await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    expect(r.outcome).toBe("migrated-recloned");
    expect(statSync(join(clonePath, ".git")).isDirectory()).toBe(true);
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(initialMainSha);
  });

  it("removeSourceRepo deletes the clone directory", async () => {
    const m = makeManager();
    const clonePath = join(newDataDir(), "repo");
    await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    await m.removeSourceRepo({ clonePath });
    expect(existsSync(clonePath)).toBe(false);
  });

  it("removeSourceRepo kills a holder process inside a managed root before deleting", async () => {
    const dataDir = newDataDir();
    const managedRoot = join(dataDir, "workspaces");
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000, hubManagedRoots: [managedRoot] });
    const clonePath = join(managedRoot, "agent", "repo");
    await m.ensureSourceRepo({ url: fixtureUrl, clonePath });
    const { pid, proc } = await spawnLongLivedChildInDir(clonePath);
    try {
      await withFakeLsofPid(pid, async () => {
        await m.removeSourceRepo({ clonePath });
      });
      expect(await waitForProcessExit(proc, pid)).toBe(true);
      expect(existsSync(clonePath)).toBe(false);
    } finally {
      if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("sweepLegacyMirrors removes the legacy shared git-mirrors tree", async () => {
    const dataDir = newDataDir();
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000 });
    const fake = createFakeBareMirror(dataDir, fixtureUrl);
    expect(existsSync(fake)).toBe(true);
    const swept = await m.sweepLegacyMirrors();
    expect(swept.removed.length).toBeGreaterThan(0);
    expect(existsSync(m.legacyMirrorsRoot)).toBe(false);
  });

  it("sweepLegacyMirrors is a no-op when there is no legacy tree", async () => {
    const m = makeManager();
    const swept = await m.sweepLegacyMirrors();
    expect(swept.removed).toEqual([]);
  });

  it("sweepLegacyMirrors refuses to descend a symlinked cache root (no escape outside dataDir)", async () => {
    const dataDir = newDataDir();
    const m = createGitMirrorManager({ dataDir, cloneTimeoutMs: 30_000 });
    // External dir the cache-root symlink points at — its contents MUST survive.
    const external = mkdtempSync(join(tmpdir(), "ftt-external-"));
    writeFileSync(join(external, "precious.txt"), "do not delete");
    // Replace <dataDir>/git-mirrors with a symlink to the external dir.
    symlinkSync(external, m.legacyMirrorsRoot);

    const swept = await m.sweepLegacyMirrors();

    expect(swept.removed).toEqual([]);
    // Symlink target untouched; only the link entry itself is removed.
    expect(existsSync(join(external, "precious.txt"))).toBe(true);
    expect(existsSync(m.legacyMirrorsRoot)).toBe(false);
    rmSync(external, { recursive: true, force: true });
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

describe("GitMirrorManager — protocol-fallback failure shaping (protocolFallbackFailure)", () => {
  const combined = "Could not clone https://github.com/x/y.git over HTTPS or SSH. …";

  it.each([
    // True double-auth failure: SSH side rejected credentials / host key.
    "git@github.com: Permission denied (publickey).",
    "Host key verification failed.\nfatal: Could not read from remote repository.",
  ])("peer auth-shaped failure → GitMirrorAuthError (no session retry): %s", (peerMessage) => {
    const err = protocolFallbackFailure(combined, peerMessage);
    expect(err).toBeInstanceOf(GitMirrorAuthError);
    expect(err.message).toBe(combined);
  });

  it.each([
    // Peer died for a transient network reason (DNS / VPN / proxy outage that
    // outlasted gitWithNetworkRetry's short budget). Only the primary side is
    // known to be credential-shaped — keep the session-level retry alive.
    "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.",
    "ssh: Could not resolve hostname github.com: Name or service not known",
    "ssh: connect to host github.com port 22: Connection refused",
  ])("peer transient-network failure → plain GitMirrorError (session retry preserved): %s", (peerMessage) => {
    const err = protocolFallbackFailure(combined, peerMessage);
    expect(err).toBeInstanceOf(GitMirrorError);
    expect(err).not.toBeInstanceOf(GitMirrorAuthError);
    expect(err.message).toBe(combined);
  });

  it("peer failure of unrecognised shape stays GitMirrorAuthError (conservative: primary was credential-shaped)", () => {
    const err = protocolFallbackFailure(combined, "fatal: something nobody has seen before");
    expect(err).toBeInstanceOf(GitMirrorAuthError);
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
    // Issue #865 — the two verbatim operator-reported forms that motivated the
    // degrade-on-transient-fetch-failure path. Neither was matched before.
    "git fetch --prune origin exited with code 128: fatal: unable to access 'https://github.com/agent-team-foundation/first-tree/': Error in the HTTP2 framing layer",
    "error: RPC failed; curl 28 Failed to connect to github.com port 443 after 75002 ms: Couldn't connect to server",
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

describe("GitMirrorManager — protocol fallback (clone)", () => {
  it("does NOT classify a non-https failure as auth — clone of an unreachable file:// URL throws raw GitMirrorError", async () => {
    const m = makeManager();
    const clonePath = join(mkdtempSync(join(tmpdir(), "ftt-srcrepo-")), "repo");
    let caught: unknown;
    try {
      await m.ensureSourceRepo({ url: "file:///nonexistent/path/does/not/exist.git", clonePath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitMirrorError);
    expect(caught).not.toBeInstanceOf(GitMirrorAuthError);
  });

  // Port 1 is reserved & always refuses connections → fast deterministic
  // failure, no real network egress. `Connection refused` is in the transient
  // set so this eats the ~5s retry budget before surfacing — keep the 30s cap.
  it("does NOT classify a connect-refused https failure as auth — clone throws raw GitMirrorError", async () => {
    const m = createGitMirrorManager({
      dataDir: mkdtempSync(join(tmpdir(), "ftt-mgr-https-")),
      cloneTimeoutMs: 15_000,
    });
    const clonePath = join(mkdtempSync(join(tmpdir(), "ftt-srcrepo-")), "repo");
    let caught: unknown;
    try {
      await m.ensureSourceRepo({ url: "https://127.0.0.1:1/nope.git", clonePath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitMirrorError);
    expect(caught).not.toBeInstanceOf(GitMirrorAuthError);
  }, 30_000);
});

describe("GitMirrorManager — concurrency", () => {
  it("serialises parallel ensureSourceRepo calls on the same clone path onto a single clone", async () => {
    const m = makeManager();
    const clonePath = join(mkdtempSync(join(tmpdir(), "ftt-srcrepo-")), "repo");
    const [a, b] = await Promise.all([
      m.ensureSourceRepo({ url: fixtureUrl, clonePath }),
      m.ensureSourceRepo({ url: fixtureUrl, clonePath }),
    ]);
    // Exactly one did the cold clone; the other saw the established clone.
    expect([a.outcome, b.outcome].sort()).toEqual(["cloned", "unchanged"]);
    expect(statSync(join(clonePath, ".git")).isDirectory()).toBe(true);
    expect(gitIn(clonePath, "rev-parse HEAD")).toBe(initialMainSha);
  });
});
