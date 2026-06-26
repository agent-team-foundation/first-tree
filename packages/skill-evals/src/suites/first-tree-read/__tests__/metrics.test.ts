import { describe, expect, it } from "vitest";

import { casePassed, deriveMetrics } from "../metrics.js";
import type { EvalMetrics, FixtureValidation } from "../types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const SELECTOR_ARGV = ["tree", "tree", "/domains/payments"];
const EXPECTED_FACT = "payments runbook anchor";

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

function firstTreeResult(argv: readonly string[], exitCode: number): unknown {
  return {
    argv: [...argv],
    exitCode,
    phase: "model",
    type: "first_tree_result",
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
