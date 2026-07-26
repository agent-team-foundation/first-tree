import { describe, expect, it } from "vitest";

import { gradingFailureMessages } from "../../../core/grading.js";
import { casePassed, deriveMetrics } from "../metrics.js";
import { buildGrading } from "../summary.js";
import type { EvalMetrics, FixtureValidation } from "../types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const SELECTOR_ARGV = ["tree", "tree", "/domains/payments"];
const BYO_READ_HELP_ARGV = ["tree", "read", "--help"];
const BYO_ACTIVATION_ARGV = [
  "--json",
  "tree",
  "read",
  "--team",
  "team-byo-read-eval",
  "--snapshot",
  "/tmp/read-task/context-tree",
];
const BYO_SELECTOR_ARGV = ["tree", "tree", "--no-pull", "systems/server/auth"];
const EXACT_COMMIT = "a".repeat(40);
const EXPECTED_FACT = "payments runbook anchor";
const JWT_EXPECTED_FACTS = [
  "User JWT auth is the unified authorization surface.",
  "Route scopes must be checked against live organization membership before cross-org actions.",
  "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
] as const;

const VALID_FIXTURE: FixtureValidation = {
  domainNodeCount: 2,
  errors: [],
  minDepthOk: true,
  ok: true,
  requiredFilesOk: true,
  verifyResult: null,
};

function skillReadEvent(): unknown {
  return {
    event: {
      command: "sed -n 1,200p skills/first-tree-read/SKILL.md",
      type: "tool_call",
    },
    type: "codex_event",
  };
}

function assistantTextEvent(text: string): unknown {
  return {
    event: {
      content: text,
      type: "assistant_message",
    },
    type: "codex_event",
  };
}

function firstTreeCall(argv: readonly string[]): unknown {
  return {
    argv: [...argv],
    phase: "model",
    type: "first_tree_call",
  };
}

function firstTreeResult(argv: readonly string[], exitCode: number, extra: Record<string, unknown> = {}): unknown {
  return {
    argv: [...argv],
    exitCode,
    phase: "model",
    type: "first_tree_result",
    ...extra,
  };
}

function metrics(events: readonly unknown[]): EvalMetrics {
  return deriveMetrics(events, VALID_FIXTURE, 0, [EXPECTED_FACT]);
}

describe("first-tree-read metrics pass criteria", () => {
  it("passes trigger cases only when skill read, facts, help, selector, and command results are all OK", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.skillFileReadObserved).toBe(true);
    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(true);
  });

  it("passes explicit-Team BYO cases only for one ordered activation and exact detached no-pull selectors", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(BYO_READ_HELP_ARGV),
      firstTreeResult(BYO_READ_HELP_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readHelpSucceeded).toBe(true);
    expect(result.readActivationCalls).toBe(1);
    expect(result.readActivationSucceeded).toBe(true);
    expect(result.byoReadSequenceOk).toBe(true);
    expect(result.byoSelectorsNoPull).toBe(true);
    expect(result.byoSnapshotDetached).toBe(true);
    expect(result.byoSnapshotExactHeadConsistent).toBe(true);
    expect(casePassed(true, result, "byo")).toBe(true);
  });

  it("fails BYO cases when activation is repeated or selectors can refresh", () => {
    const mutableSelector = ["tree", "tree", "systems/server/auth"];
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(BYO_READ_HELP_ARGV),
      firstTreeResult(BYO_READ_HELP_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(mutableSelector),
      firstTreeResult(mutableSelector, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readActivationCalls).toBe(2);
    expect(result.readActivationSucceeded).toBe(false);
    expect(result.byoSelectorsNoPull).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("fails trigger cases when facts are present but help is missing", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(false);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails trigger cases when help succeeds but no selector succeeds", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(false);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails trigger cases when any model-phase first-tree result is non-zero, including later selector failures", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      firstTreeCall(["tree", "tree", "/domains/payments/deep-dive"]),
      firstTreeResult(["tree", "tree", "/domains/payments/deep-dive"], 2),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("recognizes strict expected fact concepts in translated or paraphrased final answers", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes 要遵守这些约束：
- User JWT 是统一授权面。
- Route scopes 必须结合当前 live organization membership checks。
- HTTP routes 和 multi-org 改动必须遵循 docs/development/http-path-conventions.md。`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
    expect(casePassed(true, result)).toBe(true);
  });

  it("recognizes the user JWT authorization surface when phrased as single authorization surface", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes should:
- Use user JWT auth as the single authorization surface.
- Check route scopes against live organization membership before cross-org actions.
- Follow docs/development/http-path-conventions.md before auth or multi-org route changes.`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
  });

  it("recognizes the natural unified user JWT authorization surface word order", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes should:
- Use the unified user JWT authorization surface.
- Check route scopes against live organization membership before cross-org actions.
- Follow the repository's HTTP path conventions before auth or multi-org route changes.`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
  });

  it("does not count isolated terms as expected fact concepts", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent("This only mentions User JWT, route scopes, and path conventions as loose keywords."),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([]);
    expect(result.expectedFactsObserved).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails bypassed trigger cases when facts appear without a first-tree tree tree selector command", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("maps trigger process failures into deterministic grading output", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);
    const grading = buildGrading("read-grading-test", result, true, casePassed(true, result));

    expect(grading.passed).toBe(false);
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: false,
      risk_pass: true,
      routing_pass: true,
    });
    expect(gradingFailureMessages(grading)[0]).toContain("process_pass=false");
  });

  it("keeps non-trigger cases green when no skill hit, facts, or commands occur", () => {
    const result = metrics([assistantTextEvent("This answer stays outside the Context Tree topic.")]);

    expect(result.skillHit).toBe(false);
    expect(result.expectedFactHits).toEqual([]);
    expect(result.firstTreeCalls).toBe(0);
    expect(result.firstTreeCommandResults).toEqual([]);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(false, result)).toBe(true);
  });

  it("fails non-trigger cases on any model-phase first-tree command usage or non-zero result", () => {
    const usageResult = metrics([firstTreeCall(HELP_ARGV)]);
    const nonZeroResult = metrics([firstTreeResult(["doctor"], 1)]);

    expect(usageResult.skillHit).toBe(true);
    expect(casePassed(false, usageResult)).toBe(false);
    expect(nonZeroResult.skillHit).toBe(true);
    expect(nonZeroResult.modelFirstTreeCommandsOk).toBe(false);
    expect(casePassed(false, nonZeroResult)).toBe(false);
  });
});
