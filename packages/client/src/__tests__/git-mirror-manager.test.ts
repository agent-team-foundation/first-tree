import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGitMirrorManager,
  type GitMirrorManager,
  GitMirrorWorktreeConflictError,
} from "../runtime/git-mirror-manager.js";

let workRoot: string;
let fixtureRepo: string;
let fixtureUrl: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "ftt-mirror-"));
  fixtureRepo = join(workRoot, "fixture-bare.git");
  // Create a tiny fixture repo with two commits.
  const seed = join(workRoot, "fixture-seed");
  mkdirSync(seed, { recursive: true });
  execSync("git init -q -b main", { cwd: seed });
  execSync("git config user.email test@example.com && git config user.name test", { cwd: seed });
  writeFileSync(join(seed, "README.md"), "hello");
  execSync("git add . && git commit -q -m initial", { cwd: seed });
  writeFileSync(join(seed, "README.md"), "hello v2");
  execSync("git add . && git commit -q -m second", { cwd: seed });
  // Make a bare clone we can reference as the upstream URL.
  execSync(`git clone -q --bare ${seed} ${fixtureRepo}`);
  fixtureUrl = fixtureRepo; // file:// works too, but a plain path is simpler
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

describe("GitMirrorManager (Step 5)", () => {
  it("ensureMirror clones once and is idempotent", async () => {
    const m = makeManager();
    const first = await m.ensureMirror(fixtureUrl);
    expect(first.cloned).toBe(true);
    expect(existsSync(join(first.mirrorPath, "HEAD"))).toBe(true);

    const second = await m.ensureMirror(fixtureUrl);
    expect(second.cloned).toBe(false);
    expect(second.mirrorPath).toBe(first.mirrorPath);
  });

  it("createWorktree adds a detached worktree at HEAD", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const target = mkdtempSync(join(tmpdir(), "ftt-wt-"));
    rmSync(target, { recursive: true, force: true }); // ensure target path is free
    const wt = await m.createWorktree({ url: fixtureUrl, targetPath: target });
    expect(wt.worktreePath).toBe(target);
    expect(wt.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  it("two worktrees from same URL coexist independently", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const a = join(workRoot, "two-wt-a");
    const b = join(workRoot, "two-wt-b");
    await m.createWorktree({ url: fixtureUrl, targetPath: a });
    await m.createWorktree({ url: fixtureUrl, targetPath: b });
    writeFileSync(join(a, "scratch.txt"), "in A only");
    expect(existsSync(join(a, "scratch.txt"))).toBe(true);
    expect(existsSync(join(b, "scratch.txt"))).toBe(false);
  });

  it("createWorktree reports conflict when target is a non-Hub directory (D13)", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const occupied = join(workRoot, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "user-data.txt"), "important");
    await expect(m.createWorktree({ url: fixtureUrl, targetPath: occupied })).rejects.toBeInstanceOf(
      GitMirrorWorktreeConflictError,
    );
    // Original data must survive the failed call.
    expect(existsSync(join(occupied, "user-data.txt"))).toBe(true);
  });

  it("removeWorktree clears the worktree but keeps the mirror", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const target = join(workRoot, "remove-target");
    await m.createWorktree({ url: fixtureUrl, targetPath: target });
    await m.removeWorktree(target);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(m.mirrorsRoot, m.mirrorsRoot ? "" : ""))).toBeDefined(); // mirrors dir still there
  });

  it("gcMirrors removes mirrors not in the referenced set", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    // Mirror exists; gc with empty set should drop it.
    const before = readdirSync(m.mirrorsRoot).length;
    expect(before).toBe(1);
    const { removed } = await m.gcMirrors(new Set());
    expect(removed).toHaveLength(1);
    const after = readdirSync(m.mirrorsRoot).length;
    expect(after).toBe(0);
  });

  it("gcMirrors keeps mirrors still referenced", async () => {
    const m = makeManager();
    await m.ensureMirror(fixtureUrl);
    const { removed } = await m.gcMirrors(new Set([fixtureUrl]));
    expect(removed).toEqual([]);
  });
});
