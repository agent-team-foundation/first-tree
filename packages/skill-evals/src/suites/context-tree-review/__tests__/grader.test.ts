import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_REVIEW_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import type { ContextTreeReviewEvalCase, ReviewFixtureExpectation, ReviewFixtureIntegrity } from "../types.js";

const expectation: ReviewFixtureExpectation = {
  baseOid: "base",
  chatId: "review-chat",
  expectedFinalDraft: false,
  expectedFinalHeadOid: "head",
  expectedFinalState: "OPEN",
  governedPaths: ["system/review-contract.md"],
  headOid: "head",
  prNumber: 42,
  repo: "owner/context-tree",
  reviewerAgentUuid: "reviewer-agent",
  runId: "019review-run",
  runtimeSessionToken: "runtime-session-token",
  runtimeSessionTokenFile: "/workspace/.first-tree-eval/runtime-session.token",
  workspacePath: "/workspace",
};

const integrity: ReviewFixtureIntegrity = {
  mainHeadUnchanged: true,
  mainWorktreeClean: true,
  originRefsUnchanged: true,
  reviewWorktreeCleaned: true,
  treeConfigUnchanged: true,
  treeRefsUnchanged: true,
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
      headRefOid: "head",
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
    {
      action: "approve",
      body: "## Approved\n\nNo blocking findings.",
      bodyFileUsed: true,
      commitOid: "head",
      currentHeadOid: "head",
      prNumber: 42,
      repo: "owner/context-tree",
      reviewedHead: "head",
      runId: expectation.runId,
      type: "context_review_submitted",
    },
    {
      argv: ["tree", "review", "--run", expectation.runId, "--event", "APPROVE", "--body-file", "/tmp/review.md"],
      exitCode: 0,
      phase: "model",
      stdoutPreview: `${JSON.stringify({ data: { action: "APPROVE", reviewedHead: "head" }, ok: true })}\n`,
      type: "first_tree_result",
    },
    {
      argv: [
        "api",
        "--method",
        "PUT",
        "repos/owner/context-tree/pulls/42/merge",
        "--raw-field",
        "sha=head",
        "--raw-field",
        "merge_method=squash",
      ],
      currentHeadOid: "head",
      exitCode: 0,
      mergeAttempt: true,
      mergeOutcome: "success",
      requestedHead: "head",
      reviewFixture: true,
      type: "gh_result",
    },
    { commitOid: "head", prNumber: 42, repo: "owner/context-tree", type: "github_pr_merged" },
    {
      event: {
        item: {
          text: "The App approved the reviewed head and the pull request was merged successfully.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    },
  ];
}

function passes(events: unknown[], fixtureIntegrity = integrity): boolean {
  const evalCase = passingCase();
  return casePassed(evalCase, deriveMetrics(events, evalCase, expectation, fixtureIntegrity, 0));
}

describe("context-tree-review grader", () => {
  it("accepts the complete head-bound review sequence", () => {
    expect(passes(passingEvents())).toBe(true);
  });

  it.each([
    ["merge-head-race", "head-mismatch", "new-current-head"],
    ["merge-api-unsupported", "api-unsupported", "head"],
    ["merge-queue-required", "queue-required", "head"],
  ] as const)("accepts one fail-closed %s merge result", (scenario, outcome, currentHeadOid) => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === scenario);
    if (!evalCase) throw new Error(`Missing ${scenario} case.`);
    const events = passingEvents();
    Object.assign(events[8] as object, { currentHeadOid, exitCode: 1, mergeOutcome: outcome });
    events[9] = {
      exitCode: 0,
      headRefOid: currentHeadOid,
      merged: false,
      state: "open",
      type: "github_pr_reconciled",
    };
    events[10] = {
      event: {
        item: {
          text: "The App approval succeeded, but the merge failed and the pull request remains open.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    };
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.mergeOutcomeObserved).toBe(outcome);
    expect(metrics.pullRequestMerged).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it.each([
    ["merge-delivery-open", "transport-open", "delivery-open", false, "open"],
    ["merge-delivery-merged", "transport-merged", "delivery-merged", true, "closed"],
    ["merge-delivery-unknown", "transport-unknown", "delivery-unknown", null, null],
  ] as const)("grades the %s reconciliation disposition", (scenario, attempt, outcome, merged, state) => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === scenario);
    if (!evalCase) throw new Error(`Missing ${scenario} case.`);
    const events = passingEvents();
    Object.assign(events[8] as object, { exitCode: 1, mergeOutcome: attempt });
    const reconciliation =
      merged === null
        ? { exitCode: 1, mergeReconciliation: true, type: "gh_result" }
        : { exitCode: 0, headRefOid: "head", merged, state, type: "github_pr_reconciled" };
    if (merged === true) events.splice(10, 0, reconciliation);
    else events[9] = reconciliation;
    events[merged === true ? 11 : 10] = {
      event: {
        item: {
          text:
            merged === true
              ? "The App approval succeeded; a read-only state check confirmed the pull request was merged."
              : merged === false
                ? "The App approval succeeded; a read-only state check confirmed the pull request remains open and was not merged."
                : "The App approval succeeded, but the merge result is unknown because the read-only state check also failed. Please inspect the pull request state in GitHub.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    };
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.mergeOutcomeObserved).toBe(outcome);
    expect(metrics.mergeReconciliations).toHaveLength(1);
    expect(metrics.mergeReportCorrect).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects a merged reconciliation at a head other than the App response head", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "merge-delivery-merged");
    if (!evalCase) throw new Error("Missing merge-delivery-merged case.");
    const events = passingEvents();
    Object.assign(events[8] as object, { exitCode: 1, mergeOutcome: "transport-merged" });
    events.splice(10, 0, {
      exitCode: 0,
      headRefOid: "different-merged-head",
      merged: true,
      state: "closed",
      type: "github_pr_reconciled",
    });
    events[11] = {
      event: {
        item: {
          text: "The App approval succeeded; the pull request was merged.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    };
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.mergeReportCorrect).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("requires an unknown report to include a concrete human verification action", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "merge-delivery-unknown");
    if (!evalCase) throw new Error("Missing merge-delivery-unknown case.");
    const events = passingEvents();
    Object.assign(events[8] as object, { exitCode: 1, mergeOutcome: "transport-unknown" });
    events[9] = { exitCode: 1, mergeReconciliation: true, type: "gh_result" };
    events[10] = {
      event: {
        item: {
          text: "The App approval succeeded, but the merge outcome is unknown.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    };
    const withoutAction = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(withoutAction.mergeReportCorrect).toBe(false);
    expect(casePassed(evalCase, withoutAction)).toBe(false);

    (events[10] as { event: { item: { text: string } } }).event.item.text +=
      " Please inspect the pull request state in GitHub.";
    const withAction = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(withAction.mergeReportCorrect).toBe(true);
    expect(casePassed(evalCase, withAction)).toBe(true);
  });

  it("does not treat an uncertainty clause as an affirmative merge report", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "passing");
    if (!evalCase) throw new Error("Missing passing case.");
    const events = passingEvents();
    events[10] = {
      event: {
        item: {
          text: "The App approval succeeded, but I was unable to determine whether the PR was merged.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    };
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.mergeReportCorrect).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("accepts natural uncertainty language with a concrete GitHub verification action", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "merge-delivery-unknown");
    if (!evalCase) throw new Error("Missing merge-delivery-unknown case.");
    const events = passingEvents();
    Object.assign(events[8] as object, { exitCode: 1, mergeOutcome: "transport-unknown" });
    events[9] = { exitCode: 1, mergeReconciliation: true, type: "gh_result" };
    events[10] = {
      event: {
        item: {
          text: "The App approval succeeded, but I was unable to determine whether the PR was merged. Please inspect the pull request state in GitHub.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    };
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.mergeReportCorrect).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects a success claim after an open merge failure", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "merge-head-race");
    if (!evalCase) throw new Error("Missing merge-head-race case.");
    const events = passingEvents();
    Object.assign(events[8] as object, {
      currentHeadOid: "new-current-head",
      exitCode: 1,
      mergeOutcome: "head-mismatch",
    });
    events[9] = {
      exitCode: 0,
      headRefOid: "new-current-head",
      merged: false,
      state: "open",
      type: "github_pr_reconciled",
    };
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.mergeReportCorrect).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects a missing failure report and accepts an explicit open disposition", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "merge-head-race");
    if (!evalCase) throw new Error("Missing merge-head-race case.");
    const events = passingEvents();
    Object.assign(events[8] as object, {
      currentHeadOid: "new-current-head",
      exitCode: 1,
      mergeOutcome: "head-mismatch",
    });
    events[9] = {
      exitCode: 0,
      headRefOid: "new-current-head",
      merged: false,
      state: "open",
      type: "github_pr_reconciled",
    };
    events.pop();
    const missing = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(missing.finalResponse).toBe("");
    expect(missing.mergeReportCorrect).toBe(false);
    expect(casePassed(evalCase, missing)).toBe(false);

    events.push({
      event: {
        item: {
          text: "The App approval succeeded. The PR is open and the merge was rejected.",
          type: "agent_message",
        },
      },
      type: "codex_event",
    });
    const explicit = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(explicit.mergeReportCorrect).toBe(true);
    expect(casePassed(evalCase, explicit)).toBe(true);
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

  it("rejects semantic tree reads after a failed validator", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "validator-failure");
    if (!evalCase) throw new Error("Missing validator-failure case.");
    const events = passingEvents();
    Object.assign(events[3] as object, { exitCode: 1 });
    Object.assign(events[6] as object, {
      action: "request-changes",
      body: "## Changes requested\n\n[TREE_OWNERS_INVALID] system/review-contract.md",
    });
    Object.assign(events[7] as object, {
      stdoutPreview: `${JSON.stringify({ data: { action: "REQUEST_CHANGES", reviewedHead: "head" }, ok: true })}\n`,
    });
    events.splice(8);
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.semanticReadAfterFailedVerify).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);

    events.splice(4, 1);
    const shortCircuited = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(shortCircuited.semanticReadAfterFailedVerify).toBe(false);
    expect(casePassed(evalCase, shortCircuited)).toBe(true);
  });

  it("rejects a detached Git object read after a failed validator", () => {
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
    Object.assign(events[6] as object, {
      action: "request-changes",
      body: "## Changes requested\n\n[TREE_OWNERS_INVALID] system/review-contract.md",
    });
    events.splice(7);
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.semanticReadAfterFailedVerify).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
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
    "git -C context-tree remote get-url origin && sed -n '1,120p' ../context-tree-origin.git/config && sed -n '1,80p' ../context-tree-origin.git/description",
    'test ! -e .review-worktrees/42 && git -C context-tree worktree list --porcelain && test "$(git -C context-tree rev-parse FETCH_HEAD)" = head',
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
    ["missing final view", (events: unknown[]) => events.splice(5, 1)],
    [
      "wrong repository and pull request",
      (events: unknown[]) => Object.assign(events[5] as object, { prNumber: 43, repo: "other/tree" }),
    ],
    ["wrong final head", (events: unknown[]) => Object.assign(events[5] as object, { headRefOid: "stale" })],
    [
      "forbidden GitHub attempt",
      (events: unknown[]) =>
        events.splice(5, 0, { argv: ["pr", "merge", "42"], blockedByEval: true, type: "gh_result" }),
    ],
    [
      "wrong required heading",
      (events: unknown[]) => Object.assign(events[6] as object, { body: "## Looks good\n\nNo blocking findings." }),
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
    Object.assign(events[6] as object, { commitOid: "other-head", reviewedHead: "other-head" });
    expect(passes(events)).toBe(false);
  });

  it("requires the merge head to come from the successful review response", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find(
      (item) => item.fixture.scenario === "merge-response-provenance",
    );
    if (!evalCase) throw new Error("Missing merge-response-provenance case.");
    const reviewedHead = "e".repeat(40);
    const provenanceEvents = passingEvents();
    Object.assign(provenanceEvents[6] as object, { commitOid: reviewedHead, reviewedHead });
    Object.assign(provenanceEvents[7] as object, {
      stdoutPreview: `${JSON.stringify({ data: { action: "APPROVE", reviewedHead }, ok: true })}\n`,
    });
    Object.assign(provenanceEvents[8] as object, {
      currentHeadOid: reviewedHead,
      requestedHead: reviewedHead,
    });
    const merge = provenanceEvents[8] as { argv: string[] };
    merge.argv = [
      "api",
      "--method",
      "PUT",
      "repos/owner/context-tree/pulls/42/merge",
      "--raw-field",
      `sha=${reviewedHead}`,
      "--raw-field",
      "merge_method=squash",
    ];
    Object.assign(provenanceEvents[9] as object, { commitOid: reviewedHead });
    const sourcedMetrics = deriveMetrics(provenanceEvents, evalCase, expectation, integrity, 0);
    expect(sourcedMetrics.mergeHeadFromReviewResponse).toBe(true);
    expect(casePassed(evalCase, sourcedMetrics)).toBe(true);

    const missingResponse = provenanceEvents.filter((_, index) => index !== 7);
    const missingResponseMetrics = deriveMetrics(missingResponse, evalCase, expectation, integrity, 0);
    expect(missingResponseMetrics.mergeHeadFromReviewResponse).toBe(false);
    expect(casePassed(evalCase, missingResponseMetrics)).toBe(false);

    Object.assign(provenanceEvents[7] as object, {
      stdoutPreview: `${JSON.stringify({ data: { action: "APPROVE", reviewedHead: expectation.headOid }, ok: true })}\n`,
    });
    const localHeadResponseMetrics = deriveMetrics(provenanceEvents, evalCase, expectation, integrity, 0);
    expect(localHeadResponseMetrics.mergeHeadFromReviewResponse).toBe(false);
    expect(casePassed(evalCase, localHeadResponseMetrics)).toBe(false);

    Object.assign(provenanceEvents[7] as object, {
      stdoutPreview: `${JSON.stringify({ data: { action: "APPROVE", reviewedHead }, ok: true })}\n`,
    });
    Object.assign(provenanceEvents[8] as object, { requestedHead: expectation.headOid });
    merge.argv[5] = `sha=${expectation.headOid}`;
    const substitutedMetrics = deriveMetrics(provenanceEvents, evalCase, expectation, integrity, 0);
    expect(substitutedMetrics.mergeHeadFromReviewResponse).toBe(false);
    expect(casePassed(evalCase, substitutedMetrics)).toBe(false);

    const currentHead = passingEvents();
    Object.assign(currentHead[8] as object, {
      currentHeadOid: "new-current-head",
      mergeOutcome: "head-mismatch",
      requestedHead: "new-current-head",
    });
    expect(passes(currentHead)).toBe(false);
  });

  it.each([
    'cat "$FIRST_TREE_EVAL_EVENTS"',
    "cat .first-tree-eval/events.jsonl",
    "cat .first-tree-eval/gh-review-fixture.json",
    "cat .first-tree-eval/runtime-session.token",
    "cat .first-tree-eval/bin/first-tree",
    'cat "$TMPDIR/context-review-state.json"',
    'cat "$(command -v gh)"',
  ])("rejects a model read of a private eval artifact: %s", (command) => {
    const evalCase = passingCase();
    const events = passingEvents();
    events.splice(8, 0, {
      event: { item: { command, exit_code: 0, status: "completed", type: "command_execution" } },
      type: "codex_event",
    });
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.privateArtifactReadAttempted).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects a missing, forbidden, fallback, or repeated merge attempt", () => {
    const missing = passingEvents();
    missing.splice(8);
    expect(passes(missing)).toBe(false);

    const forbidden = passingEvents();
    const merge = forbidden[8] as { argv: string[] };
    merge.argv = [...merge.argv, "--admin"];
    expect(passes(forbidden)).toBe(false);

    const retried = passingEvents();
    retried.splice(9, 0, { ...(retried[8] as object) });
    expect(passes(retried)).toBe(false);

    const fallback = passingEvents();
    fallback.splice(9, 0, {
      argv: ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash"],
      reviewFixtureViolation: true,
      type: "gh_result",
    });
    expect(passes(fallback)).toBe(false);
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
    expect(passes(passingEvents(), { ...integrity, treeRefsUnchanged: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeWorktreesUnchanged: false })).toBe(false);
  });
});
