import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeWorkspaceStatus,
  discoverWorkspaceRoot,
  readWorkspaceManifest,
  writeWorkspaceManifest,
} from "../core/workspace.js";

let workspaceRoot: string;

function makeWorkspaceManifest(workspaceDir: string, body: object): void {
  mkdirSync(join(workspaceDir, ".first-tree"), { recursive: true });
  writeFileSync(join(workspaceDir, ".first-tree", "workspace.json"), `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

function makeGitRepo(parentDir: string, name: string): string {
  const repoDir = join(parentDir, name);
  mkdirSync(repoDir, { recursive: true });
  execSync("git init --quiet", { cwd: repoDir });
  return repoDir;
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
});
