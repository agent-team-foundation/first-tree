import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeWorkspaceRoot } from "../src/commands/tree/init.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), "gitdir: /tmp/mock\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("initializeWorkspaceRoot", () => {
  it("scaffolds a sibling tree, writes workspace.json, and installs workspace-root framework", () => {
    const workspaceRoot = makeTempDir("first-tree-init-workspace-");
    const sourceName = "source-a";
    makeGitRepo(join(workspaceRoot, sourceName));
    const treeName = `${basename(workspaceRoot)}-tree`;

    const summary = initializeWorkspaceRoot(workspaceRoot, {
      scope: "workspace",
      treeMode: "dedicated",
      treePath: `./${treeName}`,
    });

    expect(summary.bindingMode).toBe("workspace-root");
    expect(summary.treeMode).toBe("dedicated");
    expect(summary.treeRoot).toBe(join(workspaceRoot, treeName));
    expect(summary.workspaceManifest.tree).toBe(treeName);
    expect(summary.workspaceManifest.sources).toEqual([sourceName]);

    expect(readFileSync(join(workspaceRoot, ".first-tree", "workspace.json"), "utf8")).toContain(treeName);
    expect(readFileSync(join(workspaceRoot, "AGENTS.md"), "utf8")).toContain("First Tree integration");
    expect(readFileSync(join(workspaceRoot, "CLAUDE.md"), "utf8")).toContain("First Tree integration");
    expect(existsSync(join(workspaceRoot, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspaceRoot, ".claude", "skills", "first-tree"))).toBe(true);

    expect(existsSync(join(summary.treeRoot, "NODE.md"))).toBe(true);
    expect(readFileSync(join(summary.treeRoot, ".first-tree", "agent-templates", "developer.yaml"), "utf8")).toContain(
      "name: developer",
    );
    expect(
      readFileSync(join(summary.treeRoot, ".first-tree", "agent-templates", "code-reviewer.yaml"), "utf8"),
    ).toContain("name: code-reviewer");
    expect(readFileSync(join(summary.treeRoot, ".first-tree", "org.yaml"), "utf8")).toContain("humanInvolveRules:");
  });

  it("adds skills directories to the workspace .gitignore", () => {
    const workspaceRoot = makeTempDir("first-tree-init-gitignore-");
    makeGitRepo(join(workspaceRoot, "source-a"));

    initializeWorkspaceRoot(workspaceRoot, {
      scope: "workspace",
      treeMode: "dedicated",
      treePath: "./tree",
    });

    const gitignore = readFileSync(join(workspaceRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".agents/skills/");
    expect(gitignore).toContain(".claude/skills/");
    expect(gitignore).toContain(".first-tree/tmp/");
  });

  it("does NOT install per-source framework files in workspace members", () => {
    const workspaceRoot = makeTempDir("first-tree-init-no-cascade-");
    const sourceName = "source-a";
    const sourcePath = join(workspaceRoot, sourceName);
    makeGitRepo(sourcePath);

    initializeWorkspaceRoot(workspaceRoot, {
      scope: "workspace",
      treeMode: "dedicated",
      treePath: "./tree",
    });

    expect(existsSync(join(sourcePath, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(sourcePath, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(sourcePath, ".agents", "skills"))).toBe(false);
    expect(existsSync(join(sourcePath, ".first-tree", "source.json"))).toBe(false);
  });

  it("rejects scope=repo with guidance pointing at the workspace recipe", () => {
    const workspaceRoot = makeTempDir("first-tree-init-repo-scope-");

    expect(() =>
      initializeWorkspaceRoot(workspaceRoot, {
        scope: "repo",
        treeMode: "dedicated",
        treePath: "./tree",
      }),
    ).toThrow("workspace-scope recipe");
  });
});
