import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#skill/engine/repo.js";
import { runUpgrade } from "#skill/engine/upgrade.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
} from "#skill/engine/runtime/asset-loader.js";
import {
  makeAgentsMd,
  makeFramework,
  makeSourceRepo,
  makeLegacyFramework,
  makeLegacyRepoFramework,
  makeLegacyNamedFramework,
  makeSourceSkill,
  useTmpDir,
} from "./helpers.js";

describe("runUpgrade", () => {
  it("migrates a legacy repo to the installed skill layout", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeLegacyFramework(repoDir.path, "0.1.0");
    makeAgentsMd(repoDir.path, { legacyName: true, markers: true, userContent: true });
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

  it("migrates repos that still use the previous installed skill name", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeLegacyNamedFramework(repoDir.path, "0.2.0");
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, "skills", "first-tree-cli-framework"))).toBe(
      false,
    );
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "skills/first-tree-cli-framework/",
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
});
