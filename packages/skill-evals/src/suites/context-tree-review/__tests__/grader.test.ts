import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_REVIEW_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import type { ContextTreeReviewEvalCase, ReviewFixtureExpectation, ReviewFixtureIntegrity } from "../types.js";

const expectation: ReviewFixtureExpectation = {
  agentId: "reviewer-eval-agent",
  baseOid: "base",
  chatId: "review-eval-chat",
  expectedFinalDraft: false,
  expectedFinalHeadOid: "head",
  expectedFinalState: "OPEN",
  governedPaths: ["system/review-contract.md"],
  headRefName: "review-change",
  headOid: "head",
  prNumber: 42,
  repo: "owner/context-tree",
  reviewerLogin: "read-only-reviewer",
  runId: "019review-run",
  submissionHeadOid: "head",
  workspacePath: "/workspace",
};

const integrity: ReviewFixtureIntegrity = {
  mainHeadUnchanged: true,
  mainWorktreeClean: true,
  originRefsUnchanged: true,
  reviewBodyCleaned: true,
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
      event: {
        item: {
          command:
            'test -n "$FIRST_TREE_CHAT_ID"; test "$FIRST_TREE_AGENT_ID" = "reviewer-eval-agent"; test -r "$FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE"',
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    },
    { login: "read-only-reviewer", type: "github_identity_read" },
    {
      headRefOid: "head",
      isDraft: false,
      prNumber: 42,
      repo: "owner/context-tree",
      state: "OPEN",
      type: "github_pr_viewed",
    },
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
      bodyFile: ".review-body-42.md",
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

type FenceRefKind = "pull" | "source";

function commandLifecycle(id: string, command: string): unknown[] {
  return [
    {
      event: { item: { command, exit_code: null, id, status: "in_progress", type: "command_execution" } },
      type: "codex_event",
    },
    {
      event: { item: { command, exit_code: 0, id, status: "completed", type: "command_execution" } },
      type: "codex_event",
    },
  ];
}

function fenceLifecycle(prefix: string, overlap: FenceRefKind | null = null): unknown[] {
  const sourceFetch = "git -C context-tree fetch origin refs/heads/review-change";
  const pullFetch = "git -C context-tree fetch origin refs/pull/42/head";
  const check = 'test "$(git -C context-tree rev-parse FETCH_HEAD)" = head';
  const pair = (kind: FenceRefKind, fetch: string): unknown[] => {
    const fetchEvents = commandLifecycle(`${prefix}-${kind}-fetch`, fetch);
    const checkEvents = commandLifecycle(`${prefix}-${kind}-check`, check);
    return overlap === kind
      ? [fetchEvents[0], checkEvents[0], checkEvents[1], fetchEvents[1]]
      : [...fetchEvents, ...checkEvents];
  };
  return [...pair("source", sourceFetch), ...pair("pull", pullFetch)];
}

function withFetchHeadFences(
  events: unknown[],
  preVerdictFence: readonly unknown[] = fenceLifecycle("final").slice(0, 4),
): unknown[] {
  const verifyIndex = events.findIndex(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "first_tree_result" &&
      "argv" in event &&
      Array.isArray(event.argv) &&
      event.argv[1] === "verify",
  );
  if (verifyIndex < 0) throw new Error("Missing verify event.");
  events.splice(verifyIndex, 0, ...fenceLifecycle("initial"));
  const reviewIndex = events.findIndex(
    (event) =>
      typeof event === "object" && event !== null && "type" in event && event.type === "context_review_submitted",
  );
  if (reviewIndex < 0) throw new Error("Missing review event.");
  events.splice(reviewIndex, 0, ...preVerdictFence);
  return events;
}

function passes(events: unknown[], fixtureIntegrity = integrity): boolean {
  const evalCase = passingCase();
  return casePassed(evalCase, deriveMetrics(events, evalCase, expectation, fixtureIntegrity, 0));
}

describe("context-tree-review grader", () => {
  it("accepts the complete head-bound review sequence", () => {
    expect(passes(passingEvents())).toBe(true);
  });

  it("classifies one recorded-only exact-head squash merge as a permitted local action", () => {
    const events = passingEvents();
    events.push({
      event: {
        item: {
          command: 'gh pr merge "https://github.com/owner/context-tree/pull/42" --squash --match-head-commit "head"',
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    events.push({ commitOid: "head", prNumber: 42, repo: "owner/context-tree", type: "github_pr_merged" });

    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.localMergeAttempts).toBe(1);
    expect(metrics.localMergeValid).toBe(true);
    expect(metrics.mutationAttempted).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects duplicate, wrong-head, or non-passing-case local merge events", () => {
    const exactMerge = { commitOid: "head", prNumber: 42, repo: "owner/context-tree", type: "github_pr_merged" };
    const duplicate = [...passingEvents(), exactMerge, exactMerge];
    expect(passes(duplicate)).toBe(false);

    const wrongHead = [...passingEvents(), { ...exactMerge, commitOid: "other-head" }];
    expect(passes(wrongHead)).toBe(false);

    const draftCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "draft");
    if (!draftCase) throw new Error("Missing draft case.");
    const metrics = deriveMetrics([...passingEvents(), exactMerge], draftCase, expectation, integrity, 0);
    expect(metrics.localMergeValid).toBe(false);
    expect(casePassed(draftCase, metrics)).toBe(false);
  });

  it("requires completion-ordered source and PR snapshot fences plus a source pre-verdict fence", () => {
    const events = withFetchHeadFences(passingEvents());
    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.fetchHeadChecksCompletionOrdered).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("rejects a pre-verdict source FETCH_HEAD test that starts before its fetch completes", () => {
    const events = withFetchHeadFences(passingEvents(), fenceLifecycle("final", "source").slice(0, 4));
    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.fetchHeadChecksCompletionOrdered).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("does not invent a second PR-ref fetch requirement at the pre-verdict boundary", () => {
    const events = withFetchHeadFences(passingEvents());
    const evalCase = passingCase();
    expect(deriveMetrics(events, evalCase, expectation, integrity, 0).fetchHeadChecksCompletionOrdered).toBe(true);
  });

  it("requires the real Chat, Agent, and runtime-token checks before the first PR read", () => {
    const missing = passingEvents();
    missing.splice(1, 1);
    expect(passes(missing)).toBe(false);

    const late = passingEvents();
    const [identity] = late.splice(1, 1);
    late.splice(3, 0, identity);
    expect(passes(late)).toBe(false);
  });

  it("requires the bounded workspace review-body path", () => {
    const events = passingEvents();
    Object.assign(events.at(-1) as object, { bodyFile: ".arbitrary-review.md" });
    expect(passes(events)).toBe(false);
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

    events.splice(6, 0, {
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
    events[5] = {
      event: { item: { command: "ls .review-worktrees/42", type: "command_execution" } },
      type: "codex_event",
    };
    expect(passes(events)).toBe(false);
  });

  it("accepts the read-only human worktree listing used to verify cleanup", () => {
    const events = passingEvents();
    events.splice(-1, 0, {
      event: {
        item: {
          command: "git -C context-tree worktree list",
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.semanticReadAfterVerify).toBe(true);
    expect(metrics.mutationAttempted).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("does not accept a bare workspace-relative governed path as detached review evidence", () => {
    const events = passingEvents();
    events[5] = {
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
    events[5] = {
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
    events[5] = {
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

  it("accepts a quote-spliced explicit review-worktree read from Codex shell serialization", () => {
    const events = passingEvents();
    events[5] = {
      event: {
        item: {
          command: String.raw`/bin/zsh -lc "sed -n '1,260p' \""'$PWD/.review-worktrees/42/system/review-contract.md"'`,
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.semanticReadAfterVerify).toBe(true);
    expect(metrics.mutationAttempted).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("accepts an explicit review-worktree content diff as governed read evidence", () => {
    const events = passingEvents();
    events[5] = {
      event: {
        item: {
          command: 'git -C "$PWD/.review-worktrees/42" diff base...head -- system/review-contract.md',
          exit_code: 0,
          status: "completed",
          type: "command_execution",
        },
      },
      type: "codex_event",
    };
    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.semanticReadAfterVerify).toBe(true);
    expect(metrics.mutationAttempted).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("does not accept a governed read from a shell branch that never executes", () => {
    const events = passingEvents();
    events[5] = {
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
    events[5] = {
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
    Object.assign(events[4] as object, { exitCode: 1 });
    Object.assign(events.at(-1) as object, {
      action: "request-changes",
      body: "## Changes requested\n\n[TREE_OWNERS_INVALID] system/review-contract.md",
    });
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.semanticReadAfterFailedVerify).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);

    events.splice(5, 1);
    const shortCircuited = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(shortCircuited.semanticReadAfterFailedVerify).toBe(false);
    expect(casePassed(evalCase, shortCircuited)).toBe(true);
  });

  it("rejects a detached Git object read after a failed validator", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "validator-failure");
    if (!evalCase) throw new Error("Missing validator-failure case.");
    const events = passingEvents();
    Object.assign(events[4] as object, { exitCode: 1 });
    events[5] = {
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
      body: "## Changes requested\n\n[TREE_OWNERS_INVALID] system/review-contract.md",
    });
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
            command:
              'git diff --name-only base...head && git -C context-tree worktree add --detach "$PWD/.review-worktrees/42" head',
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
    "git -C context-tree fetch origin main",
    "git -C context-tree fetch origin refs/heads/review-change",
    "git -C context-tree fetch origin refs/pull/42/head",
    "CONTEXT_REVIEW_RUN_ID='01900000-0000-7000-8000-000000000042'; RUN_HEAD=head",
    "CONTEXT_REVIEW_RUN_ID=019review-run; RUN_HEAD=head; readonly CONTEXT_REVIEW_RUN_ID RUN_HEAD",
    'readonly RUN_HEAD=head; readonly REVIEW_WORKTREE="$PWD/.review-worktrees/42"; mkdir -p "$PWD/.review-worktrees"; git -C context-tree worktree add --detach "$PWD/.review-worktrees/42" "$RUN_HEAD"',
    "case \"$RUN_HEAD\" in (*[!0-9a-f]*|'') exit 64;; esac",
    "gh api user --jq .login",
  ])("allows an observed repository-identity preflight: %s", (command) => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: { item: { command, type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(true);
  });

  it("rejects a fetch and FETCH_HEAD checks batched into one shell command", () => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: {
        item: {
          command:
            'git -C context-tree fetch origin refs/heads/review-change\ntest "$(git -C context-tree rev-parse FETCH_HEAD)" = head\ngit -C context-tree fetch origin refs/pull/42/head\ntest "$(git -C context-tree rev-parse FETCH_HEAD)" = head',
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects a quote-spliced shell command that batches the ref fences", () => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: {
        item: {
          command: String.raw`/bin/zsh -lc "readonly RUN_HEAD='head'
readonly REVIEW_WORKTREE=\""'$PWD/.review-worktrees/42"
git -C context-tree fetch origin refs/heads/review-change
test "$(git -C context-tree rev-parse FETCH_HEAD)" = "$RUN_HEAD"
git -C context-tree fetch origin refs/pull/42/head
test "$(git -C context-tree rev-parse FETCH_HEAD)" = "$RUN_HEAD"
mkdir -p "$PWD/.review-worktrees"
test ! -e "$REVIEW_WORKTREE"
git -C context-tree worktree add --detach "$PWD/.review-worktrees/42" "$RUN_HEAD"
test "$(git -C "$REVIEW_WORKTREE" rev-parse HEAD)" = "$RUN_HEAD"'`,
          type: "command_execution",
        },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects a FETCH_HEAD test without a completion-ordered fetch in a live command trace", () => {
    const events = withFetchHeadFences(passingEvents());
    const reviewIndex = events.findIndex(
      (event) =>
        typeof event === "object" && event !== null && "type" in event && event.type === "context_review_submitted",
    );
    events.splice(
      reviewIndex,
      0,
      ...commandLifecycle("orphan-check", 'test "$(git -C context-tree rev-parse FETCH_HEAD)" = head'),
    );
    expect(passes(events)).toBe(false);
  });

  it.each([
    "env",
    "env | rg FIRST_TREE_AGENT_ID",
    "env | sort",
    "printenv FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE",
    "printenv | rg FIRST_TREE_CHAT_ID",
    "set",
    "set | rg FIRST_TREE_AGENT_ID",
  ])("rejects runtime environment enumeration before verification: %s", (command) => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: { item: { command, exit_code: 0, status: "completed", type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it.each([
    "git -C context-tree ls-remote origin refs/heads/review-change",
    "git -C context-tree fetch origin refs/heads/other",
    "test \"$(git -C context-tree ls-remote origin refs/heads/review-change | awk '{print $1}')\" = head",
    'test "$(git -C context-tree ls-remote origin refs/heads/review-change | cat)" = head',
  ])("rejects an untrusted ref lookup or parser before verification: %s", (command) => {
    const events = passingEvents();
    events.splice(3, 0, {
      event: { item: { command, type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("requires all no-output runtime checks and a distinct matching GitHub identity read before PR access", () => {
    const missingRuntime = passingEvents();
    missingRuntime.splice(1, 1);
    expect(passes(missingRuntime)).toBe(false);

    const incompleteRuntime = passingEvents();
    Object.assign((incompleteRuntime[1] as { event: { item: object } }).event.item, {
      command: 'test -n "$FIRST_TREE_CHAT_ID"; test "$FIRST_TREE_AGENT_ID" = "reviewer-eval-agent"',
    });
    expect(passes(incompleteRuntime)).toBe(false);

    const wrongGithubIdentity = passingEvents();
    Object.assign(wrongGithubIdentity[2] as object, { login: "other-user" });
    expect(passes(wrongGithubIdentity)).toBe(false);
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

  it("accepts a submission race only when the review remains bound to the inspected head", () => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "submission-race");
    if (!evalCase) throw new Error("Missing submission-race case.");
    const events = passingEvents();
    Object.assign(events.at(-1) as object, { currentHeadOid: "new-head" });
    const metrics = deriveMetrics(events, evalCase, { ...expectation, submissionHeadOid: "new-head" }, integrity, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);

    Object.assign(events.at(-1) as object, { commitOid: "new-head" });
    const wrongCommitMetrics = deriveMetrics(
      events,
      evalCase,
      { ...expectation, submissionHeadOid: "new-head" },
      integrity,
      0,
    );
    expect(casePassed(evalCase, wrongCommitMetrics)).toBe(false);
  });

  it("allows only the exact workspace-root temporary review body", () => {
    const events = passingEvents();
    events.push({
      event: {
        item: {
          changes: [
            { kind: "add", path: ".review-body-42.md" },
            { kind: "delete", path: ".review-body-42.md" },
          ],
          type: "file_change",
        },
      },
      type: "codex_event",
    });
    events.push({
      event: {
        item: { command: "rm -f .review-body-42.md", type: "command_execution" },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(true);
  });

  it("rejects arbitrary file writes even when the file is later removed", () => {
    const events = passingEvents();
    events.push({
      event: {
        item: {
          changes: [
            { kind: "add", path: ".review-worktrees/pr-42-review.md" },
            { kind: "delete", path: ".review-worktrees/pr-42-review.md" },
          ],
          type: "file_change",
        },
      },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects a verdict submitted from any other body file", () => {
    const events = passingEvents();
    Object.assign(events.at(-1) as object, { bodyFile: "/tmp/review.md" });
    expect(passes(events)).toBe(false);
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
    Object.assign(events[4] as object, { verifyBindingValid: false });
    events.splice(5, 0, {
      event: { item: { command: "git -C context-tree commit -m bad", type: "command_execution" } },
      type: "codex_event",
    });
    expect(passes(events)).toBe(false);
  });

  it("keeps a wrong-cwd verify terminal even when a later exact verify succeeds", () => {
    const events = passingEvents();
    events.splice(4, 0, {
      argv: ["tree", "verify", "--json"],
      cwd: "/workspace/context-tree/.review-worktrees/42",
      exitCode: 1,
      phase: "model",
      type: "first_tree_result",
      verifyBindingValid: false,
    });
    const evalCase = passingCase();
    const metrics = deriveMetrics(events, evalCase, expectation, integrity, 0);
    expect(metrics.verifyHeadBound).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects duplicate validation even when both attempts are exact and successful", () => {
    const events = passingEvents();
    events.splice(5, 0, {
      argv: ["tree", "verify", "--json"],
      cwd: "/workspace/.review-worktrees/42",
      exitCode: 0,
      phase: "model",
      type: "first_tree_result",
      verifyBindingValid: true,
    });
    expect(passes(events)).toBe(false);
  });

  it("rejects semantic reads before the validator and an unbound review commit", () => {
    const events = passingEvents();
    const semanticRead = events.splice(5, 1)[0];
    events.splice(4, 0, semanticRead);
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
    "git -C context-tree worktree add --detach .review-worktrees/42 head",
    "git -C context-tree worktree add --detach ../.review-worktrees/42 head",
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
    events.splice(6, 0, {
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
    events.splice(6, 0, {
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
    expect(passes(passingEvents(), { ...integrity, reviewBodyCleaned: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, reviewWorktreeCleaned: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeConfigUnchanged: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeRefsUnchanged: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeWorktreesUnchanged: false })).toBe(false);
  });
});
