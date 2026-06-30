import { describe, expect, it } from "vitest";

import type { SkillEvalCase } from "../case-schema.js";
import type { SkillEvalSuiteDefinition } from "../coverage.js";
import { buildPeriodicSummary, formatPeriodicSummary } from "../periodic.js";

function evalCase(overrides: Partial<SkillEvalCase> = {}): SkillEvalCase {
  return {
    briefingMode: "minimal",
    expected: {},
    fixture: {},
    id: "periodic-smoke",
    prompt: "Run the periodic smoke case.",
    skill: "first-tree-welcome",
    status: "planned",
    tier: "periodic",
    ...overrides,
  };
}

function suite(cases: readonly SkillEvalCase[]): SkillEvalSuiteDefinition {
  return {
    cases,
    coverage: {
      skill: "first-tree-welcome",
      tiers: [
        {
          caseIds: ["floor-coverage"],
          description: "Synthetic floor coverage.",
          status: "implemented",
          tier: "floor",
        },
        {
          caseIds: ["gate-smoke"],
          description: "Synthetic gate coverage.",
          status: "implemented",
          tier: "gate",
        },
      ],
    },
    skill: "first-tree-welcome",
  };
}

describe("periodic summary", () => {
  it("returns a clear no-op summary when no periodic cases are selected", () => {
    const summary = buildPeriodicSummary([suite([])], {
      caseId: null,
      suite: null,
    });

    expect(summary).toMatchObject({
      command: "eval:periodic",
      failed: 0,
      passed: 0,
      planned: 0,
      selected: [],
      skipped: 0,
    });
    expect(formatPeriodicSummary(summary)).toContain("No implemented periodic cases selected.");
  });

  it("reports selected planned periodic cases as skipped", () => {
    const summary = buildPeriodicSummary(
      [
        suite([
          evalCase({
            id: "welcome-full-matrix",
          }),
        ]),
      ],
      {
        caseId: "welcome-full-matrix",
        suite: "first-tree-welcome",
      },
      "2026-06-30T00:00:00.000Z",
    );

    expect(summary).toEqual({
      command: "eval:periodic",
      failed: 0,
      passed: 0,
      planned: 1,
      runStartedAt: "2026-06-30T00:00:00.000Z",
      selected: [
        {
          caseId: "welcome-full-matrix",
          skill: "first-tree-welcome",
          status: "planned",
        },
      ],
      skipped: 1,
    });
    expect(formatPeriodicSummary(summary)).toContain("- first-tree-welcome:welcome-full-matrix (planned)");
  });

  it("fails specifically when a requested periodic case does not exist", () => {
    expect(() =>
      buildPeriodicSummary([suite([])], {
        caseId: "missing-case",
        suite: "first-tree-welcome",
      }),
    ).toThrow("No periodic case 'missing-case' found for suite first-tree-welcome.");
  });

  it("fails specifically if an implemented periodic case is selected before a runner exists", () => {
    expect(() =>
      buildPeriodicSummary(
        [
          suite([
            evalCase({
              id: "implemented-periodic",
              status: "implemented",
            }),
          ]),
        ],
        {
          caseId: null,
          suite: null,
        },
      ),
    ).toThrow(
      "Implemented periodic cases selected but no periodic runner is registered yet: first-tree-welcome:implemented-periodic.",
    );
  });
});
