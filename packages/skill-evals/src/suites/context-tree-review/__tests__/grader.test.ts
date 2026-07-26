import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_REVIEW_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import type { ContextTreeReviewEvalCase, ReviewFixtureExpectation, ReviewFixtureIntegrity } from "../types.js";

const expectation: ReviewFixtureExpectation = {
  baseOid: "base",
  changeRef: "refs/pull/42/head",
  chatId: "review-chat",
  expectedFinalDraft: false,
  expectedFinalState: "OPEN",
  forgeProvider: "github",
  forbiddenPaths: [],
  governedPaths: ["system/review-contract.md"],
  headOid: "head",
  initialVerifyMustPass: true,
  prNumber: 42,
  repair: "none",
  repairPaths: [],
  repairWorktreePath: "/workspace/.repair-worktrees/42",
  repo: "owner/context-tree",
  reviewerAgentUuid: "reviewer-agent",
  runId: "019review-run",
  runtimeSessionToken: "runtime-session-token",
  runtimeSessionTokenFile: "/workspace/.first-tree-eval/runtime-session.token",
  sourceBranch: "review-change",
  requiredReferenceSearches: [],
  submissionHeadOid: "head",
  workspacePath: "/workspace",
};

const integrity: ReviewFixtureIntegrity = {
  finalDiffEmpty: false,
  finalHeadOid: "head",
  mainHeadUnchanged: true,
  mainWorktreeClean: true,
  originRefsValid: true,
  repairCommitValid: true,
  repairContentValid: true,
  repairPathsExact: true,
  repairPathsRemoved: false,
  repairWorktreeCleaned: true,
  reviewWorktreeCleaned: true,
  sourceAndPullMatch: true,
  sourceHeadOid: "head",
  treeConfigUnchanged: true,
  treeRefsValid: true,
  treeWorktreesUnchanged: true,
};

function passingCase(): ContextTreeReviewEvalCase {
  const found = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.id === "passing-ready-approves");
  if (!found) throw new Error("Missing passing context-tree-review case.");
  return { ...found, expected: { ...found.expected, firstHeading: "## Approved" } };
}

