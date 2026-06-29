import { describe, expect, it } from "vitest";
import { SKILL_EVAL_SUITES } from "../../suites/registry.js";
import { SHIPPED_SKILLS } from "../case-schema.js";
import { type SkillEvalSuiteDefinition, validateCoverageMatrix } from "../coverage.js";

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

  it("rejects tier entries that reference a case from another tier", () => {
    const invalidSuite: SkillEvalSuiteDefinition = {
      cases: [
        {
          briefingMode: "minimal",
          expected: {},
          fixture: {},
          id: "static-floor",
          skill: "first-tree-read",
          status: "implemented",
          tier: "floor",
        },
        {
          briefingMode: "minimal",
          expected: {},
          fixture: {},
          id: "live-gate",
          prompt: "Run a gate case.",
          provider: "codex",
          skill: "first-tree-read",
          status: "implemented",
          tier: "gate",
        },
      ],
      coverage: {
        skill: "first-tree-read",
        tiers: [
          {
            caseIds: ["live-gate"],
            description: "bad floor",
            status: "implemented",
            tier: "floor",
          },
          {
            caseIds: ["live-gate"],
            description: "gate",
            status: "implemented",
            tier: "gate",
          },
        ],
      },
      skill: "first-tree-read",
    };

    const validation = validateCoverageMatrix([
      invalidSuite,
      ...SKILL_EVAL_SUITES.filter((suite) => suite.skill !== "first-tree-read"),
    ]);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("first-tree-read: floor coverage references gate case live-gate.");
  });
});
