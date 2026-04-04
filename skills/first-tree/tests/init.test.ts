import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatTaskList,
  parseInitArgs,
  writeProgress,
  runInit,
} from "#skill/engine/init.js";
import { Repo } from "#skill/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_PROGRESS,
} from "#skill/engine/runtime/asset-loader.js";
import {
  makeGitRepo,
  useTmpDir,
  makeAgentsMd,
  makeFramework,
  makeLegacyFramework,
  makeSourceRepo,
  makeSourceSkill,
} from "./helpers.js";

// --- formatTaskList ---

describe("formatTaskList", () => {
  it("produces markdown heading", () => {
    const groups = [
      { group: "Framework", order: 1, tasks: ["Install framework"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toMatch(/^# Context Tree Init/);
  });

  it("includes group heading", () => {
    const groups = [
      { group: "Framework", order: 1, tasks: ["Install framework"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toContain("## Framework");
  });

  it("includes task as checkbox", () => {
    const groups = [
      { group: "Root Node", order: 2, tasks: ["Fix title"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toContain("- [ ] Fix title");
  });

  it("handles multiple groups", () => {
    const groups = [
      { group: "A", order: 1, tasks: ["task-a1", "task-a2"] },
      { group: "B", order: 2, tasks: ["task-b1"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toContain("## A");
    expect(output).toContain("## B");
    expect(output).toContain("- [ ] task-a1");
    expect(output).toContain("- [ ] task-a2");
    expect(output).toContain("- [ ] task-b1");
  });

  it("includes verification section", () => {
    const groups = [{ group: "G", order: 1, tasks: ["t"] }];
    const output = formatTaskList(groups);
    expect(output).toContain("## Verification");
    expect(output).toContain("context-tree verify");
  });

  it("handles empty groups", () => {
    const output = formatTaskList([]);
    expect(output).toContain("# Context Tree Init");
    expect(output).toContain("## Verification");
  });
});

// --- writeProgress ---

describe("writeProgress", () => {
  it("writes to correct path", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    writeProgress(repo, "# hello\n");
    const progress = join(tmp.path, INSTALLED_PROGRESS);
    expect(readFileSync(progress, "utf-8")).toBe("# hello\n");
  });

  it("creates directory if missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    writeProgress(repo, "content");
    const progress = join(tmp.path, INSTALLED_PROGRESS);
    expect(readFileSync(progress, "utf-8")).toBe("content");
  });

  it("overwrites existing file", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "skills", "first-tree"), {
      recursive: true,
    });
    writeFileSync(join(tmp.path, INSTALLED_PROGRESS), "old");
    const repo = new Repo(tmp.path);
    writeProgress(repo, "new");
    expect(readFileSync(join(tmp.path, INSTALLED_PROGRESS), "utf-8")).toBe("new");
  });

  it("keeps using the legacy progress path for legacy repos", () => {
    const tmp = useTmpDir();
    makeLegacyFramework(tmp.path);
    const repo = new Repo(tmp.path);
    writeProgress(repo, "legacy");
    expect(readFileSync(join(tmp.path, LEGACY_PROGRESS), "utf-8")).toBe("legacy");
  });
});

// --- runInit — guard logic (no network) ---

const fakeGitInitializer = (root: string): void => {
  makeGitRepo(root);
};

describe("runInit", () => {
  it("errors when not a git repo", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const ret = runInit(repo);
    expect(ret).toBe(1);
  });

  it("installs the bundled skill and scaffolding when framework is missing", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeGitRepo(repoDir.path);
    makeSourceSkill(sourceDir.path, "0.2.0");

    const ret = runInit(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
      gitInitializer: fakeGitInitializer,
    });

    expect(ret).toBe(0);
    expect(
      existsSync(join(repoDir.path, "skills", "first-tree", "SKILL.md")),
    ).toBe(true);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(existsSync(join(repoDir.path, "NODE.md"))).toBe(true);
    expect(existsSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(repoDir.path, "members", "NODE.md"))).toBe(true);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(true);
  });

  it("does not scaffold AGENTS.md when legacy AGENT.md already exists", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    mkdirSync(join(repoDir.path, ".git"));
    makeAgentsMd(repoDir.path, { legacyName: true, markers: true, userContent: true });
    makeSourceSkill(sourceDir.path, "0.2.0");

    const ret = runInit(new Repo(repoDir.path), { sourceRoot: sourceDir.path });

    expect(ret).toBe(0);
    expect(existsSync(join(repoDir.path, LEGACY_AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE))).toBe(false);
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "Rename `AGENT.md` to `AGENTS.md`",
    );
  });

  it("skips reinstall when framework exists", () => {
    const tmp = useTmpDir();
    const sourceDir = useTmpDir();
    makeGitRepo(tmp.path);
    makeFramework(tmp.path, "0.1.0");
    makeSourceSkill(sourceDir.path, "0.2.0");

    const repo = new Repo(tmp.path);
    const ret = runInit(repo, { sourceRoot: sourceDir.path });

    expect(ret).toBe(0);
    expect(readFileSync(join(tmp.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.1.0");
  });

  it("creates a sibling tree repo by default when invoked from a source repo", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");

    const ret = runInit(new Repo(sourceRepoDir.path), {
      sourceRoot: sourceSkillDir.path,
      gitInitializer: fakeGitInitializer,
    });

    const treeRepo = join(
      dirname(sourceRepoDir.path),
      `${basename(sourceRepoDir.path)}-context`,
    );

    expect(ret).toBe(0);
    expect(existsSync(join(treeRepo, "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(existsSync(join(treeRepo, "NODE.md"))).toBe(true);
    expect(existsSync(join(treeRepo, AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(treeRepo, "members", "NODE.md"))).toBe(true);
    expect(existsSync(join(treeRepo, INSTALLED_PROGRESS))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, "NODE.md"))).toBe(false);
    expect(existsSync(join(sourceRepoDir.path, "members", "NODE.md"))).toBe(false);
    expect(existsSync(join(sourceRepoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("keeps supporting in-place init with --here", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");

    const ret = runInit(new Repo(sourceRepoDir.path), {
      here: true,
      sourceRoot: sourceSkillDir.path,
      gitInitializer: fakeGitInitializer,
    });

    expect(ret).toBe(0);
    expect(existsSync(join(sourceRepoDir.path, "NODE.md"))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, "members", "NODE.md"))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, INSTALLED_PROGRESS))).toBe(true);
  });
});

describe("parseInitArgs", () => {
  it("parses dedicated repo options", () => {
    expect(parseInitArgs(["--tree-name", "acme-context"])).toEqual({
      treeName: "acme-context",
    });
    expect(parseInitArgs(["--tree-path", "../acme-context"])).toEqual({
      treePath: "../acme-context",
    });
  });

  it("rejects incompatible init options", () => {
    expect(parseInitArgs(["--here", "--tree-name", "acme-context"])).toEqual({
      error: "Cannot combine --here with --tree-name",
    });
  });
});
