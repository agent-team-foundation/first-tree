import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#skill/engine/repo.js";
import { runUpgrade } from "#skill/engine/upgrade.js";
import {
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
} from "#skill/engine/runtime/asset-loader.js";
import {
  makeFramework,
  makeLegacyFramework,
  makeLegacyNamedFramework,
  makeSourceSkill,
  useTmpDir,
} from "./helpers.js";

describe("runUpgrade", () => {
  it("migrates a legacy repo to the installed skill layout", () => {
    const repoDir = useTmpDir();
    const sourceDir = useTmpDir();
    makeLegacyFramework(repoDir.path, "0.1.0");
    writeFileSync(
      join(repoDir.path, "AGENT.md"),
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
    );
    makeSourceSkill(sourceDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      sourceRoot: sourceDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, ".context-tree"))).toBe(false);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "skills/first-tree/assets/framework/VERSION",
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
});
