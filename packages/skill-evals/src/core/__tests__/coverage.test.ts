import { describe, expect, it } from "vitest";
import { SKILL_EVAL_SUITES } from "../../suites/registry.js";
import { SHIPPED_SKILLS } from "../case-schema.js";
import { validateCoverageMatrix } from "../coverage.js";

describe("skill eval coverage matrix", () => {
  it("covers every shipped First Tree skill with floor and gate entries", () => {
    const validation = validateCoverageMatrix(SKILL_EVAL_SUITES);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);

    const suiteSkills = new Set(SKILL_EVAL_SUITES.map((suite) => suite.skill));
    for (const skill of SHIPPED_SKILLS) {
      expect(suiteSkills.has(skill)).toBe(true);
    }
  });
});
