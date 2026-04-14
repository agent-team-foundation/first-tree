import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#engine/repo.js";
import { runUpgrade } from "#engine/upgrade.js";
import { copyCanonicalSkill } from "#engine/runtime/installer.js";
import { writeTreeBinding } from "#engine/runtime/binding-state.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  FIRST_TREE_INDEX_FILE,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  INSTALLED_SKILL_VERSION,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  SOURCE_INTEGRATION_MARKER,
  TREE_PROGRESS,
  TREE_VERSION,
} from "#engine/runtime/asset-loader.js";
import { buildSourceIntegrationBlock } from "#engine/runtime/source-integration.js";
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

function writeStaleInjectContextSettings(
  root: string,
  command = ".context-tree/scripts/inject-tree-context.sh",
): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
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
    expect(readFileSync(join(repoDir.path, INSTALLED_SKILL_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      ".agents/skills/first-tree/VERSION",
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      `Rename \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` to \`${AGENT_INSTRUCTIONS_FILE}\``,
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      `framework section in \`${AGENT_INSTRUCTIONS_FILE}\``,
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      `framework section in \`${CLAUDE_INSTRUCTIONS_FILE}\``,
    );
  });

  it("returns early and refreshes a stale SessionStart hook when the installed skill already matches the packaged skill", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeFramework(repoDir.path, "0.2.0");
    makeSourceSkill(sourceDir.path, "0.2.0");
    writeStaleInjectContextSettings(repoDir.path);

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
    expect(
      readFileSync(join(repoDir.path, ".claude", "settings.json"), "utf-8"),
    ).toContain(
      "npx -p first-tree first-tree inject-context --skip-version-check",
    );
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
    expect(readFileSync(join(repoDir.path, INSTALLED_SKILL_VERSION), "utf-8").trim()).toBe("0.2.0");
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
    expect(readFileSync(join(repoDir.path, INSTALLED_SKILL_VERSION), "utf-8").trim()).toBe("0.3.0");
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("gives a dedicated-tree hint when run from a source repo", () => {
    const repoDir = useTmpDir();
    makeSourceRepo(repoDir.path);
    const result = runUpgrade(new Repo(repoDir.path));
    expect(result).toBe(1);
  });

  it("keeps source-repo aliases pointed at the canonical skill when installing locally", () => {
    const repoDir = useTmpDir();
    makeSourceRepo(repoDir.path);
    makeSourceSkill(repoDir.path, "0.2.0");

    copyCanonicalSkill(repoDir.path, repoDir.path);

    expect(existsSync(join(repoDir.path, "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(lstatSync(join(repoDir.path, ".agents", "skills", "first-tree")).isSymbolicLink()).toBe(
      true,
    );
    expect(readlinkSync(join(repoDir.path, ".agents", "skills", "first-tree"))).toBe(
      "../../skills/first-tree",
    );
    expect(lstatSync(join(repoDir.path, ".claude", "skills", "first-tree")).isSymbolicLink()).toBe(
      true,
    );
    expect(readlinkSync(join(repoDir.path, ".claude", "skills", "first-tree"))).toBe(
      "../../.agents/skills/first-tree",
    );
    expect(readFileSync(join(repoDir.path, INSTALLED_SKILL_VERSION), "utf-8").trim()).toBe("0.2.0");
  });

  it("refreshes a dedicated tree repo and installs the tree-repo skill", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeTreeMetadata(repoDir.path, "0.1.0");
    makeAgentsMd(repoDir.path, { markers: true, userContent: true });
    writeFileSync(
      join(repoDir.path, "NODE.md"),
      [
        "---",
        "title: Example Tree",
        "owners: [alice]",
        "---",
        "",
        "# Example Tree",
        "",
        "Context for the organization.",
        "",
        "## Domains",
        "",
        "- **[members/](members/NODE.md)** — Members.",
        "",
      ].join("\n"),
    );
    writeTreeBinding(repoDir.path, "alpha-11111111", {
      bindingMode: "shared-source",
      entrypoint: "/repos/alpha",
      remoteUrl: "git@github.com:acme/alpha.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "alpha-11111111",
      sourceName: "alpha",
      sourceRootPath: "../alpha",
      treeMode: "shared",
      treeRepoName: "org-context",
    });
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(readFileSync(join(repoDir.path, TREE_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(existsSync(join(repoDir.path, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(repoDir.path, ".claude", "skills", "first-tree", "SKILL.md"))).toBe(
      true,
    );
    expect(readFileSync(join(repoDir.path, TREE_PROGRESS), "utf-8")).toContain(
      ".first-tree/VERSION",
    );
    expect(readFileSync(join(repoDir.path, "source-repos.md"), "utf-8")).toContain(
      "[acme/alpha](https://github.com/acme/alpha)",
    );
    expect(readFileSync(join(repoDir.path, "NODE.md"), "utf-8")).toContain(
      "[Source Repos](source-repos.md)",
    );
    expect(readFileSync(join(repoDir.path, "AGENTS.md"), "utf-8")).toContain(
      "## Source Repo Index",
    );
  });

  it("refreshes a stale SessionStart hook even when a dedicated tree repo is already current", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeTreeMetadata(repoDir.path, "0.2.0");
    makeFramework(repoDir.path, "0.2.0");
    makeAgentsMd(repoDir.path, { markers: true, userContent: true });
    writeFileSync(
      join(repoDir.path, "NODE.md"),
      [
        "---",
        "title: Example Tree",
        "owners: [alice]",
        "---",
        "",
        "# Example Tree",
        "",
        "Context for the organization.",
        "",
      ].join("\n"),
    );
    writeStaleInjectContextSettings(repoDir.path);
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, TREE_PROGRESS))).toBe(false);
    expect(
      readFileSync(join(repoDir.path, ".claude", "settings.json"), "utf-8"),
    ).toContain(
      "npx -p first-tree first-tree inject-context --skip-version-check",
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
    expect(readFileSync(join(repoDir.path, INSTALLED_SKILL_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      expectedBlock,
    );
    expect(readFileSync(join(repoDir.path, CLAUDE_INSTRUCTIONS_FILE), "utf-8")).toContain(
      expectedBlock,
    );
    expect(readFileSync(join(repoDir.path, ".gitignore"), "utf-8")).toContain(
      ".first-tree/tmp/",
    );
    expectFirstTreeIndexSymlink(repoDir.path);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });

  it("migrates a managed FIRST_TREE.md and refreshes a stale SessionStart hook even when the installed skill is already current", () => {
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
    writeStaleInjectContextSettings(repoDir.path);
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expectFirstTreeIndexSymlink(repoDir.path);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
    expect(
      readFileSync(join(repoDir.path, ".claude", "settings.json"), "utf-8"),
    ).toContain(
      "npx -p first-tree first-tree inject-context --skip-version-check",
    );
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
  });
});
