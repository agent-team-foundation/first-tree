import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const welcomeSkill = readFileSync(join(repoRoot, "skills", "first-tree-welcome", "SKILL.md"), "utf8");

describe("first-tree-welcome production_scan lane", () => {
  it("keeps the production scan first chat inside the existing welcome skill", () => {
    expect(welcomeSkill).toContain("production_scan");
    expect(welcomeSkill).toContain("production-readiness report");
    expect(welcomeSkill).toContain("must-fix task candidates");
    expect(welcomeSkill).toContain("Task Brief");
    expect(welcomeSkill).toMatch(/Do not require GitHub App\s+installation before reading the repo/u);
    expect(welcomeSkill).not.toContain("first-tree-repo-work");
  });
});
