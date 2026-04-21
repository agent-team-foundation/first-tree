import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runIntegrate } from "#products/tree/engine/integrate.js";
import { Repo } from "#products/tree/engine/repo.js";
import { readSourceState } from "#products/tree/engine/runtime/binding-state.js";
import {
  makeGitRepo,
  makeSourceRepo,
  makeSourceSkill,
  makeTreeMetadata,
  useTmpDir,
} from "../helpers.js";

describe("runIntegrate", () => {
  it("installs skill and writes source.json without touching the tree repo", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    const treeRoot = join(sandbox.path, "org-context");

    makeSourceRepo(sourceRoot);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/product-repo.git"],
      { cwd: sourceRoot, stdio: "ignore" },
    );
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const result = runIntegrate({
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
    });

    expect(result).toBe(0);

    // Source side: skill installed, block written, source.json written.
    expect(
      existsSync(join(sourceRoot, ".claude", "skills", "first-tree", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(sourceRoot, ".agents", "skills", "first-tree", "SKILL.md")),
    ).toBe(true);
    const claudeMd = readFileSync(join(sourceRoot, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->");
    expect(claudeMd).toContain("<!-- END FIRST-TREE-SOURCE-INTEGRATION -->");

    const sourceState = readSourceState(sourceRoot);
    expect(sourceState).not.toBeNull();
    expect(sourceState?.tree.treeRepoName).toBe("org-context");

    // Tree side: untouched — no .first-tree/tree.json, bindings/, skill install, or submodule work.
    expect(existsSync(join(treeRoot, ".first-tree", "tree.json"))).toBe(false);
    expect(existsSync(join(treeRoot, ".first-tree", "bindings"))).toBe(false);
    expect(
      existsSync(join(treeRoot, ".claude", "skills", "first-tree", "SKILL.md")),
    ).toBe(false);
    expect(
      existsSync(join(treeRoot, ".agents", "skills", "first-tree", "SKILL.md")),
    ).toBe(false);
    expect(existsSync(join(treeRoot, "source-repos.md"))).toBe(false);
    expect(existsSync(join(treeRoot, ".gitmodules"))).toBe(false);
  });

  it("works on a non-git source folder (ephemeral workspace use case)", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "workspace-abc123");
    const treeRoot = join(sandbox.path, "org-context");

    // Plain folder — no git init.
    execFileSync("mkdir", ["-p", sourceRoot]);
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const result = runIntegrate({
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
      mode: "workspace-root",
      workspaceId: "abc123",
    });

    expect(result).toBe(0);
    const sourceState = readSourceState(sourceRoot);
    expect(sourceState?.rootKind).toBe("folder");
    expect(sourceState?.bindingMode).toBe("workspace-root");
    expect(sourceState?.workspaceId).toBe("abc123");
    expect(new Repo(sourceRoot).isGitRepo()).toBe(false);
  });

  it("is idempotent — running twice keeps the source integration block current", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    const treeRoot = join(sandbox.path, "org-context");

    makeSourceRepo(sourceRoot);
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const first = runIntegrate({
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
    });
    expect(first).toBe(0);

    const firstClaudeMd = readFileSync(join(sourceRoot, "CLAUDE.md"), "utf-8");

    const second = runIntegrate({
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
    });
    expect(second).toBe(0);

    const secondClaudeMd = readFileSync(join(sourceRoot, "CLAUDE.md"), "utf-8");
    expect(secondClaudeMd).toBe(firstClaudeMd);
  });

  it("accepts --source-path to target a different directory than cwd", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const runCwd = sandbox.path;
    const sourceRoot = join(sandbox.path, "workspace-xyz");
    const treeRoot = join(sandbox.path, "org-context");

    execFileSync("mkdir", ["-p", sourceRoot]);
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const result = runIntegrate({
      currentCwd: runCwd,
      sourcePath: "workspace-xyz",
      sourceRoot: sourceBundle.path,
      treePath: "org-context",
      mode: "workspace-root",
      workspaceId: "xyz",
    });

    expect(result).toBe(0);
    expect(existsSync(join(sourceRoot, ".first-tree", "source.json"))).toBe(true);
    // runCwd itself should not have been integrated.
    expect(existsSync(join(runCwd, ".first-tree", "source.json"))).toBe(false);
  });

  it("records the tree repo URL when provided via --tree-url", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    const treeRoot = join(sandbox.path, "org-context");

    makeSourceRepo(sourceRoot);
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const result = runIntegrate({
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
      treeUrl: "https://github.com/agent-team-foundation/first-tree-context",
    });

    expect(result).toBe(0);
    const sourceState = readSourceState(sourceRoot);
    expect(sourceState?.tree.remoteUrl).toBe(
      "https://github.com/agent-team-foundation/first-tree-context",
    );
    const claudeMd = readFileSync(join(sourceRoot, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(
      "https://github.com/agent-team-foundation/first-tree-context",
    );
  });
});
