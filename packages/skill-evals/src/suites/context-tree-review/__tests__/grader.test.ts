import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_REVIEW_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { buildGrading } from "../summary.js";
import type { ContextTreeReviewEvalCase, ReviewFixtureExpectation, ReviewFixtureIntegrity } from "../types.js";

const expectation: ReviewFixtureExpectation = {
  baseOid: "base",
  chatId: "review-chat",
  expectedFinalDraft: false,
  expectedFinalHeadOid: "head",
  expectedFinalState: "OPEN",
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
      actualHead: "head",
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      reviewVerifyKind: "initial-review",
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
      phase: "model",
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
  scenario: "mixed-repair-authority" | "push-denied" | "semantic-failure",
): ContextTreeReviewEvalCase {
  const found = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === scenario);
  if (!found) throw new Error(`Missing ${scenario} context-tree-review case.`);
  return found;
}

function repairExpectation(evalCase: ContextTreeReviewEvalCase): ReviewFixtureExpectation {
  const governedPaths =
    evalCase.fixture.scenario === "mixed-repair-authority"
      ? ["system/review-wording.md", "system/authority-contract.md"]
      : ["system/review-contract.md"];
  return {
    ...expectation,
    governedPaths,
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
  const pushDenied = evalCase.expected.repair === "push-denied";
  const mixed = evalCase.fixture.scenario === "mixed-repair-authority";
  const safePath = mixed ? "system/review-wording.md" : "system/review-contract.md";
  const finalHead = pushDenied ? "head" : "successor";
  const finalAction = evalCase.expected.action;
  const finalBody = mixed
    ? "## Changes requested\n\nThe ownership and decision lock in system/authority-contract.md are proven unauthorized and require owner authority."
    : pushDenied
      ? "## Changes requested\n\nRepair is blocked: push to review-change was denied. The author must restore branch push access. system/review-contract.md"
      : "## Approved\n\nThe safely determined repair is complete and no blockers remain.";
  const events: unknown[] = [
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
      actualHead: "head",
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      reviewVerifyKind: "initial-review",
      type: "first_tree_result",
      verifyBindingValid: true,
    },
    {
      event: {
        item: {
          command: `cat .review-worktrees/42/${safePath}`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
  ];
  if (mixed) {
    events.push({
      event: {
        item: {
          command: "cat .review-worktrees/42/system/authority-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
  }
  events.push({
    headRefOid: "head",
    isDraft: false,
    prNumber: 42,
    repo: "owner/context-tree",
    state: "OPEN",
    type: "github_pr_viewed",
  });
  events.push({
    event: {
      item: {
        aggregated_output: "head\trefs/heads/review-change\n",
        command: "git -C context-tree ls-remote --heads origin review-change",
        exit_code: 0,
        status: "completed",
        type: "command_execution",
      },
    },
    type: "codex_event",
  });
  events.push(
    {
      event: {
        item: {
          changes: [{ kind: "update", path: `.repair-worktrees/42/${safePath}` }],
          type: "file_change",
        },
      },
      type: "codex_event",
    },
    {
      event: {
        item: {
          command: `git -C .repair-worktrees/42 add -- ${safePath}`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      actualHead: "successor",
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      reviewVerifyKind: "repair",
      type: "first_tree_result",
      verifyBindingValid: true,
    },
    {
      event: {
        item: {
          aggregated_output: `M  ${safePath}\n`,
          command: "git -C .repair-worktrees/42 status --short",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      event: {
        item: {
          aggregated_output: `diff --git a/${safePath} b/${safePath}\n`,
          command: "git -C .repair-worktrees/42 diff --cached --no-ext-diff base",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      event: {
        item: {
          command: "git -C .repair-worktrees/42 commit -m 'fix: repair review finding'",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      event: {
        item: {
          aggregated_output: pushDenied ? "review-change push denied by eval fixture" : "",
          command: "git -C .repair-worktrees/42 push origin HEAD:refs/heads/review-change",
          exit_code: pushDenied ? 1 : 0,
          status: pushDenied ? "failed" : "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    {
      headRefOid: finalHead,
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
  );
  if (!pushDenied) {
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
      {
        event: {
          item: {
            command: `cat .review-worktrees/42/${safePath}`,
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    );
    if (mixed) {
      events.push({
        event: {
          item: {
            command: "cat .review-worktrees/42/system/authority-contract.md",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      });
    }
    if (finalAction === "approve") {
      events.push({
        checksPassed: true,
        headRefOid: "successor",
        phase: "model",
        prNumber: 42,
        repo: "owner/context-tree",
        type: "github_pr_checks_viewed",
      });
    }
    events.push({
      headRefOid: "successor",
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    });
  }
  events.push({
    action: finalAction,
    body: finalBody,
    bodyFileUsed: true,
    commitOid: finalHead,
    currentHeadOid: finalHead,
    prNumber: 42,
    repo: "owner/context-tree",
    runId: expectation.runId,
    type: "context_review_submitted",
  });
  return events;
}

describe("context-tree-review grader", () => {
  it("accepts the complete head-bound review sequence", () => {
    expect(passes(passingEvents())).toBe(true);
  });

  it("accepts repeated validation of the same unchanged review head", () => {
    const events = passingEvents();
    events.splice(5, 0, {
      actualHead: "head",
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      reviewVerifyKind: "initial-review",
      type: "first_tree_result",
      verifyBindingValid: true,
    });
    expect(passes(events)).toBe(true);
  });

  it("accepts one exact repair commit, push, successor verify, and complete re-review", () => {
    const evalCase = repairCase("semantic-failure");
    const metrics = deriveMetrics(
      repairEvents(evalCase),
      evalCase,
      repairExpectation(evalCase),
      repairIntegrity("success"),
      0,
    );
    expect(metrics).toMatchObject({
      authorHandoffForRepairableFinding: false,
      authorizedRepairObserved: true,
      finalReviewBoundToSuccessorHead: true,
      repairCommitObserved: true,
      repairDiffObserved: true,
      repairHeadFresh: true,
      repairPathsExact: true,
      repairPushObserved: true,
      repairSequenceValid: true,
      repairSourceHeadFresh: true,
      successorSemanticReviewComplete: true,
      successorVerifyPassed: true,
      unexpectedMutationAttempted: false,
    });
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("accepts a mixed review only after safe repair and protected-only handoff", () => {
    const evalCase = repairCase("mixed-repair-authority");
    const events = repairEvents(evalCase);
    Object.assign(events.at(-1) as object, {
      body: "## Changes requested\n\nI repaired system/review-wording.md.\n\nThe ownership and decision lock in system/authority-contract.md are proven unauthorized and require owner authority.",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.authorHandoffForRepairableFinding).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects handing a safe mixed finding back with an imperative", () => {
    const evalCase = repairCase("mixed-repair-authority");
    const events = repairEvents(evalCase);
    Object.assign(events.at(-1) as object, {
      body: "## Changes requested\n\nFix system/review-wording.md before approval.\n\nThe ownership and decision lock in system/authority-contract.md are proven unauthorized and require owner authority.",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.authorHandoffForRepairableFinding).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects compound commands as required semantic-read evidence", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const successorRead = events.findLast(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(".review-worktrees/42"),
    ) as { event: { item: { command: string } } };
    successorRead.event.item.command =
      "cat .review-worktrees/42/system/review-contract.md && find .review-worktrees/42/system -type f | sort && gh pr checks 42 --repo owner/context-tree";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.successorSemanticReviewComplete).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "git -C .review-worktrees/42 diff --cached",
    "git -C .review-worktrees/42 diff wrong...HEAD",
    "false && git -C .review-worktrees/42 diff base...HEAD || true",
    "git -C .review-worktrees/42 diff base...HEAD; true",
  ])("does not accept an unbound successor diff as complete semantic review: %s", (command) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const successorRead = events.findLast(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          ".review-worktrees/42/system/review-contract.md",
        ),
    ) as { event: { item: { command: string } } };
    successorRead.event.item.command = command;
    const metrics = deriveMetrics(
      events,
      evalCase,
      repairExpectation(evalCase),
      { ...repairIntegrity("success"), finalDiffEmpty: true, repairPathsRemoved: true },
      0,
    );
    expect(metrics.successorSemanticReviewComplete).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("accepts an exact base-to-successor content diff for an empty final diff", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const successorRead = events.findLast(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          ".review-worktrees/42/system/review-contract.md",
        ),
    ) as { event: { item: { command: string } } };
    successorRead.event.item.command = "git -C .review-worktrees/42 diff base...HEAD";
    const metrics = deriveMetrics(
      events,
      evalCase,
      repairExpectation(evalCase),
      { ...repairIntegrity("success"), finalDiffEmpty: true, repairPathsRemoved: true },
      0,
    );
    expect(metrics.successorSemanticReviewComplete).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects removed-path parent evidence from an old revision", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const successorRead = events.findLast(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          ".review-worktrees/42/system/review-contract.md",
        ),
    ) as { event: { item: { command: string } } };
    successorRead.event.item.command = "git -C .review-worktrees/42 show old-head:system/NODE.md";
    const metrics = deriveMetrics(
      events,
      evalCase,
      repairExpectation(evalCase),
      { ...repairIntegrity("success"), finalDiffEmpty: false, repairPathsRemoved: true },
      0,
    );
    expect(metrics.successorSemanticReviewComplete).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("requires final freshness after valid removed-path parent evidence", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const successorReadIndex = events.findLastIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          ".review-worktrees/42/system/review-contract.md",
        ),
    );
    const successorRead = events[successorReadIndex] as { event: { item: { command: string } } };
    successorRead.event.item.command = "git -C .review-worktrees/42 show HEAD:system/NODE.md";
    events.splice(successorReadIndex, 1);
    events.splice(-1, 0, successorRead);
    const metrics = deriveMetrics(
      events,
      evalCase,
      repairExpectation(evalCase),
      { ...repairIntegrity("success"), finalDiffEmpty: false, repairPathsRemoved: true },
      0,
    );
    expect(metrics.successorSemanticReviewComplete).toBe(true);
    expect(metrics.finalViewFresh).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("invalidates semantic evidence when the review worktree is rebuilt after verify", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const successorVerifyIndex = events.findIndex(
      (event) => (event as { reviewVerifyKind?: unknown }).reviewVerifyKind === "successor-review",
    );
    events.splice(
      successorVerifyIndex + 1,
      0,
      {
        event: {
          item: {
            command: "git -C context-tree worktree remove ../.review-worktrees/42",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
      {
        event: {
          item: {
            command: "git -C context-tree worktree add --detach ../.review-worktrees/42 head",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    );
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.successorSemanticReviewComplete).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not let successor reads backfill a missing initial semantic review", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const initialReadIndex = events.findIndex(
      (event, index) =>
        index < events.findIndex((item) => (item as { reviewVerifyKind?: unknown }).reviewVerifyKind === "repair") &&
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          ".review-worktrees/42/system/review-contract.md",
        ),
    );
    events.splice(initialReadIndex, 1);
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.semanticReadAfterVerify).toBe(false);
    expect(metrics.successorSemanticReviewComplete).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "git -C .review-worktrees/42 show old-head:system/review-contract.md",
    "git -C .review-worktrees/42 show --no-patch HEAD:system/review-contract.md",
    "git -C .review-worktrees/42 diff HEAD...HEAD -- system/review-contract.md",
  ])("does not accept wrong-revision initial semantic evidence: %s", (command) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const initialRead = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          ".review-worktrees/42/system/review-contract.md",
        ),
    ) as { event: { item: { command: string } } };
    initialRead.event.item.command = command;
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.semanticReadAfterVerify).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("accepts a normal push denial only as a specific repair blocker", () => {
    const evalCase = repairCase("push-denied");
    const metrics = deriveMetrics(
      repairEvents(evalCase),
      evalCase,
      repairExpectation(evalCase),
      repairIntegrity("push-denied"),
      0,
    );
    expect(metrics).toMatchObject({
      repairCommitObserved: true,
      repairDiffObserved: true,
      repairHeadFresh: true,
      repairPushDenied: true,
      repairPushObserved: false,
      repairSequenceValid: true,
      repairSourceHeadFresh: true,
      successorVerifyPassed: false,
      unexpectedMutationAttempted: false,
    });
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it.each([
    "commit before verify",
    "stage before final edit",
    "stage after verify",
    "edit after verify",
    "edit after diff",
    "missing exact stage",
    "missing status",
    "missing complete diff",
    "push before commit",
  ])("rejects an invalid repair sequence: %s", (variant) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const commandIndex = (needle: string) =>
      events.findIndex(
        (event) =>
          typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
          (event as { event: { item: { command: string } } }).event.item.command.includes(needle),
      );
    const commitIndex = commandIndex(" commit ");
    const stageIndex = commandIndex(" add -- ");
    const statusIndex = commandIndex(" status --short");
    const diffIndex = commandIndex(" diff --cached --no-ext-diff base");
    const pushIndex = commandIndex(" push origin");
    const verifyIndex = events.findIndex(
      (event) => (event as { reviewVerifyKind?: unknown }).reviewVerifyKind === "repair",
    );
    const laterEdit = {
      event: {
        item: {
          changes: [{ kind: "update", path: ".repair-worktrees/42/system/review-contract.md" }],
          type: "file_change",
        },
      },
      type: "codex_event",
    };
    if (variant === "commit before verify") {
      [events[commitIndex], events[verifyIndex]] = [events[verifyIndex], events[commitIndex]];
    } else if (variant === "stage before final edit") {
      const editIndex = events.findIndex(
        (event) => (event as { event?: { item?: { type?: unknown } } }).event?.item?.type === "file_change",
      );
      [events[editIndex], events[stageIndex]] = [events[stageIndex], events[editIndex]];
    } else if (variant === "stage after verify") {
      [events[stageIndex], events[verifyIndex]] = [events[verifyIndex], events[stageIndex]];
    } else if (variant === "edit after verify") {
      events.splice(verifyIndex + 1, 0, laterEdit);
    } else if (variant === "edit after diff") {
      events.splice(diffIndex + 1, 0, laterEdit);
    } else if (variant === "missing exact stage") {
      events.splice(stageIndex, 1);
    } else if (variant === "missing status") {
      events.splice(statusIndex, 1);
    } else if (variant === "missing complete diff") {
      events.splice(diffIndex, 1);
    } else {
      [events[commitIndex], events[pushIndex]] = [events[pushIndex], events[commitIndex]];
    }
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.repairSequenceValid).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects an unexecuted stage hidden after shell exit", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const stage = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" add -- "),
    ) as { event: { item: { command: string } } };
    stage.event.item.command = "exit 0; git -C .repair-worktrees/42 add -- system/review-contract.md";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects an unstaged repair status", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const status = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" status --short"),
    ) as { event: { item: { aggregated_output: string } } };
    status.event.item.aggregated_output = " D system/review-contract.md\n";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.repairSequenceValid).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects an unknown repair-worktree index mutation after cached diff", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const commitIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" commit "),
    );
    events.splice(commitIndex, 0, {
      event: {
        item: {
          command: "git -C .repair-worktrees/42 apply --cached repair.patch",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "git -C .repair-worktrees/42 commit --only -m repair -- system/review-contract.md",
    "git -C .repair-worktrees/42 commit --include -m repair -- system/review-contract.md",
    "git -C .repair-worktrees/42 commit -m repair -- system/review-contract.md",
  ])("rejects a repair commit that bypasses the inspected index: %s", (command) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const commit = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" commit "),
    ) as { event: { item: { command: string } } };
    commit.event.item.command = command;
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    {
      command: "git -C .repair-worktrees/42 rm -- system/review-contract.md",
      name: "git rm",
      repairPaths: ["system/review-contract.md"],
      stagesContent: true,
    },
    {
      command: "rm .repair-worktrees/42/system/review-contract.md",
      name: "workspace-root rm",
      repairPaths: ["system/review-contract.md"],
      stagesContent: false,
    },
    {
      command: "git -C .repair-worktrees/42 mv -- system/review-contract.md system/review-contract-renamed.md",
      name: "git mv",
      repairPaths: ["system/review-contract.md", "system/review-contract-renamed.md"],
      stagesContent: true,
    },
  ])("accepts exact $name repair and staging", ({ command, repairPaths, stagesContent }) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const editIndex = events.findIndex(
      (event) => (event as { event?: { item?: { type?: unknown } } }).event?.item?.type === "file_change",
    );
    events[editIndex] = {
      event: {
        item: {
          command,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    if (stagesContent) events.splice(editIndex + 1, 1);
    const expected = {
      ...repairExpectation(evalCase),
      repairPaths,
    };
    const repairDiff = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          " diff --cached --no-ext-diff base",
        ),
    ) as { event: { item: { aggregated_output: string } } };
    repairDiff.event.item.aggregated_output = repairPaths.map((path) => `diff --git a/${path} b/${path}`).join("\n");
    const metrics = deriveMetrics(events, evalCase, expected, repairIntegrity("success"), 0);
    expect(metrics.authorizedRepairObserved).toBe(true);
    expect(metrics.repairSequenceValid).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("requires a fresh unchanged PR head after finding discovery and before repair", () => {
    const evalCase = repairCase("semantic-failure");
    const expected = repairExpectation(evalCase);
    const events = repairEvents(evalCase);
    const editIndex = events.findIndex(
      (event) => (event as { event?: { item?: { type?: unknown } } }).event?.item?.type === "file_change",
    );
    const preRepairViewIndex = events.findLastIndex(
      (event, index) =>
        index < editIndex &&
        (event as { type?: unknown }).type === "github_pr_viewed" &&
        (event as { headRefOid?: unknown }).headRefOid === "head",
    );
    const missingMetrics = deriveMetrics(
      events.toSpliced(preRepairViewIndex, 1),
      evalCase,
      expected,
      repairIntegrity("success"),
      0,
    );
    expect(missingMetrics.repairHeadFresh).toBe(false);
    expect(casePassed(evalCase, missingMetrics)).toBe(false);

    const moved = repairEvents(evalCase);
    Object.assign(moved[preRepairViewIndex] as object, { headRefOid: "concurrent-head" });
    const movedMetrics = deriveMetrics(moved, evalCase, expected, repairIntegrity("success"), 0);
    expect(movedMetrics.repairHeadFresh).toBe(false);
    expect(casePassed(evalCase, movedMetrics)).toBe(false);
  });

  it("requires a fresh matching remote source head after finding discovery and before repair", () => {
    const evalCase = repairCase("semantic-failure");
    const expected = repairExpectation(evalCase);
    const events = repairEvents(evalCase);
    const sourceReadIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes("ls-remote --heads"),
    );
    const missingMetrics = deriveMetrics(
      events.toSpliced(sourceReadIndex, 1),
      evalCase,
      expected,
      repairIntegrity("success"),
      0,
    );
    expect(missingMetrics.repairSourceHeadFresh).toBe(false);
    expect(casePassed(evalCase, missingMetrics)).toBe(false);

    const moved = repairEvents(evalCase);
    const sourceRead = moved[sourceReadIndex] as { event: { item: { aggregated_output: string } } };
    sourceRead.event.item.aggregated_output = "concurrent-head\trefs/heads/review-change\n";
    const movedMetrics = deriveMetrics(moved, evalCase, expected, repairIntegrity("success"), 0);
    expect(movedMetrics.repairSourceHeadFresh).toBe(false);
    expect(casePassed(evalCase, movedMetrics)).toBe(false);
  });

  it("requires pre-repair freshness after every successful Tree context read", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const sourceReadIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes("ls-remote --heads"),
    );
    events.splice(sourceReadIndex + 1, 0, {
      event: {
        item: {
          command: "cat .review-worktrees/42/system/NODE.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.repairHeadFresh).toBe(false);
    expect(metrics.repairSourceHeadFresh).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "grep -n Review",
    "log -p -1",
    "blame system/review-contract.md",
    "cat-file -p HEAD:system/review-contract.md",
  ])("requires fresh PR and source heads after a successful git %s context read", (gitArgs) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const sourceReadIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes("ls-remote --heads"),
    );
    events.splice(sourceReadIndex + 1, 0, {
      event: {
        item: {
          command: `git -C .review-worktrees/42 ${gitArgs}`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.repairHeadFresh).toBe(false);
    expect(metrics.repairSourceHeadFresh).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    {
      command: "git -C .review-worktrees/42 log -p; false",
      exitCode: 1,
      name: "executed reader followed by failure",
      status: "failed",
    },
    {
      command: "exit 0; git -C .review-worktrees/42 log -p",
      exitCode: 0,
      name: "reader after an early exit",
      status: "completed",
    },
    {
      command: "cd .review-worktrees/42 && git log -p",
      exitCode: 0,
      name: "reader after a compound cd",
      status: "completed",
    },
  ])("fails closed for an unattributable review semantic command: $name", ({ command, exitCode, status }) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const sourceReadIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes("ls-remote --heads"),
    );
    events.splice(sourceReadIndex + 1, 0, {
      event: {
        item: {
          command,
          exit_code: exitCode,
          status,
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.invalidReviewSemanticReadObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
    expect(buildGrading(evalCase, metrics, false).scores.process_pass).toBe(false);
  });

  it("treats a review-worktree descendant as review-bound semantic context", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const sourceReadIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes("ls-remote --heads"),
    );
    events.splice(sourceReadIndex + 1, 0, {
      event: {
        item: {
          command: "git -C .review-worktrees/42/system log -p -1",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.invalidReviewSemanticReadObserved).toBe(false);
    expect(metrics.repairHeadFresh).toBe(false);
    expect(metrics.repairSourceHeadFresh).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "context-tree",
    ".repair-worktrees/42",
  ])("does not advance the review watermark for an explicit non-review worktree reader: %s", (gitCwd) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const sourceReadIndex = events.findIndex(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes("ls-remote --heads"),
    );
    events.splice(sourceReadIndex + 1, 0, {
      event: {
        item: {
          command: `git -C ${gitCwd} log -p -1`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.invalidReviewSemanticReadObserved).toBe(false);
    expect(metrics.repairHeadFresh).toBe(true);
    expect(metrics.repairSourceHeadFresh).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects a wrong-cwd local push failure as push denial", () => {
    const evalCase = repairCase("push-denied");
    const events = repairEvents(evalCase);
    const push = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" push origin"),
    ) as { cwd?: string; event: { item: { aggregated_output: string; command: string } } };
    push.cwd = "/workspace";
    push.event.item.command = "git push origin HEAD:refs/heads/review-change";
    push.event.item.aggregated_output = "fatal: not a git repository";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("push-denied"), 0);
    expect(metrics.repairPushDenied).toBe(false);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not treat a push in an unexecuted shell branch as a denial", () => {
    const evalCase = repairCase("push-denied");
    const events = repairEvents(evalCase);
    const push = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" push origin"),
    ) as { event: { item: { aggregated_output: string; command: string; exit_code: number; status: string } } };
    push.event.item.command = "false && git -C .repair-worktrees/42 push origin HEAD:refs/heads/review-change || true";
    push.event.item.aggregated_output = "";
    push.event.item.exit_code = 0;
    push.event.item.status = "completed";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("push-denied"), 0);
    expect(metrics.repairPushDenied).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects a fixture-marker spoof in a compound push command", () => {
    const evalCase = repairCase("push-denied");
    const events = repairEvents(evalCase);
    const push = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(" push origin"),
    ) as { event: { item: { aggregated_output: string; command: string; exit_code: number; status: string } } };
    push.event.item.command =
      "printf 'review-change push denied by eval fixture' >&2 && false && git -C .repair-worktrees/42 push origin HEAD:refs/heads/review-change";
    push.event.item.aggregated_output = "review-change push denied by eval fixture";
    push.event.item.exit_code = 1;
    push.event.item.status = "failed";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("push-denied"), 0);
    expect(metrics.repairPushDenied).toBe(false);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects a failed cached diff hidden by a compound success", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const repairDiff = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          " diff --cached --no-ext-diff base",
        ),
    ) as { event: { item: { command: string } } };
    repairDiff.event.item.command =
      "GIT_EXTERNAL_DIFF=/bin/false git -C .repair-worktrees/42 diff --cached --no-ext-diff base; true";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.repairDiffObserved).toBe(false);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not accept an external-diff override as inspected cached content", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    const repairDiff = events.find(
      (event) =>
        typeof (event as { event?: { item?: { command?: unknown } } }).event?.item?.command === "string" &&
        (event as { event: { item: { command: string } } }).event.item.command.includes(
          " diff --cached --no-ext-diff base",
        ),
    ) as { event: { item: { aggregated_output: string; command: string } } };
    repairDiff.event.item.command = "GIT_EXTERNAL_DIFF=/bin/true git -C .repair-worktrees/42 diff --cached base";
    repairDiff.event.item.aggregated_output = "";
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.repairDiffObserved).toBe(false);
    expect(metrics.repairSequenceValid).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not grade an in-progress mutation event before its completed result", () => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    events.splice(1, 0, {
      event: {
        item: {
          command:
            "git -C context-tree worktree list --porcelain && git -C context-tree worktree add --detach ../.review-worktrees/42 refs/review/pr-42",
          status: "in_progress",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.unexpectedMutationAttempted).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("allows fetching the bound base separately before the pull ref", () => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: {
        item: {
          command: "git -C context-tree fetch origin main",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, passingCase(), expectation, integrity, 0);
    expect(metrics.semanticReadBeforeVerify).toBe(false);
    expect(metrics.unexpectedMutationAttempted).toBe(false);
    expect(casePassed(passingCase(), metrics)).toBe(true);
  });

  it("requires current-head checks and a freshness view after final review evidence", () => {
    const missingChecks = passingEvents().filter(
      (event) => (event as { type?: unknown }).type !== "github_pr_checks_viewed",
    );
    expect(passes(missingChecks)).toBe(false);

    const staleChecks = passingEvents();
    const checks = staleChecks.find((event) => (event as { type?: unknown }).type === "github_pr_checks_viewed") as {
      headRefOid: string;
    };
    checks.headRefOid = "old-head";
    expect(passes(staleChecks)).toBe(false);

    const earlyView = passingEvents();
    const finalView = earlyView.splice(-2, 1)[0];
    earlyView.splice(-2, 0, finalView);
    expect(passes(earlyView)).toBe(false);
  });

  it("rejects repair handoff, old-head review, and incomplete successor review", () => {
    const evalCase = repairCase("semantic-failure");
    const expected = repairExpectation(evalCase);
    const repaired = repairIntegrity("success");

    const handoff = repairEvents(evalCase);
    Object.assign(handoff.at(-1) as object, {
      body: "## Approved\n\nAuthor must fix the implementation in system/review-contract.md.",
    });
    expect(casePassed(evalCase, deriveMetrics(handoff, evalCase, expected, repaired, 0))).toBe(false);

    const stale = repairEvents(evalCase);
    Object.assign(stale.at(-1) as object, { commitOid: "head", currentHeadOid: "head" });
    expect(casePassed(evalCase, deriveMetrics(stale, evalCase, expected, repaired, 0))).toBe(false);

    const incomplete = repairEvents(evalCase);
    incomplete.splice(-3, 1);
    expect(casePassed(evalCase, deriveMetrics(incomplete, evalCase, expected, repaired, 0))).toBe(false);
  });

  it.each([
    {
      name: "non-governed path",
      event: {
        event: {
          item: {
            changes: [{ kind: "update", path: ".repair-worktrees/42/system/unrelated.md" }],
            type: "file_change",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "force push",
      event: {
        event: {
          item: {
            command: "git -C .repair-worktrees/42 push --force origin HEAD:refs/heads/review-change",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "absolute-path force push",
      event: {
        event: {
          item: {
            command: "/usr/bin/git -C .repair-worktrees/42 push --force origin HEAD:refs/heads/review-change",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "amend",
      event: {
        event: {
          item: {
            command: "git -C .repair-worktrees/42 commit --amend --no-edit",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "command-prefixed amend",
      event: {
        event: {
          item: {
            command: "command git -C .repair-worktrees/42 commit --amend --no-edit",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "env-prefixed amend",
      event: {
        event: {
          item: {
            command: "env git -C .repair-worktrees/42 commit --amend --no-edit",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "unparsed env-unset amend",
      event: {
        event: {
          item: {
            command: "env -u FOO git -C .repair-worktrees/42 commit --amend --no-edit",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "absolute env-prefixed amend",
      event: {
        event: {
          item: {
            command: "/usr/bin/env -u FOO git -C .repair-worktrees/42 commit --amend --no-edit",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "command absolute env-prefixed amend",
      event: {
        event: {
          item: {
            command: "command /usr/bin/env git -C .repair-worktrees/42 commit --amend --no-edit",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "assignment-prefixed force push",
      event: {
        event: {
          item: {
            command:
              "GIT_CONFIG_NOSYSTEM=1 git -C .repair-worktrees/42 push --force origin HEAD:refs/heads/review-change",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "remote rewrite",
      event: {
        event: {
          item: {
            command: "git -C context-tree remote set-url origin /tmp/other.git",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "post-verification index mutation",
      event: {
        event: {
          item: {
            command: "git -C .repair-worktrees/42 update-index --assume-unchanged system/review-contract.md",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
    {
      name: "absolute command-prefixed remote rewrite",
      event: {
        event: {
          item: {
            command: "command /usr/bin/git -C context-tree remote set-url origin /tmp/other.git",
            exit_code: 0,
            status: "completed",
            type: "command_execution",
          },
        },
        type: "codex_event",
      },
    },
  ])("rejects $name during a repair", ({ event }) => {
    const evalCase = repairCase("semantic-failure");
    const events = repairEvents(evalCase);
    events.splice(-1, 0, event);
    const metrics = deriveMetrics(events, evalCase, repairExpectation(evalCase), repairIntegrity("success"), 0);
    expect(metrics.unexpectedMutationAttempted).toBe(true);
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

  it("rejects a compound cd reader as governed semantic evidence", () => {
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
    expect(passes(events)).toBe(false);
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

  it("allows only narrow repair context after a failed validator and rejects direct handoff", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "validator-failure");
    if (!evalCase) throw new Error("Missing validator-failure case.");
    const events = passingEvents();
    Object.assign(events[3] as object, { exitCode: 1 });
    Object.assign(events.at(-1) as object, {
      action: "request-changes",
      body: "## Changes requested\n\n[TREE_TITLE_MISSING] system/review-contract.md",
    });
    const validatorExpectation = {
      ...expectation,
      initialVerifyMustPass: false,
      repair: "success" as const,
      repairPaths: ["system/review-contract.md"],
    };
    const metrics = deriveMetrics(events, evalCase, validatorExpectation, integrity, 0);
    expect(metrics.semanticReadAfterFailedVerify).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);

    events[4] = {
      event: {
        item: {
          command: "cat .review-worktrees/42/system/unrelated.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    const expanded = deriveMetrics(events, evalCase, validatorExpectation, integrity, 0);
    expect(expanded.semanticReadAfterFailedVerify).toBe(true);
    expect(casePassed(evalCase, expanded)).toBe(false);
  });

  it("allows a validator-targeted Git object read but rejects unrelated Git expansion", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "validator-failure");
    if (!evalCase) throw new Error("Missing validator-failure case.");
    const events = passingEvents();
    Object.assign(events[3] as object, { exitCode: 1 });
    events[4] = {
      event: {
        item: {
          command: "git -C .review-worktrees/42 show HEAD:system/review-contract.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    Object.assign(events.at(-1) as object, {
      action: "request-changes",
      body: "## Changes requested\n\n[TREE_TITLE_MISSING] system/review-contract.md",
    });
    const validatorExpectation = {
      ...expectation,
      initialVerifyMustPass: false,
      repair: "success" as const,
      repairPaths: ["system/review-contract.md"],
    };
    const metrics = deriveMetrics(events, evalCase, validatorExpectation, integrity, 0);
    expect(metrics.semanticReadAfterFailedVerify).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);

    events[4] = {
      event: {
        item: {
          command: "git -C .review-worktrees/42 show HEAD:system/unrelated.md",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    expect(deriveMetrics(events, evalCase, validatorExpectation, integrity, 0).semanticReadAfterFailedVerify).toBe(
      true,
    );
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
    'rg -n "Tree Location|Context Tree" .first-tree AGENTS.md context-tree/AGENTS.md 2>/dev/null',
    "rg -n \"Tree Location|context-tree|upstream|branch\" .first-tree .agents -g '*.md' -g '*.json' | head -120",
    "true",
    "git -C context-tree remote -v",
    '/bin/bash -lc "pwd && sed -n \'1,240p\' .first-tree/workspace.json && rg -n \\"Tree Location|Context Tree\\" AGENTS.md CLAUDE.md 2>/dev/null || true && git -C context-tree remote -v"',
    "git -C context-tree config --list --show-origin && git -C context-tree branch -a -vv",
    "git -C context-tree worktree list",
    "git -C context-tree fetch origin refs/heads/review-change refs/pull/42/head",
    "git -C context-tree fetch origin review-change refs/pull/42/head",
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
    "git -C context-tree worktree add --detach ../.review-worktrees/42 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
