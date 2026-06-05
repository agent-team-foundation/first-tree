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
    // PR-A: agent-templates yaml + tree-root WHITEPAPER.md + source-repos.md
    // are dead writes per the post-W1 trailing-edge audit; they must NOT be
    // scaffolded by `tree init` anymore.
    expect(existsSync(join(summary.treeRoot, ".first-tree", "agent-templates"))).toBe(false);
    expect(existsSync(join(summary.treeRoot, "WHITEPAPER.md"))).toBe(false);
    expect(existsSync(join(summary.treeRoot, "source-repos.md"))).toBe(false);
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

  it("derives tree-mode=dedicated when no --tree-url is given (PR-B regression PIN)", () => {
    // Lone-source recipe after PR-B no longer passes `--tree-mode
    // dedicated`. The CLI must infer the same mode from URL absence so
    // the tree state on disk does not silently flip to `shared`.
    const workspaceRoot = makeTempDir("first-tree-init-default-mode-no-url-");
    makeGitRepo(join(workspaceRoot, "source-a"));

    const summary = initializeWorkspaceRoot(workspaceRoot, {
      treePath: "./tree",
    });

    expect(summary.treeMode).toBe("dedicated");
  });

  it("derives tree-mode=shared when --tree-url is given (PR-B regression PIN)", () => {
    // Symmetric pin: when binding to a remote tree, the mode is
    // "shared" regardless of whether --tree-mode is passed.
    const workspaceRoot = makeTempDir("first-tree-init-default-mode-url-");
    makeGitRepo(join(workspaceRoot, "source-a"));
    // Pre-create the tree subdir so init does not attempt a real clone
    // (the test infra has no network access).
    const treeRoot = join(workspaceRoot, "tree");
    makeGitRepo(treeRoot);

    const summary = initializeWorkspaceRoot(workspaceRoot, {
      treePath: "./tree",
      treeUrl: "https://github.com/acme/tree.git",
    });

    expect(summary.treeMode).toBe("shared");
  });
});
