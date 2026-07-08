import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asString,
  discoverWorkspaceRepos,
  ensureTrailingNewline,
  findGitRoot,
  isGitRepoRoot,
  isRecord,
  normalizeRemoteForMatch,
  parseGitHubRemoteUrl,
  readGitRemoteUrl,
  readJson,
  repoNameForRoot,
  resolveRepoRoot,
  runCommand,
  slugifyToken,
  writeJson,
} from "../commands/tree/shared.js";

const tempDirs: string[] = [];
const originalGitDir = process.env.GIT_DIR;
const originalGitWorkTree = process.env.GIT_WORK_TREE;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-shared-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterEach(() => {
  if (originalGitDir === undefined) {
    delete process.env.GIT_DIR;
  } else {
    process.env.GIT_DIR = originalGitDir;
  }
  if (originalGitWorkTree === undefined) {
    delete process.env.GIT_WORK_TREE;
  } else {
    process.env.GIT_WORK_TREE = originalGitWorkTree;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree shared primitives", () => {
  it("normalizes simple values and GitHub remotes", () => {
    expect(ensureTrailingNewline("")).toBe("");
    expect(ensureTrailingNewline("hello")).toBe("hello\n");
    expect(ensureTrailingNewline("hello\n")).toBe("hello\n");
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("nope")).toBe(false);
    expect(asString("value")).toBe("value");
    expect(asString("")).toBeUndefined();
    expect(asString(1)).toBeUndefined();
    expect(slugifyToken("  Acme API!! ")).toBe("acme-api");
    expect(slugifyToken("!!!")).toBe("workspace");

    expect(parseGitHubRemoteUrl(" https://github.com/Owner/Repo.git ")).toEqual({
      host: "github.com",
      owner: "Owner",
      repo: "Repo",
    });
    expect(parseGitHubRemoteUrl("git@github.com:Owner/Repo.git")).toEqual({
      host: "github.com",
      owner: "Owner",
      repo: "Repo",
    });
    expect(parseGitHubRemoteUrl("ssh://git@github.example/Owner/Repo.git")).toEqual({
      host: "github.example",
      owner: "Owner",
      repo: "Repo",
    });
    expect(parseGitHubRemoteUrl("")).toBeNull();
    expect(parseGitHubRemoteUrl("not a remote")).toBeNull();
    expect(normalizeRemoteForMatch("https://github.com/Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(normalizeRemoteForMatch("local.git")).toBe("local");
  });

  it("reads and writes JSON defensively", () => {
    const root = makeTempDir();
    const path = join(root, "nested", "value.json");

    expect(readJson(path)).toBeUndefined();
    mkdirSync(path, { recursive: true });
    expect(readJson(path)).toBeUndefined();
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, "{broken", "utf8");
    expect(readJson(path)).toBeUndefined();

    writeJson(path, { ok: true, value: 3 });
    expect(readJson(path)).toEqual({ ok: true, value: 3 });
  });

  it("runs commands with git environment variables stripped", () => {
    const root = makeTempDir();
    process.env.GIT_DIR = "leaked";
    process.env.GIT_WORK_TREE = "leaked";

    const out = runCommand(
      process.execPath,
      ["-e", "console.log((process.env.GIT_DIR || 'clean') + ':' + (process.env.GIT_WORK_TREE || 'clean'))"],
      root,
    );

    expect(out).toBe("clean:clean");
  });

  it("resolves git roots, repo names, and remotes", () => {
    const root = makeTempDir();
    const repo = join(root, "repo");
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "remote", "add", "origin", "git@github.com:Acme/App.git");

    expect(isGitRepoRoot(repo)).toBe(true);
    expect(isGitRepoRoot(root)).toBe(false);
    expect(findGitRoot(nested)).toBe(resolve(repo));
    expect(resolveRepoRoot(nested)).toBe(resolve(repo));
    expect(resolveRepoRoot(root)).toBe(resolve(root));
    expect(repoNameForRoot(repo)).toBe("repo");
    expect(repoNameForRoot("/")).toBe("repo");
    expect(readGitRemoteUrl(repo)).toBe("git@github.com:Acme/App.git");
    expect(readGitRemoteUrl(root)).toBeUndefined();
  });

  it("discovers nested git repositories while skipping generated directories", () => {
    const root = makeTempDir();
    const workspace = join(root, "workspace");
    const app = join(workspace, "packages", "app");
    const docs = join(workspace, "docs");
    const ignored = join(workspace, "node_modules", "dep");
    const filePath = join(workspace, "README.md");
    mkdirSync(app, { recursive: true });
    mkdirSync(docs, { recursive: true });
    mkdirSync(ignored, { recursive: true });
    writeFileSync(filePath, "# workspace\n", "utf8");
    git(workspace, "init", "-b", "main");
    git(app, "init", "-b", "main");
    git(docs, "init", "-b", "main");
    git(ignored, "init", "-b", "main");

    expect(discoverWorkspaceRepos(workspace)).toEqual([
      {
        kind: "nested-git-repo",
        name: "docs",
        relativePath: "docs",
        root: resolve(docs),
      },
      {
        kind: "nested-git-repo",
        name: "app",
        relativePath: "packages/app",
        root: resolve(app),
      },
    ]);
    expect(discoverWorkspaceRepos(join(root, "missing"))).toEqual([]);
  });
});
