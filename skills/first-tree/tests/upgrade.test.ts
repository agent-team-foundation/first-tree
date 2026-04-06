import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#skill/engine/repo.js";
import { runUpgrade } from "#skill/engine/upgrade.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  FIRST_TREE_INDEX_FILE,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LOCAL_TREE_CONFIG,
  SOURCE_INTEGRATION_MARKER,
  TREE_PROGRESS,
  TREE_VERSION,
} from "#skill/engine/runtime/asset-loader.js";
import { buildSourceIntegrationBlock } from "#skill/engine/runtime/source-integration.js";
import {
  makeAgentsMd,
  makeClaudeMd,
  makeFramework,
  makeSourceRepo,
  makeLegacyFramework,
  makeLegacyRepoFramework,
  makeSourceSkill,
  makeTreeMetadata,
  useTmpDir,
} from "./helpers.js";

function expectFirstTreeIndexSymlink(root: string): void {
  const path = join(root, FIRST_TREE_INDEX_FILE);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(
    join(".agents", "skills", "first-tree", "references", "about.md"),
  );
}

describe("runUpgrade", () => {
  it("migrates a legacy repo to the installed skill layout", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeLegacyFramework(repoDir.path, "0.1.0");
    makeAgentsMd(repoDir.path, { legacyName: true, markers: true, userContent: true });
    makeClaudeMd(repoDir.path, { markers: true, userContent: true });
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, ".context-tree"))).toBe(false);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      ".agents/skills/first-tree/assets/framework/VERSION",
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      `Rename \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` to \`${AGENT_INSTRUCTIONS_FILE}\``,
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "skills/first-tree/assets/framework/templates/agents.md.template",
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "skills/first-tree/assets/framework/templates/claude.md.template",
    );
  });

  it("returns early when the installed skill already matches the packaged skill", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeFramework(repoDir.path, "0.2.0");
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("migrates repos that still use the previous workspace skill path", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeLegacyRepoFramework(repoDir.path, "0.1.0");
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, "skills", "first-tree"))).toBe(false);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "skills/first-tree/",
    );
  });

  it("refuses to replace a newer installed skill with an older packaged skill", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeFramework(repoDir.path, "0.3.0");
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(1);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.3.0");
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("gives a dedicated-tree hint when run from a source repo", () => {
    const repoDir = useTmpDir();
    makeSourceRepo(repoDir.path);
    const result = runUpgrade(new Repo(repoDir.path));
    expect(result).toBe(1);
  });

  it("refreshes a dedicated tree repo without reinstalling the skill", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeTreeMetadata(repoDir.path, "0.1.0");
    makeAgentsMd(repoDir.path, { markers: true, userContent: true });
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(readFileSync(join(repoDir.path, TREE_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(existsSync(join(repoDir.path, ".agents", "skills", "first-tree"))).toBe(false);
    expect(readFileSync(join(repoDir.path, TREE_PROGRESS), "utf-8")).toContain(
      ".first-tree/VERSION",
    );
  });

  it("refreshes source/workspace integration without writing tree progress", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeSourceRepo(repoDir.path);
    makeFramework(repoDir.path, "0.1.0");
    writeFileSync(
      join(repoDir.path, AGENT_INSTRUCTIONS_FILE),
      `${SOURCE_INTEGRATION_MARKER} old text\n`,
    );
    writeFileSync(
      join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE),
      `${SOURCE_INTEGRATION_MARKER} old text\n`,
    );
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    const expectedBlock = buildSourceIntegrationBlock(
      `${basename(repoDir.path)}-tree`,
    );
    expect(result).toBe(0);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      expectedBlock,
    );
    expect(readFileSync(join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE), "utf-8")).toContain(
      expectedBlock,
    );
    expect(readFileSync(join(repoDir.path, ".gitignore"), "utf-8")).toContain(
      ".first-tree/local-tree.json",
    );
    expect(
      JSON.parse(readFileSync(join(repoDir.path, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: `../${basename(repoDir.path)}-tree`,
      treeRepoName: `${basename(repoDir.path)}-tree`,
    });
    expectFirstTreeIndexSymlink(repoDir.path);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("migrates a managed FIRST_TREE.md to a symlink even when the installed skill is already current", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeSourceRepo(repoDir.path);
    makeFramework(repoDir.path, "0.2.0");
    writeFileSync(
      join(repoDir.path, AGENT_INSTRUCTIONS_FILE),
      `${SOURCE_INTEGRATION_MARKER} old text\n`,
    );
    writeFileSync(
      join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE),
      `${SOURCE_INTEGRATION_MARKER} old text\n`,
    );
    writeFileSync(
      join(repoDir.path, FIRST_TREE_INDEX_FILE),
      [
        "# First Tree",
        "",
        "<!-- BEGIN FIRST-TREE INDEX -->",
        "legacy managed entrypoint",
        "<!-- END FIRST-TREE INDEX -->",
        "",
      ].join("\n"),
    );
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expectFirstTreeIndexSymlink(repoDir.path);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("preserves an existing legacy context binding in source/workspace integration", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeSourceRepo(repoDir.path);
    makeFramework(repoDir.path, "0.1.0");
    const legacyTreeRepoName = `${basename(repoDir.path)}-context`;
    writeFileSync(
      join(repoDir.path, AGENT_INSTRUCTIONS_FILE),
      `${buildSourceIntegrationBlock(legacyTreeRepoName)}\n`,
    );
    writeFileSync(
      join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE),
      `${buildSourceIntegrationBlock(legacyTreeRepoName)}\n`,
    );
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(readFileSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      buildSourceIntegrationBlock(legacyTreeRepoName),
    );
    expect(readFileSync(join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE), "utf-8")).toContain(
      buildSourceIntegrationBlock(legacyTreeRepoName),
    );
    expect(
      JSON.parse(readFileSync(join(repoDir.path, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: `../${legacyTreeRepoName}`,
      treeRepoName: legacyTreeRepoName,
    });
  });
});
