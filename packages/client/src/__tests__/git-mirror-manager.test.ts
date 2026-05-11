import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGitMirrorManager,
  deriveSessionBranchName,
  GitMirrorError,
  type GitMirrorManager,
  GitMirrorWorktreeConflictError,
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
    });
    expect(worktreePath).toBe(target);
    expect(headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(branchName).toBe(deriveSessionBranchName("chat-1", fixtureUrl));
    // HEAD should be a symbolic ref to the session branch (not detached).
    expect(gitIn(target, "symbolic-ref HEAD")).toBe(`refs/heads/${branchName}`);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  it("different session keys produce disjoint branches on the same mirror", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const a = join(workRoot, "two-sess-a");
    const b = join(workRoot, "two-sess-b");
    const ra = await m.createWorktree({ url: fixtureUrl, targetPath: a, sessionKey: "chat-A" });
    const rb = await m.createWorktree({ url: fixtureUrl, targetPath: b, sessionKey: "chat-B" });
    expect(ra.branchName).not.toBe(rb.branchName);
    writeFileSync(join(a, "scratch.txt"), "in A only");
    expect(existsSync(join(a, "scratch.txt"))).toBe(true);
    expect(existsSync(join(b, "scratch.txt"))).toBe(false);
  });

  it("createWorktree rejects a non-Hub occupant (D13)", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const occupied = join(workRoot, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "user-data.txt"), "important");
    await expect(
      m.createWorktree({ url: fixtureUrl, targetPath: occupied, sessionKey: "chat-C" }),
    ).rejects.toBeInstanceOf(GitMirrorWorktreeConflictError);
    expect(existsSync(join(occupied, "user-data.txt"))).toBe(true);
  });

  it("removeWorktree deletes both the worktree and the session branch", async () => {
    const m = makeManager();
    const { mirrorPath } = await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "remove-target");
    const { branchName } = await m.createWorktree({
      url: fixtureUrl,
      targetPath: target,
      sessionKey: "chat-rm",
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
    await m.createWorktree({ url: fixtureUrl, targetPath: a, sessionKey: "incident-3-A" });
    await m.createWorktree({ url: fixtureUrl, targetPath: b, sessionKey: "incident-3-B" });
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
    });
    expect(reopened.branchName).toBe(branchName);
    expect(reopened.headCommit).toBe(headCommit);
    expect(existsSync(join(firstTarget, "README.md"))).toBe(true);
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
    });
    // Bypass git's safety net and delete the ref file directly. Works against
    // loose refs; a freshly-created branch never reaches packed-refs.
    const refPath = join(mirrorPath, "refs", "heads", branchName);
    rmSync(refPath, { force: true });

    await expect(
      m.createWorktree({ url: fixtureUrl, targetPath: target, sessionKey: "ghosty" }),
    ).rejects.toBeInstanceOf(GitMirrorError);
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
      m.createWorktree({ url: fixtureUrl, targetPath: a, sessionKey: "conc-A" }),
      m.createWorktree({ url: fixtureUrl, targetPath: b, sessionKey: "conc-B" }),
    ]);
    expect(ra.branchName).not.toBe(rb.branchName);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});