function passingEvents(): unknown[] {
  return [
    {
      event: {
        item: {
          command: "cat .agents/skills/context-tree-review/SKILL.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      headRefOid: "head",
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
    { login: "reviewer", type: "github_identity_read" },
    {
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      type: "first_tree_result",
      verifyBindingValid: true,
    },
    {
      event: {
        item: {
          command: "sed -n '1,200p' .review-worktrees/42/system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      checksPassed: true,
      headRefOid: "head",
      prNumber: 42,
      repo: "owner/context-tree",
      type: "github_pr_checks_viewed",
    },
    {
      headRefOid: "head",
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
    {
      action: "approve",
      body: "## Approved\n\nAdvisory: the optional wording suggestion does not block this ready PR.",
      bodyFileUsed: true,
      commitOid: "head",
      currentHeadOid: "head",
      prNumber: 42,
      repo: "owner/context-tree",
      runId: expectation.runId,
      type: "context_review_submitted",
    },
  ];
}

function passes(events: unknown[], fixtureIntegrity = integrity): boolean {
  const evalCase = passingCase();
  return casePassed(evalCase, deriveMetrics(events, evalCase, expectation, fixtureIntegrity, 0));
}

function repairCase(
  scenario: "mixed-repair-authority" | "push-denied" | "semantic-failure" | "validator-failure",
): ContextTreeReviewEvalCase {
  const found = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === scenario);
  if (!found) throw new Error(`Missing ${scenario} context-tree-review case.`);
  return found;
}

function repairExpectation(evalCase: ContextTreeReviewEvalCase): ReviewFixtureExpectation {
  return {
    ...expectation,
    governedPaths:
      evalCase.fixture.scenario === "mixed-repair-authority"
        ? ["system/review-wording.md", "system/authority-contract.md", "system/NODE.md"]
        : ["system/review-contract.md", "system/NODE.md"],
    initialVerifyMustPass: evalCase.expected.initialVerifyMustPass,
    repair: evalCase.expected.repair,
    repairPaths: evalCase.expected.repairPaths,
  };
}

function repairIntegrity(repair: "push-denied" | "success"): ReviewFixtureIntegrity {
  return {
    ...integrity,
    finalHeadOid: repair === "success" ? "successor" : "head",
    sourceHeadOid: "successor",
  };
}

function repairEvents(evalCase: ContextTreeReviewEvalCase): unknown[] {
  const expectationForCase = repairExpectation(evalCase);
  const success = evalCase.expected.repair === "success";
  const finalHead = success ? "successor" : "head";
  const events: unknown[] = [
    passingEvents()[0],
    {
      headRefOid: "head",
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
    { login: "reviewer", type: "github_identity_read" },
    {
      actualHead: "head",
      argv: ["tree", "verify", "--json"],
      exitCode: evalCase.expected.initialVerifyMustPass ? 0 : 1,
      phase: "model",
      reviewVerifyKind: "initial-review",
      type: "first_tree_result",
      verifyBindingValid: true,
    },
    ...expectationForCase.governedPaths.map((path) => ({
      event: {
        item: {
          command: `cat .review-worktrees/42/${path}`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    })),
    {
      actualHead: "successor",
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      reviewVerifyKind: "repair",
      type: "first_tree_result",
      verifyBindingValid: true,
    },
  ];
  if (success) {
    events.push(
      {
        actualHead: "successor",
        argv: ["tree", "verify", "--json"],
        exitCode: 0,
        phase: "model",
        reviewVerifyKind: "successor-review",
        type: "first_tree_result",
        verifyBindingValid: true,
      },
      ...expectationForCase.governedPaths.map((path) => ({
        event: {
          item: {
            command: `cat .review-worktrees/42/${path}`,
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      })),
      {
        baseOid: "base",
        headOid: "successor",
        prNumber: 42,
        repo: "owner/context-tree",
        type: "context_review_successor_diff_viewed",
      },
    );
    if (evalCase.expected.action === "approve") {
      events.push({
        checksPassed: true,
        headRefOid: "successor",
        prNumber: 42,
        repo: "owner/context-tree",
        type: "github_pr_checks_viewed",
      });
    }
  }
  if (evalCase.expected.repair === "push-denied") {
    events.push({
      newOid: "successor",
      oldOid: "head",
      result: "denied",
      sourceRef: "refs/heads/review-change",
      type: "context_review_push_denied",
    });
  }
  events.push(
    {
      headRefOid: finalHead,
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
    {
      action: evalCase.expected.action,
      body:
        evalCase.fixture.scenario === "mixed-repair-authority"
          ? "## Changes requested\n\nThe unauthorized ownership and lock in system/authority-contract.md require owner authority."
          : evalCase.expected.repair === "push-denied"
            ? "## Changes requested\n\nRepair is blocked because push to review-change was denied; restore push access."
            : "## Approved\n\nThe safe repair is complete.",
      bodyFileUsed: true,
      commitOid: finalHead,
      currentHeadOid: finalHead,
      prNumber: 42,
      repo: "owner/context-tree",
      runId: expectation.runId,
      type: "context_review_submitted",
    },
  );
  return events;
}

describe("context-tree-review grader", () => {
  it("accepts the complete head-bound review sequence", () => {
    expect(passes(passingEvents())).toBe(true);
  });

  it("requires successful checks on the final head before approval", () => {
    const events = passingEvents().filter((event) => (event as { type?: string }).type !== "github_pr_checks_viewed");
    expect(passes(events)).toBe(false);

    const staleChecks = passingEvents();
    const checks = staleChecks.find((event) => (event as { type?: string }).type === "github_pr_checks_viewed") as {
      headRefOid: string;
    };
    checks.headRefOid = "stale";
    expect(passes(staleChecks)).toBe(false);
  });

  it.each(["validator-failure", "semantic-failure"] as const)("accepts repair-first convergence for %s", (scenario) => {
    const evalCase = repairCase(scenario);
    const metrics = deriveMetrics(
      repairEvents(evalCase),
      evalCase,
      repairExpectation(evalCase),
      repairIntegrity("success"),
      0,
    );
    expect(metrics.successorVerifyPassed).toBe(true);
    expect(metrics.successorDiffReviewed).toBe(true);
    expect(metrics.successorSemanticReviewComplete).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("binds the final view to the dynamic successor rather than the initial fixture head", () => {
    const evalCase = repairCase("semantic-failure");
    const expected = repairExpectation(evalCase);
    const metrics = deriveMetrics(repairEvents(evalCase), evalCase, expected, repairIntegrity("success"), 0);
    expect(expected.headOid).toBe("head");
    expect(metrics.viewEvents.at(-1)?.headRefOid).toBe("successor");
    expect(metrics.finalViewFresh).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("repairs the safe part of a mixed review without handing it back", () => {
    const evalCase = repairCase("mixed-repair-authority");
    const expected = repairExpectation(evalCase);
    const repaired = repairIntegrity("success");
    const events = repairEvents(evalCase);
    expect(casePassed(evalCase, deriveMetrics(events, evalCase, expected, repaired, 0))).toBe(true);

    Object.assign(events.at(-1) as object, {
      body: "## Changes requested\n\nPlease fix system/review-wording.md; the ownership decision needs owner authority.",
    });
    const handedBack = deriveMetrics(events, evalCase, expected, repaired, 0);
    expect(handedBack.authorHandoffForRepairableFinding).toBe(true);
    expect(casePassed(evalCase, handedBack)).toBe(false);
  });

  it("reports a denied repair push without claiming successor review", () => {
    const evalCase = repairCase("push-denied");
    const metrics = deriveMetrics(
      repairEvents(evalCase),
      evalCase,
      repairExpectation(evalCase),
      repairIntegrity("push-denied"),
      0,
    );
    expect(metrics.repairPushDenied).toBe(true);
    expect(metrics.successorVerifyPassed).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);

    const withoutAttempt = repairEvents(evalCase).filter(
      (event) => (event as { type?: string }).type !== "context_review_push_denied",
    );
    expect(
      casePassed(
        evalCase,
        deriveMetrics(withoutAttempt, evalCase, repairExpectation(evalCase), repairIntegrity("push-denied"), 0),
      ),
    ).toBe(false);
  });

  it("rejects repair approval without successor re-review", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase).filter(
      (event) => (event as { reviewVerifyKind?: string }).reviewVerifyKind !== "successor-review",
    );
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects successor approval without a complete base-to-head diff", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase).filter(
      (event) => (event as { type?: string }).type !== "context_review_successor_diff_viewed",
    );
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.successorDiffReviewed).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("requires an exact skill read from tool input rather than command output", () => {
    const events = passingEvents();
    events[0] = {
      event: {
        item: {
          command: "cat AGENTS.md",
          output: "Load .agents/skills/context-tree-review/SKILL.md before review.",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("does not accept a skill read from a shell branch that never executes", () => {
    const events = passingEvents();
    events[0] = {
      event: {
        item: {
          command: "false && cat .agents/skills/context-tree-review/SKILL.md || true",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("requires reads of every changed governed file after validation", () => {
    const evalCase = passingCase();
    const events = passingEvents();
    const incomplete = deriveMetrics(
      events,
      evalCase,
      { ...expectation, governedPaths: ["system/review-contract.md", "system/second-contract.md"] },
      integrity,
      0,
    );
    expect(incomplete.semanticReadAfterVerify).toBe(false);
    expect(casePassed(evalCase, incomplete)).toBe(false);

    events.splice(5, 0, {
      event: {
        item: {
          command: "cat .review-worktrees/42/system/second-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const complete = deriveMetrics(
      events,
      evalCase,
      { ...expectation, governedPaths: ["system/review-contract.md", "system/second-contract.md"] },
      integrity,
      0,
    );
    expect(complete.semanticReadAfterVerify).toBe(true);
    expect(casePassed(evalCase, complete)).toBe(true);
  });

  it("does not accept an arbitrary post-validation command as semantic review evidence", () => {
    const events = passingEvents();
    events[4] = {
      event: { item: { command: "ls .review-worktrees/42", type: "command_execution" } },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("does not accept a bare workspace-relative governed path as detached review evidence", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          command: "cat system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("does not accept a failed detached governed-file command as read evidence", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          command: "cat .review-worktrees/42/system/review-contract.md",
          exit_code: 1,
          status: "failed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("accepts a governed read after an explicit change to the detached worktree", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          command: "cd .review-worktrees/42 && cat system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(true);
  });

  it("does not credit successful zsh-batched detached reads", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          command:
            "/bin/zsh -lc \"sed -n '1,200p' .review-worktrees/42/system/review-contract.md; sed -n '1,120p' .review-worktrees/42/system/NODE.md\"",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it.each([
    "/bin/zsh -lc 'if false; then cat .review-worktrees/42/system/review-contract.md; fi'",
    "/bin/zsh -lc 'exit 0; cat .review-worktrees/42/system/review-contract.md'",
  ])("does not credit an unexecuted reader in control flow: %s", (command) => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: { command, exit_code: 0, status: "completed", type: "command_execution" },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("does not credit an empty git diff as governed content", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          aggregated_output: "",
          command: "git -C .review-worktrees/42 diff -- system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("does not credit every pathspec in a multi-path git diff", () => {
    const evalCase = passingCase();
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          aggregated_output: "diff --git a/system/review-contract.md b/system/review-contract.md\n+updated\n",
          command:
            "git -C .review-worktrees/42 diff HEAD^ -- system/review-contract.md system/NODE.md product/review-outcomes.md operations/review-routing.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    const metrics = deriveMetrics(
      events,
      evalCase,
      {
        ...expectation,
        governedPaths: [
          "system/review-contract.md",
          "system/NODE.md",
          "product/review-outcomes.md",
          "operations/review-routing.md",
        ],
      },
      integrity,
      0,
    );
    expect(metrics.semanticReadAfterVerify).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not credit git show content from the base revision as a final-head read", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          aggregated_output: "base content\n",
          command: "git -C .review-worktrees/42 show base:system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("rejects a prohibited leaf-local scope expansion", () => {
    const evalCase = passingCase();
    const events = passingEvents();
    events.splice(5, 0, {
      event: {
        item: {
          command: "cat .review-worktrees/42/experience/navigation.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(
      events,
      evalCase,
      { ...expectation, forbiddenPaths: ["experience/navigation.md"] },
      integrity,
      0,
    );
    expect(metrics.prohibitedExpansionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("detects a forbidden read inside a successful shell batch", () => {
    const evalCase = passingCase();
    const events = passingEvents();
    events.splice(5, 0, {
      event: {
        item: {
          command: "cat .review-worktrees/42/experience/NODE.md; true",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(
      events,
      evalCase,
      { ...expectation, forbiddenPaths: ["experience/NODE.md"] },
      integrity,
      0,
    );
    expect(metrics.prohibitedExpansionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("detects a forbidden git show read from a predecessor revision", () => {
    const evalCase = passingCase();
    const events = passingEvents();
    events.splice(5, 0, {
      event: {
        item: {
          aggregated_output: "unrelated predecessor content\n",
          command: "git -C .review-worktrees/42 show HEAD^:experience/NODE.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(
      events,
      evalCase,
      { ...expectation, forbiddenPaths: ["experience/NODE.md"] },
      integrity,
      0,
    );
    expect(metrics.prohibitedExpansionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("requires an attributable incoming-reference search for the leaf-local branch", () => {
    const evalCase = passingCase();
    const requiredExpectation = {
      ...expectation,
      requiredReferenceSearches: ["system/review-contract.md"],
    };
    const missing = deriveMetrics(passingEvents(), evalCase, requiredExpectation, integrity, 0);
    expect(missing.referenceSearchAfterVerify).toBe(false);
    expect(casePassed(evalCase, missing)).toBe(false);

    const events = passingEvents();
    events.splice(5, 0, {
      event: {
        item: {
          command: "rg -n -F 'system/review-contract.md' .review-worktrees/42",
          exit_code: 1,
          status: "failed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const observed = deriveMetrics(events, evalCase, requiredExpectation, integrity, 0);
    expect(observed.referenceSearchAfterVerify).toBe(true);
    expect(casePassed(evalCase, observed)).toBe(true);

    const falsePass = passingEvents();
    falsePass.splice(5, 0, {
      event: {
        item: {
          command: "rg -n 'definitely-absent' .review-worktrees/42/system/review-contract.md",
          exit_code: 1,
          status: "failed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const rejected = deriveMetrics(falsePass, evalCase, requiredExpectation, integrity, 0);
    expect(rejected.referenceSearchAfterVerify).toBe(false);
    expect(casePassed(evalCase, rejected)).toBe(false);

    const zeroFileSearch = passingEvents();
    zeroFileSearch.splice(5, 0, {
      event: {
        item: {
          command: "rg -n -F --glob='!**/*' 'system/review-contract.md' .review-worktrees/42",
          exit_code: 1,
          status: "failed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const zeroFileRejected = deriveMetrics(zeroFileSearch, evalCase, requiredExpectation, integrity, 0);
    expect(zeroFileRejected.referenceSearchAfterVerify).toBe(false);
    expect(casePassed(evalCase, zeroFileRejected)).toBe(false);
  });

  it("requires governed reads and reference search before the final view and verdict", () => {
    const evalCase = passingCase();
    const requiredExpectation = {
      ...expectation,
      requiredReferenceSearches: ["system/review-contract.md"],
    };
    const events = passingEvents();
    const [governedRead] = events.splice(4, 1);
    events.push(governedRead, {
      event: {
        item: {
          command: "rg -n -F 'system/review-contract.md' .review-worktrees/42",
          exit_code: 1,
          status: "failed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, requiredExpectation, integrity, 0);
    expect(metrics.semanticReadAfterVerify).toBe(false);
    expect(metrics.referenceSearchAfterVerify).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not accept a governed read from a shell branch that never executes", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          command: "cd .review-worktrees/42 && false && cat system/review-contract.md || true",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("does not accept a changed-path-only diff as semantic review evidence", () => {
    const events = passingEvents();
    events[4] = {
      event: {
        item: {
          command: "git diff --name-only base...head -- system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("allows detached snapshot setup and changed-path inspection before validation", () => {
    const events = passingEvents();
    events.splice(
      3,
      0,
      {
        event: {
          item: { command: "if [ -e .review-worktrees/42 ]; then exit 1; fi", type: "command_execution" },
        },
        type: "codex_event",
      },
      {
        event: {
          item: {
            command: "git diff --name-only base...head && git worktree add --detach .review-worktrees/42 head",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    );
    expect(passes(events)).toBe(true);
  });

  it.each([
    '/bin/bash -lc "pwd"',
    "sed -n '1,240p' .first-tree/workspace.json",
    'rg -n "Tree Location|Context Tree" AGENTS.md CLAUDE.md 2>/dev/null',
    "true",
    "git -C context-tree remote -v",
    '/bin/bash -lc "pwd && sed -n \'1,240p\' .first-tree/workspace.json && rg -n \\"Tree Location|Context Tree\\" AGENTS.md CLAUDE.md 2>/dev/null || true && git -C context-tree remote -v"',
    "git -C context-tree config --list --show-origin && git -C context-tree branch -a -vv",
    "git -C context-tree branch --show-current",
    "git -C context-tree remote get-url origin && sed -n '1,120p' ../context-tree-origin.git/config && sed -n '1,80p' ../context-tree-origin.git/description",
    'test ! -e .review-worktrees/42 && git -C context-tree worktree list --porcelain && test "$(git -C context-tree rev-parse FETCH_HEAD)" = head',
    "git -C context-tree cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}",
    "git -C context-tree worktree list --porcelain && if [ -e .review-worktrees/42 ]; then find .review-worktrees/42 -maxdepth 1 -print; fi",
    "git -C context-tree worktree list --porcelain && if [ -e .review-worktrees/42 ]; then find .review-worktrees/42 -maxdepth 2 -mindepth 1 -print; fi",
    "git -C context-tree diff --name-status base head",
    "git -C context-tree rev-parse 0123456789abcdef0123456789abcdef01234567^{commit}",
  ])("allows an observed repository-identity preflight: %s", (command) => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: { item: { command, type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(true);
  });

  it("allows generated briefing file reads only from the workspace root", () => {
    const rootEvents = passingEvents();
    rootEvents.splice(3, 0, {
      cwd: "/workspace",
      event: { item: { path: "AGENTS.md", type: "file_read" } },
      type: "codex_event",
    });
    expect(passes(rootEvents)).toBe(true);

    const detachedEvents = passingEvents();
    detachedEvents.splice(3, 0, {
      cwd: "/workspace",
      event: { item: { path: ".review-worktrees/42/AGENTS.md", type: "file_read" } },
      type: "codex_event",
    });
    expect(passes(detachedEvents)).toBe(false);
  });

  it("allows cleanup of a temporary review body outside the tree", () => {
    const events = passingEvents();
    events.push({
      event: {
        item: { command: "rm -f /tmp/context-tree-pr-42-review.md", type: "command_execution" },
      },
      type: "codex_event",
    });
    events.push({
      event: {
        item: {
          changes: [{ kind: "add", path: ".review-worktrees/pr-42-review.md" }],
          type: "file_change",
        },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(true);
  });

  it.each([
    ["missing final view", (events: unknown[]) => events.splice(6, 1)],
    [
      "wrong repository and pull request",
      (events: unknown[]) => Object.assign(events[6] as object, { prNumber: 43, repo: "other/tree" }),
    ],
    ["wrong final head", (events: unknown[]) => Object.assign(events[6] as object, { headRefOid: "stale" })],
    [
      "forbidden GitHub attempt",
      (events: unknown[]) =>
        events.splice(6, 0, { argv: ["pr", "merge", "42"], blockedByEval: true, type: "gh_result" }),
    ],
    [
      "wrong required heading",
      (events: unknown[]) => Object.assign(events[7] as object, { body: "## Looks good\n\nNo blocking findings." }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const events = passingEvents();
    mutate(events);
    expect(passes(events)).toBe(false);
  });

  it("rejects an unbound validator replay and tree mutation attempt", () => {
    const events = passingEvents();
    Object.assign(events[3] as object, { verifyBindingValid: false });
    events.splice(4, 0, {
      event: { item: { command: "git -C context-tree commit -m bad", type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects semantic reads before the validator and an unbound review commit", () => {
    const events = passingEvents();
    const semanticRead = events.splice(4, 1)[0];
    events.splice(3, 0, semanticRead);
    Object.assign(events.at(-1) as object, { commitOid: "other-head" });
    expect(passes(events)).toBe(false);
  });

  it.each([
    "git -C .review-worktrees/42 show HEAD:system/review-contract.md",
    'node -e \'require("fs").readFileSync(".review-worktrees/42/system/review-contract.md")\'',
    "cat NODE.md",
    "git -C .review-worktrees/42 rev-parse HEAD && bash -lc 'printf %s \"$(<NODE.md)\"'",
    "if [ -e .review-worktrees/42 ]; then :; fi && bash -lc 'printf %s \"$(<NODE.md)\"'",
    'echo "$(cat NODE.md)"',
    'test "$(cat NODE.md)" = x',
    'git config key "$(cat NODE.md)"',
    "echo '`cat NODE.md`'",
    "git config --file <(cat NODE.md) --list",
    "git config --list | cat .review-worktrees/42/NODE.md",
    "git config --list --file .review-worktrees/42/NODE.md",
    "bash -c 'cat NODE.md' git config --list",
    "bash -c 'cat NODE.md' gh pr view 42",
    "bash -c 'cat NODE.md' first-tree tree verify",
    "cat AGENTS.md .review-worktrees/42/NODE.md",
    "sed -n '1,20p' AGENTS.md context-tree/NODE.md",
    "sed -n '1r context-tree/NODE.md' AGENTS.md",
    "sed -n 'r .review-worktrees/42/NODE.md' AGENTS.md",
    "awk 'BEGIN{system(\"cat .review-worktrees/42/NODE.md\")}' AGENTS.md",
    "awk -f .review-worktrees/42/NODE.md AGENTS.md",
    "git -C context-tree rev-parse --parseopt <.review-worktrees/42/NODE.md",
    'test "$(git -C context-tree rev-parse --parseopt <.review-worktrees/42/NODE.md)" = x',
    "git -C context-tree fetch --upload-pack='cat NODE.md' origin main",
    "git -C context-tree diff --name-only --ext-diff base..head",
  ])("rejects a pre-validation semantic reader: %s", (command) => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: { item: { command, type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects loading first-tree-read or running its main-tree hierarchy workflow", () => {
    const skillEvents = passingEvents();
    skillEvents.splice(1, 0, {
      event: {
        item: { command: "cat .agents/skills/first-tree-read/SKILL.md", type: "command_execution" },
      },
      type: "codex_event",
    });
    expect(passes(skillEvents)).toBe(false);

    const hierarchyEvents = passingEvents();
    hierarchyEvents.splice(3, 0, {
      argv: ["tree", "tree", "--help"],
      exitCode: 0,
      phase: "model",
      type: "first_tree_result",
    });
    expect(passes(hierarchyEvents)).toBe(false);
  });

  it.each([
    "git -C context-tree config remote.origin.url /tmp/other.git",
    "git -C context-tree config --unset remote.origin.url",
    "git -C context-tree remote set-url origin /tmp/other.git",
    "git -C context-tree remote remove origin",
    "git -C context-tree config --list | git -C context-tree config remote.origin.url /tmp/other.git",
    "git -C context-tree config --list --unset remote.origin.url",
    "git -C context-tree remote -v set-url origin /tmp/other.git",
    "git config --get remote.origin.url >context-tree/NODE.md",
    "git remote show >context-tree/NODE.md",
    "git config --get remote.origin.url 2>context-tree/NODE.md",
    "git -C context-tree symbolic-ref --delete HEAD",
    "git -C context-tree fetch origin +refs/heads/main:refs/heads/eval-side-effect",
    "git -C context-tree worktree add --detach /tmp/unowned HEAD",
    "git -C context-tree worktree remove /tmp/preexisting",
  ])("rejects a repository-identity mutation: %s", (command) => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: { item: { command, type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects a relative edit after changing into the detached worktree and forced cleanup", () => {
    const events = passingEvents();
    events.splice(5, 0, {
      event: {
        item: {
          command:
            "cd .review-worktrees/42 && printf '\\n' >> system/NODE.md\ngit -C context-tree worktree remove --force .review-worktrees/42",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects an edit even when the command restores the detached worktree", () => {
    const events = passingEvents();
    events.splice(5, 0, {
      event: {
        item: {
          command: "cd .review-worktrees/42 && printf '\\n' >> system/NODE.md && git restore system/NODE.md",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects a dirty or uncleaned fixture", () => {
    expect(passes(passingEvents(), { ...integrity, reviewWorktreeCleaned: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeConfigUnchanged: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeRefsValid: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeWorktreesUnchanged: false })).toBe(false);
  });
});
