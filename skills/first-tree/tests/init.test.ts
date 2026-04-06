import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatTaskList,
  INIT_USAGE,
  parseInitArgs,
  writeProgress,
  runInit,
} from "#skill/engine/init.js";
import { Repo } from "#skill/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  FIRST_TREE_INDEX_FILE,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_PROGRESS,
  LOCAL_TREE_CONFIG,
  TREE_PROGRESS,
  TREE_VERSION,
  BOOTSTRAP_STATE,
} from "#skill/engine/runtime/asset-loader.js";
import { buildSourceIntegrationBlock } from "#skill/engine/runtime/source-integration.js";
import {
  makeGitRepo,
  useTmpDir,
  makeAgentsMd,
  makeClaudeMd,
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
    expect(output).toContain("first-tree verify");
  });

  it("handles empty groups", () => {
    const output = formatTaskList([]);
    expect(output).toContain("# Context Tree Init");
    expect(output).toContain("## Verification");
  });

  it("documents the publish workflow for dedicated tree repos", () => {
    const output = formatTaskList([], {
      dedicatedTreeRepo: true,
      sourceRepoName: "ADHD",
      sourceRepoPath: "../ADHD",
    });

    expect(output).toContain("first-tree publish --open-pr");
    expect(output).toContain("canonical local working copy");
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
    mkdirSync(join(tmp.path, ".agents", "skills", "first-tree"), {
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

  it("writes to the dedicated tree progress path when tree metadata exists", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".first-tree"), { recursive: true });
    writeFileSync(join(tmp.path, TREE_VERSION), "0.2.0\n");
    const repo = new Repo(tmp.path);
    writeProgress(repo, "tree");
    expect(readFileSync(join(tmp.path, TREE_PROGRESS), "utf-8")).toBe("tree");
  });
});

// --- runInit — guard logic (no network) ---

