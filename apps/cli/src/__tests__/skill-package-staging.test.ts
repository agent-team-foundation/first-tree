import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");
const SCRIPT_PATH = join(CLI_ROOT, "scripts", "stage-bundled-skills.mjs");
const STAGED_SKILLS_ROOT = join(CLI_ROOT, "skills");
const REQUIRED_SKILL_NAMES = [
  "first-tree",
  "first-tree-context",
  "first-tree-onboarding",
  "first-tree-sync",
  "first-tree-write",
];

function removeStagedSkills(): void {
  rmSync(STAGED_SKILLS_ROOT, { recursive: true, force: true });
}

function runStagingScript(): string {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: CLI_ROOT,
    encoding: "utf-8",
  });

  if (result.error) {
    throw result.error;
  }

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("staged 5 bundled skills");

  return result.stdout;
}

afterEach(() => {
  removeStagedSkills();
});

describe("bundled skill package staging", () => {
  it("copies repo-root skills into apps/cli/skills and removes stale files first", () => {
    removeStagedSkills();

    runStagingScript();

    writeFileSync(join(STAGED_SKILLS_ROOT, "stale-root.txt"), "stale\n");
    writeFileSync(join(STAGED_SKILLS_ROOT, "first-tree", "stale.txt"), "stale\n");

    const stdout = runStagingScript();

    for (const skillName of REQUIRED_SKILL_NAMES) {
      const sourceSkill = join(REPO_ROOT, "skills", skillName, "SKILL.md");
      const stagedSkill = join(STAGED_SKILLS_ROOT, skillName, "SKILL.md");

      expect(existsSync(stagedSkill)).toBe(true);
      expect(readFileSync(stagedSkill, "utf-8")).toBe(readFileSync(sourceSkill, "utf-8"));
    }

    expect(existsSync(join(STAGED_SKILLS_ROOT, "stale-root.txt"))).toBe(false);
    expect(existsSync(join(STAGED_SKILLS_ROOT, "first-tree", "stale.txt"))).toBe(false);
    expect(stdout).toContain(join(REPO_ROOT, "skills"));
    expect(stdout).toContain(STAGED_SKILLS_ROOT);
  });
});
