import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeSourceRoot } from "../src/commands/tree/init.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

describe("initializeSourceRoot", () => {
  it("creates a sibling dedicated tree and binds the source repo", () => {
    const sourceRoot = makeTempDir("first-tree-init-source-");
    writeFileSync(join(sourceRoot, ".git"), "gitdir: /tmp/source\n");
    const previousCwd = process.cwd();
    process.chdir(sourceRoot);

    try {
      const summary = initializeSourceRoot(sourceRoot, "unbound-source-repo");

      expect(summary.bindingMode).toBe("standalone-source");
      expect(summary.recursive).toBe(true);
      expect(summary.treeRoot).toBe(resolve(dirname(sourceRoot), `${sourceRoot.split("/").pop()}-tree`));
      expect(
        readFileSync(join(summary.treeRoot, ".first-tree", "agent-templates", "developer.yaml"), "utf8"),
      ).toContain("name: developer");
      expect(
        readFileSync(join(summary.treeRoot, ".first-tree", "agent-templates", "code-reviewer.yaml"), "utf8"),
      ).toContain("name: code-reviewer");
      expect(readFileSync(join(summary.treeRoot, ".first-tree", "org.yaml"), "utf8")).toContain("humanInvolveRules:");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("adds skills directories to .gitignore so installed skills are not committed", () => {
    const sourceRoot = makeTempDir("first-tree-init-gitignore-");
    writeFileSync(join(sourceRoot, ".git"), "gitdir: /tmp/source\n");
    const previousCwd = process.cwd();
    process.chdir(sourceRoot);

    try {
      initializeSourceRoot(sourceRoot, "unbound-source-repo");

      const gitignore = readFileSync(join(sourceRoot, ".gitignore"), "utf8");
      expect(gitignore).toContain(".agents/skills/");
      expect(gitignore).toContain(".claude/skills/");
      expect(gitignore).toContain(".first-tree/tmp/");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("cascades onboarding into nested git repos by default", () => {
    const sourceRoot = makeTempDir("first-tree-init-cascade-parent-");
    writeFileSync(join(sourceRoot, ".git"), "gitdir: /tmp/source\n");

    const childDir = join(sourceRoot, "packages", "child-pkg");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, ".git"), "gitdir: /tmp/child\n");

    const previousCwd = process.cwd();
    process.chdir(sourceRoot);

    try {
      const summary = initializeSourceRoot(sourceRoot, "unbound-source-repo");

      expect(summary.recursive).toBe(true);
      expect(summary.cascadedRepos).toBeDefined();
      expect(summary.cascadedRepos).toHaveLength(1);
      expect(summary.cascadedRepos?.[0]?.relativePath).toBe(join("packages", "child-pkg"));

      expect(existsSync(join(childDir, "AGENTS.md"))).toBe(true);
      expect(readFileSync(join(childDir, "AGENTS.md"), "utf8")).toContain("First Tree integration");
      expect(existsSync(join(childDir, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(true);
      expect(readFileSync(join(childDir, ".gitignore"), "utf8")).toContain(".agents/skills/");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("skips nested git repos when --no-recursive is requested", () => {
    const sourceRoot = makeTempDir("first-tree-init-no-recursive-parent-");
    writeFileSync(join(sourceRoot, ".git"), "gitdir: /tmp/source\n");

    const childDir = join(sourceRoot, "packages", "child-pkg");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, ".git"), "gitdir: /tmp/child\n");

    const previousCwd = process.cwd();
    process.chdir(sourceRoot);

    try {
      const summary = initializeSourceRoot(sourceRoot, "unbound-source-repo", {
        recursive: false,
      });

      expect(summary.recursive).toBe(false);
      expect(summary.cascadedRepos).toBeUndefined();
      expect(existsSync(join(childDir, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(childDir, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
