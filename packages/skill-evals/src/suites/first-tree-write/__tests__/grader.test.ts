import { describe, expect, it } from "vitest";

import { FIRST_TREE_WRITE_GATE_CASES } from "../cases.js";
import { casePassed } from "../grader.js";
import type { EvalMetrics, FirstTreeWriteEvalCase } from "../types.js";

function findCase(id: string): FirstTreeWriteEvalCase {
  const evalCase = FIRST_TREE_WRITE_GATE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function baseMetrics(overrides: Partial<EvalMetrics>): EvalMetrics {
  return {
    expectedDiffSnippetsObserved: true,
    expectedResponseObserved: true,
    finalResponse: "Done.",
    firstTreeArgv: [],
    firstTreeCommandResults: [],
    fixtureValidationOk: true,
    forbiddenContentHits: [],
    runnerExitCode: 0,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    treeChanged: false,
    treeDiff: "",
    treeStatus: "",
    verifySucceeded: false,
    ...overrides,
  };
}

describe("first-tree-write grader", () => {
  it("passes no-source when the model reads the skill, refuses, and leaves the tree unchanged", () => {
    expect(
      casePassed(findCase("no-source-refuses"), baseMetrics({ finalResponse: "Please provide a source artifact." })),
    ).toBe(true);
  });

  it("fails no-source when the tree changed", () => {
    expect(
      casePassed(
        findCase("no-source-refuses"),
        baseMetrics({
          treeChanged: true,
          treeDiff: "+Unexpected write\n",
          treeStatus: " M system/context-management/skill-eval-framework.md\n",
        }),
      ),
    ).toBe(false);
  });

  it("passes durable source when the tree changes and verify succeeds", () => {
    expect(
      casePassed(
        findCase("durable-source-writes"),
        baseMetrics({
          finalResponse: "Updated the tree and verify passed.",
          treeChanged: true,
          treeDiff: "+Deterministic gates are separate from quality judges.\n",
          treeStatus: " M system/context-management/skill-eval-framework.md\n",
          verifySucceeded: true,
        }),
      ),
    ).toBe(true);
  });
});
