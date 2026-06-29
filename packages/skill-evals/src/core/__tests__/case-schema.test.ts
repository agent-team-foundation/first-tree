import { describe, expect, it } from "vitest";

import { type SkillEvalCase, validateSkillEvalCase } from "../case-schema.js";
import { allScoresPass } from "../result-schema.js";

describe("skill eval case schema", () => {
  it("accepts a complete floor case", () => {
    const evalCase: SkillEvalCase = {
      briefingMode: "minimal",
      expected: { action: "validate" },
      fixture: { kind: "static" },
      id: "first-tree-read-static",
      skill: "first-tree-read",
      status: "implemented",
      tier: "floor",
    };

    expect(validateSkillEvalCase(evalCase)).toEqual({ errors: [], ok: true });
  });

  it("requires prompts for live-style cases", () => {
    const evalCase: SkillEvalCase = {
      briefingMode: "minimal",
      expected: { action: "run" },
      fixture: { kind: "workspace" },
      id: "first-tree-read-gate",
      skill: "first-tree-read",
      status: "implemented",
      tier: "gate",
    };

    expect(validateSkillEvalCase(evalCase).errors).toContain("gate cases must include prompt.");
  });

  it("summarizes the four hard score axes", () => {
    expect(
      allScoresPass({
        outcome_pass: true,
        process_pass: true,
        risk_pass: true,
        routing_pass: true,
      }),
    ).toBe(true);

    expect(
      allScoresPass({
        outcome_pass: true,
        process_pass: true,
        risk_pass: false,
        routing_pass: true,
      }),
    ).toBe(false);
  });
});
