import { describe, expect, it } from "vitest";

import { evidence, gradingFailureMessages, riskFlag } from "../grading.js";
import type { SkillCaseGrading } from "../result-schema.js";

describe("skill case grading diagnostics", () => {
  it("prefers failed score evidence and risk flags in failure messages", () => {
    const grading: SkillCaseGrading = {
      caseId: "grading-diagnostics",
      evidence: [
        evidence("routing_pass", "skill read observed=true"),
        evidence("process_pass", "selector succeeded=false"),
        evidence("outcome_pass", "expected facts observed=true"),
        evidence("risk_pass", "failed command observed"),
      ],
      passed: false,
      riskFlags: [riskFlag("failed_first_tree_command", "first-tree tree tree /foo exited 2")],
      scores: {
        outcome_pass: true,
        process_pass: false,
        risk_pass: false,
        routing_pass: true,
      },
    };

    expect(gradingFailureMessages(grading)).toEqual([
      "process_pass=false (process): selector succeeded=false",
      "risk_pass=false (risk): failed command observed; failed_first_tree_command: first-tree tree tree /foo exited 2",
    ]);
  });
});
