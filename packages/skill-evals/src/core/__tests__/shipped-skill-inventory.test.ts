import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SHIPPED_SKILLS, UNEVALUATED_SHIPPED_SKILLS } from "../case-schema.js";

// Guardrail for the gap flagged in PR #1489 review (codex-assistant R5):
// `validateCoverageMatrix` only checks `SHIPPED_SKILLS`, so a new payload dropped
// into repo-root `skills/` could ship while escaping BOTH the eval coverage
// contract and any explicit acknowledgement that it is uncovered. This test
// closes that hole by requiring every on-disk skill to be consciously
// classified: either eval-covered (`SHIPPED_SKILLS`, whose per-skill floor/gate
// coverage is enforced by the coverage matrix) or explicitly excluded
// (`UNEVALUATED_SHIPPED_SKILLS`, which carries a documented rationale). Adding a
// skill dir now forces the author to pick a lane instead of silently defaulting
// to "no guardrail".

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    try {
      if (statSync(join(dir, "pnpm-workspace.yaml")).isFile()) return dir;
    } catch {
      // Not here — keep walking up.
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate repo root (no pnpm-workspace.yaml on the walk).");
}

function shippedSkillDirs(): readonly string[] {
  const skillsDir = join(findRepoRoot(), "skills");
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(join(skillsDir, name, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    });
}

describe("shipped skill inventory guardrail", () => {
  it("classifies every on-disk skill as eval-covered or explicitly excluded", () => {
    const classified = new Set<string>([...SHIPPED_SKILLS, ...UNEVALUATED_SHIPPED_SKILLS]);
    const unclassified = shippedSkillDirs().filter((name) => !classified.has(name));
    expect(
      unclassified,
      `Unclassified shipped skill(s): ${unclassified.join(", ")}. Add each to SHIPPED_SKILLS (with floor+gate eval coverage) or UNEVALUATED_SHIPPED_SKILLS (with a documented rationale).`,
    ).toEqual([]);
  });

  it("keeps the eval-covered and explicitly-excluded lists disjoint", () => {
    const excluded = new Set<string>(UNEVALUATED_SHIPPED_SKILLS);
    const overlap = SHIPPED_SKILLS.filter((name) => excluded.has(name));
    expect(overlap, `Skill(s) in both SHIPPED_SKILLS and UNEVALUATED_SHIPPED_SKILLS: ${overlap.join(", ")}`).toEqual(
      [],
    );
  });

  it("does not exclude a skill that is not actually shipped", () => {
    const onDisk = new Set<string>(shippedSkillDirs());
    const phantom = UNEVALUATED_SHIPPED_SKILLS.filter((name) => !onDisk.has(name));
    expect(phantom, `UNEVALUATED_SHIPPED_SKILLS names with no skills/<name>/ payload: ${phantom.join(", ")}`).toEqual(
      [],
    );
  });
});
