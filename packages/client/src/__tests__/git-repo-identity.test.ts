import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearGitRepoIdentityCacheForTests,
  findGitRepoRoot,
  gitRemoteOriginUrl,
  gitRepoRootMatchingRemote,
} from "../runtime/git-repo-identity.js";

const TREE_URL_HTTPS = "https://github.com/acme/first-tree-context.git";
const TREE_URL_SSH = "git@github.com:acme/first-tree-context.git";
const SOURCE_URL = "https://github.com/acme/first-tree.git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args])
    .toString("utf8")
    .trim();
}

describe("git-repo-identity", () => {
  let root: string;
  let treeClone: string;

  beforeEach(() => {
    clearGitRepoIdentityCacheForTests();
    root = mkdtempSync(join(tmpdir(), "first-tree-repo-identity-"));
    treeClone = join(root, "tree-clone");
    mkdirSync(treeClone, { recursive: true });
    git(root, "init", "tree-clone");
    git(treeClone, "config", "user.email", "agent@example.com");
    git(treeClone, "config", "user.name", "Agent");
    git(treeClone, "remote", "add", "origin", TREE_URL_SSH);
    writeFileSync(join(treeClone, "NODE.md"), "root");
    git(treeClone, "add", ".");
    git(treeClone, "commit", "-m", "initial");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearGitRepoIdentityCacheForTests();
  });

  it("finds the repo root from a nested path and reads the origin remote", () => {
    mkdirSync(join(treeClone, "members", "alice"), { recursive: true });
    expect(findGitRepoRoot(join(treeClone, "members", "alice"))).toBe(treeClone);
    expect(gitRemoteOriginUrl(treeClone)).toBe(TREE_URL_SSH);
  });

  it("returns null for paths outside any git repo and repos without origin", () => {
    const plain = join(root, "no-repo");
    mkdirSync(plain, { recursive: true });
    expect(findGitRepoRoot(plain)).toBeNull();

    const orphan = join(root, "orphan-repo");
    mkdirSync(orphan, { recursive: true });
    git(root, "init", "orphan-repo");
    expect(gitRemoteOriginUrl(orphan)).toBeNull();
    expect(gitRepoRootMatchingRemote(join(orphan, "x"), TREE_URL_HTTPS)).toBeNull();
  });

  it("matches a checkout whose ssh remote equals the https binding URL", () => {
    expect(gitRepoRootMatchingRemote(join(treeClone, "NODE.md"), TREE_URL_HTTPS)).toBe(treeClone);
  });

  it("matches a linked git worktree (.git file) of the tree repo", () => {
    const linked = join(root, "worktrees", "task-tree");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    git(treeClone, "worktree", "add", linked, "-b", "task-branch");
    expect(findGitRepoRoot(join(linked, "members"))).toBe(linked);
    expect(gitRepoRootMatchingRemote(join(linked, "NODE.md"), TREE_URL_HTTPS)).toBe(linked);
  });

  it("rejects a checkout of a different repo", () => {
    const source = join(root, "source-repo");
    mkdirSync(source, { recursive: true });
    git(root, "init", "source-repo");
    git(source, "remote", "add", "origin", SOURCE_URL);
    expect(gitRepoRootMatchingRemote(join(source, "src", "index.ts"), TREE_URL_HTTPS)).toBeNull();
  });
});
