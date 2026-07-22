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
  forbiddenPaths: [],
  governedPaths: ["system/review-contract.md"],
  headOid: "head",
  prNumber: 42,
  repo: "owner/context-tree",
  reviewerAgentUuid: "reviewer-agent",
  runId: "019review-run",
  runtimeSessionToken: "runtime-session-token",
  runtimeSessionTokenFile: "/workspace/.first-tree-eval/runtime-session.token",
  requiredReferenceSearches: [],
  submissionHeadOid: "head",
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

describe("context-tree-review grader", () => {
  it("accepts the complete head-bound review sequence", () => {
    expect(passes(passingEvents())).toBe(true);
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
          command: "rg -n 'system/review-contract\\\\.md' .review-worktrees/42",
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
    Object.assign(events.at(-1) as object, {
      action: "request-changes",
      body: "## Changes requested\n\n[TREE_OWNERS_INVALID] system/review-contract.md",
    });
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
    expect(passes(passingEvents(), { ...integrity, treeRefsUnchanged: false })).toBe(false);
    expect(passes(passingEvents(), { ...integrity, treeWorktreesUnchanged: false })).toBe(false);
  });
});
