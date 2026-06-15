import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeWorkspaceStatus,
  discoverWorkspaceRoot,
  pickImmediateWorkspaceSources,
  readGitRemoteUrl,
  readWorkspaceManifest,
  writeWorkspaceManifest,
} from "../core/workspace.js";

let workspaceRoot: string;

function makeWorkspaceManifest(workspaceDir: string, body: object): void {
  mkdirSync(join(workspaceDir, ".first-tree"), { recursive: true });
  writeFileSync(join(workspaceDir, ".first-tree", "workspace.json"), `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

function makeGitRepo(parentDir: string, name: string, options?: { originUrl?: string }): string {
  const repoDir = join(parentDir, name);
  mkdirSync(repoDir, { recursive: true });
  execSync("git init --quiet", { cwd: repoDir });
  if (options?.originUrl !== undefined) {
    execSync(`git remote add origin ${options.originUrl}`, { cwd: repoDir });
  }
  return repoDir;
}

function makeBareGitRepo(parentDir: string, name: string, options?: { originUrl?: string }): string {
  const repoDir = join(parentDir, name);
  mkdirSync(repoDir, { recursive: true });
  execSync("git init --bare --quiet", { cwd: repoDir });
  if (options?.originUrl !== undefined) {
    execSync(`git remote add origin ${options.originUrl}`, { cwd: repoDir });
  }
  return repoDir;
}

function makeNestedGitRepo(parentDir: string, intermediateName: string, repoName: string): string {
  const intermediateDir = join(parentDir, intermediateName);
  mkdirSync(intermediateDir, { recursive: true });
  return makeGitRepo(intermediateDir, repoName);
}

function makeNonGitDir(parentDir: string, name: string): string {
  const dir = join(parentDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-workspace-test-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("discoverWorkspaceRoot", () => {
  it("finds workspace root from the workspace root itself", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "tree", sources: [] });

    expect(discoverWorkspaceRoot(workspaceRoot)).toBe(workspaceRoot);
  });

  it("walks up from a deeply nested cwd", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "tree", sources: ["source-a"] });
    const deep = join(workspaceRoot, "source-a", "src", "nested");
    mkdirSync(deep, { recursive: true });

    expect(discoverWorkspaceRoot(deep)).toBe(workspaceRoot);
  });

  it("returns undefined when no workspace.json is found", () => {
    expect(discoverWorkspaceRoot(workspaceRoot)).toBeUndefined();
  });

  it("returns the closest ancestor when nested workspaces exist", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "outer-tree", sources: [] });
    const innerRoot = join(workspaceRoot, "outer-tree", "embedded");
    mkdirSync(innerRoot, { recursive: true });
    makeWorkspaceManifest(innerRoot, { tree: "inner-tree", sources: [] });

    expect(discoverWorkspaceRoot(innerRoot)).toBe(innerRoot);
    expect(discoverWorkspaceRoot(join(innerRoot, "child"))).toBe(innerRoot);
  });
});

describe("readWorkspaceManifest", () => {
  it("parses a valid manifest", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api", "web"] });

    const manifest = readWorkspaceManifest(workspaceRoot);

    expect(manifest).toEqual({ tree: "context", sources: ["api", "web"] });
  });

  it("rejects a manifest where tree appears in sources", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["context", "api"] });

    expect(() => readWorkspaceManifest(workspaceRoot)).toThrow();
  });

  it("rejects duplicate sources", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api", "api"] });

    expect(() => readWorkspaceManifest(workspaceRoot)).toThrow();
  });

  it("rejects path separators in subdirectory names", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "nested/tree", sources: [] });

    expect(() => readWorkspaceManifest(workspaceRoot)).toThrow();
  });

  it("rejects subdirectory names starting with a dot", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: ".hidden", sources: [] });

    expect(() => readWorkspaceManifest(workspaceRoot)).toThrow();
  });

  it("rejects invalid JSON with an informative message", () => {
    mkdirSync(join(workspaceRoot, ".first-tree"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".first-tree", "workspace.json"), "{ not valid json", "utf-8");

    expect(() => readWorkspaceManifest(workspaceRoot)).toThrow(/Failed to parse/);
  });
});

describe("writeWorkspaceManifest", () => {
  it("creates .first-tree/ if missing and writes a valid manifest", () => {
    writeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api"] });

    const written = readFileSync(join(workspaceRoot, ".first-tree", "workspace.json"), "utf-8");
    expect(JSON.parse(written)).toEqual({ tree: "context", sources: ["api"] });
    expect(written.endsWith("\n")).toBe(true);
  });

  it("refuses to write an invalid manifest and leaves the disk untouched", () => {
    // Note: Zod's type checker would normally reject this at compile-time, but
    // runtime callers (e.g. migration tools deserializing legacy data) can
    // still supply junk. The validator must be a hard runtime gate.
    const invalid = { tree: "context", sources: ["context"] };

    expect(() => writeWorkspaceManifest(workspaceRoot, invalid)).toThrow();
    expect(existsSync(join(workspaceRoot, ".first-tree", "workspace.json"))).toBe(false);
  });
});

describe("computeWorkspaceStatus", () => {
  it("reports tree presence and bound-source presence", () => {
    makeGitRepo(workspaceRoot, "context");
    makeGitRepo(workspaceRoot, "api");
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api", "web"] });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.workspaceRoot).toBe(workspaceRoot);
    expect(status.treePresent).toBe(true);
    expect(status.boundSources).toEqual([
      { name: "api", path: join(workspaceRoot, "api"), present: true },
      { name: "web", path: join(workspaceRoot, "web"), present: false },
    ]);
    expect(status.missingBoundSources).toEqual([{ name: "web", path: join(workspaceRoot, "web"), present: false }]);
  });

  it("resolves bound + unbound BARE source clones under sourcesRoot when set", () => {
    // Agent-managed layout: tree at the workspace root (regular clone), source
    // clones one level down under `source-repos/` as BARE clones (no `.git/`).
    makeGitRepo(workspaceRoot, "context");
    const sourcesDir = join(workspaceRoot, "source-repos");
    makeBareGitRepo(sourcesDir, "api", { originUrl: "git@github.com:acme/api.git" });
    makeBareGitRepo(sourcesDir, "scratch"); // a BARE git repo under source-repos/ not in `sources`
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api", "web"], sourcesRoot: "source-repos" });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.treePresent).toBe(true);
    // A present bound bare clone still resolves its remoteUrl (bare-repo aware).
    expect(status.boundSources).toEqual([
      { name: "api", path: join(sourcesDir, "api"), present: true, remoteUrl: "git@github.com:acme/api.git" },
      { name: "web", path: join(sourcesDir, "web"), present: false },
    ]);
    // A BARE clone (the agent-managed shape, no `.git/`) under source-repos/ is
    // still detected as an unbound sibling.
    expect(status.unboundGitSiblings.map((entry) => entry.name)).toEqual(["scratch"]);
  });

  it("lists an unbound source sibling named like the tree when sourcesRoot is set", () => {
    // Under sourcesRoot the tree lives at <ws>/context (outside source-repos/),
    // so an unbound clone at <ws>/source-repos/context is a real sibling and
    // must NOT be filtered out just because its name equals the tree name.
    makeGitRepo(workspaceRoot, "context"); // tree (regular clone) at the workspace root
    const sourcesDir = join(workspaceRoot, "source-repos");
    makeBareGitRepo(sourcesDir, "context"); // unbound bare clone literally named like the tree
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: [], sourcesRoot: "source-repos" });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.treePresent).toBe(true);
    expect(status.unboundGitSiblings.map((entry) => entry.name)).toEqual(["context"]);
  });

  it("reports tree absent when the tree subdir is missing", () => {
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: [] });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.treePresent).toBe(false);
  });

  it("reports unbound git siblings that are not declared and not the tree", () => {
    makeGitRepo(workspaceRoot, "context");
    makeGitRepo(workspaceRoot, "api");
    makeGitRepo(workspaceRoot, "scratch-fork");
    makeGitRepo(workspaceRoot, "experimental");
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api"] });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.unboundGitSiblings.map((entry) => entry.name)).toEqual(["experimental", "scratch-fork"]);
  });

  it("ignores non-git directories and dotfiles when listing unbound siblings", () => {
    makeGitRepo(workspaceRoot, "context");
    makeNonGitDir(workspaceRoot, "docs");
    mkdirSync(join(workspaceRoot, ".cache"), { recursive: true });
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: [] });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.unboundGitSiblings).toEqual([]);
  });

  it("reports remote URLs for tree, bound sources, and unbound siblings when configured", () => {
    makeGitRepo(workspaceRoot, "context", { originUrl: "git@github.com:acme/context.git" });
    makeGitRepo(workspaceRoot, "api", { originUrl: "https://github.com/acme/api.git" });
    makeGitRepo(workspaceRoot, "web");
    makeGitRepo(workspaceRoot, "scratch", { originUrl: "git@github.com:acme/scratch.git" });
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api", "web"] });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.treeRemoteUrl).toBe("git@github.com:acme/context.git");
    expect(status.boundSources.find((entry) => entry.name === "api")?.remoteUrl).toBe(
      "https://github.com/acme/api.git",
    );
    expect(status.boundSources.find((entry) => entry.name === "web")?.remoteUrl).toBeUndefined();
    expect(status.unboundGitSiblings.find((entry) => entry.name === "scratch")?.remoteUrl).toBe(
      "git@github.com:acme/scratch.git",
    );
  });

  it("omits remoteUrl fields entirely when no origin is configured", () => {
    makeGitRepo(workspaceRoot, "context");
    makeGitRepo(workspaceRoot, "api");
    makeWorkspaceManifest(workspaceRoot, { tree: "context", sources: ["api"] });

    const status = computeWorkspaceStatus(workspaceRoot);

    expect(status.treeRemoteUrl).toBeUndefined();
    expect("remoteUrl" in status.boundSources[0]).toBe(false);
  });
});

describe("pickImmediateWorkspaceSources", () => {
  it("returns immediate-child git repos sorted, excluding the tree", () => {
    makeGitRepo(workspaceRoot, "context");
    makeGitRepo(workspaceRoot, "web");
    makeGitRepo(workspaceRoot, "api");

    const sources = pickImmediateWorkspaceSources(workspaceRoot, "context");

    expect(sources).toEqual(["api", "web"]);
  });

  it("does NOT collapse nested git repos under non-git intermediate dirs to their basename", () => {
    // Regression: yuezengwu / baixiaohang / codex / code-reviewer all caught
    // this on PR-2. `discoverWorkspaceRepos` walks recursively, so a repo at
    // `packages/api/.git` was being recorded as `api` in workspace.json.sources,
    // a violation of the schema's immediate-child contract.
    makeGitRepo(workspaceRoot, "context");
    makeNestedGitRepo(workspaceRoot, "packages", "api");
    makeNestedGitRepo(workspaceRoot, "vendor/foo", "some-repo");

    const sources = pickImmediateWorkspaceSources(workspaceRoot, "context");

    expect(sources).toEqual([]);
  });

  it("ignores non-git directories at the immediate level", () => {
    makeGitRepo(workspaceRoot, "context");
    makeNonGitDir(workspaceRoot, "docs");
    makeNonGitDir(workspaceRoot, "scripts");

    const sources = pickImmediateWorkspaceSources(workspaceRoot, "context");

    expect(sources).toEqual([]);
  });

  it("ignores dotfiles at the immediate level", () => {
    makeGitRepo(workspaceRoot, "context");
    mkdirSync(join(workspaceRoot, ".cache"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".first-tree"), { recursive: true });
    makeGitRepo(workspaceRoot, "api");

    const sources = pickImmediateWorkspaceSources(workspaceRoot, "context");

    expect(sources).toEqual(["api"]);
  });

  it("honors the excludeNames set", () => {
    makeGitRepo(workspaceRoot, "context");
    makeGitRepo(workspaceRoot, "api");
    makeGitRepo(workspaceRoot, "web");

    const sources = pickImmediateWorkspaceSources(workspaceRoot, "context", new Set(["web"]));

    expect(sources).toEqual(["api"]);
  });
});

describe("readGitRemoteUrl", () => {
  it("returns the origin URL when configured", () => {
    const repo = makeGitRepo(workspaceRoot, "api", { originUrl: "git@github.com:acme/api.git" });

    expect(readGitRemoteUrl(repo)).toBe("git@github.com:acme/api.git");
  });

  it("returns undefined when origin is not configured", () => {
    const repo = makeGitRepo(workspaceRoot, "api");

    expect(readGitRemoteUrl(repo)).toBeUndefined();
  });

  it("returns undefined when the directory is not a git repo", () => {
    const dir = makeNonGitDir(workspaceRoot, "not-a-repo");

    expect(readGitRemoteUrl(dir)).toBeUndefined();
  });

  it("returns undefined when the directory does not exist", () => {
    expect(readGitRemoteUrl(join(workspaceRoot, "does-not-exist"))).toBeUndefined();
  });
});
