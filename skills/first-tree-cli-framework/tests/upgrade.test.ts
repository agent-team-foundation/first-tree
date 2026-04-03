import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#skill/engine/repo.js";
import { runUpgrade } from "#skill/engine/upgrade.js";
import {
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
} from "#skill/engine/runtime/asset-loader.js";
import { makeFramework, makeLegacyFramework, useTmpDir } from "./helpers.js";

function makeUpstreamSkill(root: string, version: string): void {
  const skillRoot = join(root, "skills", "first-tree-cli-framework");
  mkdirSync(join(skillRoot, "assets", "framework"), { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: first-tree-cli-framework\ndescription: test\n---\n",
  );
  writeFileSync(join(root, FRAMEWORK_VERSION), `${version}\n`);
}

describe("runUpgrade", () => {
  it("migrates a legacy repo to the installed skill layout", () => {
    const repoDir = useTmpDir();
    const upstreamDir = useTmpDir();
    makeLegacyFramework(repoDir.path, "0.1.0");
    writeFileSync(
      join(repoDir.path, "AGENT.md"),
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
    );
    makeUpstreamSkill(upstreamDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      upstreamRoot: upstreamDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, ".context-tree"))).toBe(false);
    expect(readFileSync(join(repoDir.path, FRAMEWORK_VERSION), "utf-8").trim()).toBe("0.2.0");
    expect(readFileSync(join(repoDir.path, INSTALLED_PROGRESS), "utf-8")).toContain(
      "skills/first-tree-cli-framework/assets/framework/VERSION",
    );
  });

  it("returns early when the installed skill is already current", () => {
    const repoDir = useTmpDir();
    const upstreamDir = useTmpDir();
    makeFramework(repoDir.path, "0.2.0");
    makeUpstreamSkill(upstreamDir.path, "0.2.0");

    const result = runUpgrade(new Repo(repoDir.path), {
      upstreamRoot: upstreamDir.path,
    });

    expect(result).toBe(0);
    expect(existsSync(join(repoDir.path, INSTALLED_PROGRESS))).toBe(false);
  });
});