const fakeGitInitializer = (root: string): void => {
  makeGitRepo(root);
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectFirstTreeIndexSymlink(root: string): void {
  const path = join(root, FIRST_TREE_INDEX_FILE);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(
    join(".agents", "skills", "first-tree", "references", "about.md"),
  );
}

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
      existsSync(join(repoDir.path, ".agents", "skills", "first-tree", "SKILL.md")),
    ).toBe(false);
    expect(
      existsSync(join(repoDir.path, ".claude", "skills", "first-tree", "SKILL.md")),
    ).toBe(false);
    expect(readFileSync(join(repoDir.path, TREE_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(existsSync(join(repoDir.path, "NODE.md"))).toBe(true);
    expect(existsSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(repoDir.path, "members", "NODE.md"))).toBe(true);
    expect(existsSync(join(repoDir.path, TREE_PROGRESS))).toBe(true);
  });

  it("does not scaffold AGENTS.md when legacy AGENT.md already exists", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    mkdirSync(join(repoDir.path, ".git"));
    makeAgentsMd(repoDir.path, { legacyName: true, markers: true, userContent: true });
    makeClaudeMd(repoDir.path, { markers: true, userContent: true });
    makeSourceSkill(sourceDir.path, "0.2.0");

    const ret = runInit(new Repo(repoDir.path), { sourceRoot: sourceDir.path });

    expect(ret).toBe(0);
    expect(existsSync(join(repoDir.path, LEGACY_AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE))).toBe(false);
    expect(readFileSync(join(repoDir.path, TREE_PROGRESS), "utf-8")).toContain(
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
      `${basename(sourceRepoDir.path)}-tree`,
    );

    expect(ret).toBe(0);
    expect(
      existsSync(join(sourceRepoDir.path, ".agents", "skills", "first-tree", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(sourceRepoDir.path, ".claude", "skills", "first-tree", "SKILL.md")),
    ).toBe(true);
    expect(
      readFileSync(join(sourceRepoDir.path, AGENT_INSTRUCTIONS_FILE), "utf-8"),
    ).toContain(buildSourceIntegrationBlock(basename(treeRepo)));
    expect(
      readFileSync(join(sourceRepoDir.path, CLAUDE_INSTRUCTIONS_FILE), "utf-8"),
    ).toContain(buildSourceIntegrationBlock(basename(treeRepo)));
    expectFirstTreeIndexSymlink(sourceRepoDir.path);
    expect(readFileSync(join(sourceRepoDir.path, ".gitignore"), "utf-8")).toContain(
      ".first-tree/local-tree.json",
    );
    expect(readFileSync(join(sourceRepoDir.path, ".gitignore"), "utf-8")).toContain(
      ".first-tree/tmp/",
    );
    expect(
      JSON.parse(readFileSync(join(sourceRepoDir.path, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: `../${basename(treeRepo)}`,
      treeRepoName: basename(treeRepo),
    });
    expect(
      existsSync(join(treeRepo, ".agents", "skills", "first-tree", "SKILL.md")),
    ).toBe(false);
    expect(
      existsSync(join(treeRepo, ".claude", "skills", "first-tree", "SKILL.md")),
    ).toBe(false);
    expect(existsSync(join(treeRepo, "NODE.md"))).toBe(true);
    expect(existsSync(join(treeRepo, AGENT_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(treeRepo, CLAUDE_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(treeRepo, "members", "NODE.md"))).toBe(true);
    expect(readFileSync(join(treeRepo, TREE_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(existsSync(join(treeRepo, TREE_PROGRESS))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(treeRepo, BOOTSTRAP_STATE), "utf-8")),
    ).toEqual({
      sourceRepoName: basename(sourceRepoDir.path),
      sourceRepoPath: `../${basename(sourceRepoDir.path)}`,
      treeRepoName: basename(treeRepo),
    });
    expect(existsSync(join(sourceRepoDir.path, "NODE.md"))).toBe(false);
    expect(existsSync(join(sourceRepoDir.path, "members", "NODE.md"))).toBe(false);
    expect(existsSync(join(sourceRepoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("updates existing AGENTS.md and CLAUDE.md without duplicating the source integration block", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");
    writeFileSync(join(sourceRepoDir.path, AGENT_INSTRUCTIONS_FILE), "# Repo Notes\n");
    writeFileSync(join(sourceRepoDir.path, CLAUDE_INSTRUCTIONS_FILE), "# Claude Notes\n");

    expect(
      runInit(new Repo(sourceRepoDir.path), {
        sourceRoot: sourceSkillDir.path,
        gitInitializer: fakeGitInitializer,
      }),
    ).toBe(0);
    expect(
      runInit(new Repo(sourceRepoDir.path), {
        sourceRoot: sourceSkillDir.path,
        gitInitializer: fakeGitInitializer,
      }),
    ).toBe(0);

    const treeRepo = join(
      dirname(sourceRepoDir.path),
      `${basename(sourceRepoDir.path)}-tree`,
    );
    const expectedBlock = buildSourceIntegrationBlock(basename(treeRepo));
    const agentText = readFileSync(
      join(sourceRepoDir.path, AGENT_INSTRUCTIONS_FILE),
      "utf-8",
    );
    const claudeText = readFileSync(
      join(sourceRepoDir.path, CLAUDE_INSTRUCTIONS_FILE),
      "utf-8",
    );

    expect(
      agentText.match(new RegExp(escapeRegExp(expectedBlock), "g")),
    ).toHaveLength(1);
    expect(
      claudeText.match(new RegExp(escapeRegExp(expectedBlock), "g")),
    ).toHaveLength(1);
  });

  it("does not overwrite an unmanaged FIRST_TREE.md in the source repo", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");
    writeFileSync(join(sourceRepoDir.path, FIRST_TREE_INDEX_FILE), "# Custom entrypoint\n");

    expect(
      runInit(new Repo(sourceRepoDir.path), {
        sourceRoot: sourceSkillDir.path,
        gitInitializer: fakeGitInitializer,
      }),
    ).toBe(0);

    expect(
      readFileSync(join(sourceRepoDir.path, FIRST_TREE_INDEX_FILE), "utf-8"),
    ).toBe("# Custom entrypoint\n");
  });

  it("preserves an existing tree repo URL when refreshing local tree config", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");
    mkdirSync(join(sourceRepoDir.path, ".first-tree"), { recursive: true });
    writeFileSync(
      join(sourceRepoDir.path, LOCAL_TREE_CONFIG),
      JSON.stringify(
        {
          localPath: "../custom-tree",
          treeRepoName: `${basename(sourceRepoDir.path)}-tree`,
          treeRepoUrl: "git@github.com:acme/example-source-repo-tree.git",
        },
        null,
        2,
      ),
    );

    expect(
      runInit(new Repo(sourceRepoDir.path), {
        sourceRoot: sourceSkillDir.path,
        gitInitializer: fakeGitInitializer,
      }),
    ).toBe(0);

    const treeRepo = join(
      dirname(sourceRepoDir.path),
      `${basename(sourceRepoDir.path)}-tree`,
    );
    expect(
      JSON.parse(readFileSync(join(sourceRepoDir.path, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: `../${basename(treeRepo)}`,
      treeRepoName: basename(treeRepo),
      treeRepoUrl: "git@github.com:acme/example-source-repo-tree.git",
    });
  });

  it("migrates a previously managed FIRST_TREE.md to a symlink", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");
    writeFileSync(
      join(sourceRepoDir.path, FIRST_TREE_INDEX_FILE),
      [
        "# First Tree",
        "",
        "<!-- BEGIN FIRST-TREE INDEX -->",
        "legacy managed entrypoint",
        "<!-- END FIRST-TREE INDEX -->",
        "",
      ].join("\n"),
    );

    expect(
      runInit(new Repo(sourceRepoDir.path), {
        sourceRoot: sourceSkillDir.path,
        gitInitializer: fakeGitInitializer,
      }),
    ).toBe(0);

    expectFirstTreeIndexSymlink(sourceRepoDir.path);
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
    expect(existsSync(join(sourceRepoDir.path, CLAUDE_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, "members", "NODE.md"))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, TREE_PROGRESS))).toBe(true);
    expect(existsSync(join(sourceRepoDir.path, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(
      false,
    );
  });

  it("can seed member nodes from contributor history into the dedicated tree repo", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");

    const ret = runInit(new Repo(sourceRepoDir.path), {
      contributorCollector: () => ({
        contributors: [
          {
            owner: "alice",
            role: "Contributor",
            slug: "alice",
            source: "github",
            title: "Alice Example",
            type: "human",
          },
          {
            owner: "renovate-bot",
            role: "Automation Contributor",
            slug: "renovate-bot",
            source: "git",
            title: "Renovate Bot",
            type: "autonomous_agent",
          },
        ],
        source: "github",
      }),
      seedMembers: "contributors",
      sourceRoot: sourceSkillDir.path,
      gitInitializer: fakeGitInitializer,
    });

    const treeRepo = join(
      dirname(sourceRepoDir.path),
      `${basename(sourceRepoDir.path)}-tree`,
    );

    expect(ret).toBe(0);
    expect(existsSync(join(treeRepo, "members", "alice", "NODE.md"))).toBe(true);
    expect(existsSync(join(treeRepo, "members", "renovate-bot", "NODE.md"))).toBe(
      true,
    );
    expect(readFileSync(join(treeRepo, TREE_PROGRESS), "utf-8")).toContain(
      "Review the 2 contributor-seeded member node(s) under `members/`",
    );
    expect(readFileSync(join(sourceRepoDir.path, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      buildSourceIntegrationBlock(basename(treeRepo)),
    );
  });

  it("reuses an existing sibling legacy context repo instead of creating a new tree repo", () => {
    const sourceRepoDir = useTmpDir();
    const sourceSkillDir = useTmpDir();
    makeSourceRepo(sourceRepoDir.path);
    makeSourceSkill(sourceSkillDir.path, "0.2.0");

    const legacyTreeRepo = join(
      dirname(sourceRepoDir.path),
      `${basename(sourceRepoDir.path)}-context`,
    );
    mkdirSync(legacyTreeRepo, { recursive: true });
    makeGitRepo(legacyTreeRepo);
    makeFramework(legacyTreeRepo, "0.1.0");

    const ret = runInit(new Repo(sourceRepoDir.path), {
      sourceRoot: sourceSkillDir.path,
      gitInitializer: fakeGitInitializer,
    });

    expect(ret).toBe(0);
    expect(readFileSync(join(sourceRepoDir.path, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      buildSourceIntegrationBlock(basename(legacyTreeRepo)),
    );
    expect(
      JSON.parse(readFileSync(join(legacyTreeRepo, BOOTSTRAP_STATE), "utf-8")),
    ).toEqual({
      sourceRepoName: basename(sourceRepoDir.path),
      sourceRepoPath: `../${basename(sourceRepoDir.path)}`,
      treeRepoName: basename(legacyTreeRepo),
    });
    expect(
      JSON.parse(readFileSync(join(sourceRepoDir.path, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: `../${basename(legacyTreeRepo)}`,
      treeRepoName: basename(legacyTreeRepo),
    });
    expect(
      existsSync(
        join(dirname(sourceRepoDir.path), `${basename(sourceRepoDir.path)}-tree`),
      ),
    ).toBe(false);
  });
});

describe("parseInitArgs", () => {
  it("documents that --here is only for dedicated tree repos", () => {
    expect(INIT_USAGE).toContain("Do not use `--here` inside a source/workspace repo");
    expect(INIT_USAGE).toContain("already in the dedicated tree repo");
  });

  it("parses dedicated repo options", () => {
    expect(parseInitArgs(["--tree-name", "acme-tree"])).toEqual({
      treeName: "acme-tree",
    });
    expect(parseInitArgs(["--tree-path", "../acme-tree"])).toEqual({
      treePath: "../acme-tree",
    });
    expect(parseInitArgs(["--seed-members", "contributors"])).toEqual({
      seedMembers: "contributors",
    });
  });

  it("rejects incompatible init options", () => {
    expect(parseInitArgs(["--here", "--tree-name", "acme-tree"])).toEqual({
      error: "Cannot combine --here with --tree-name",
    });
    expect(parseInitArgs(["--seed-members", "github"])).toEqual({
      error: "Unsupported value for --seed-members: github",
    });
  });
});
