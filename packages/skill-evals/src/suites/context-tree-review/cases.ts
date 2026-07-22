import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { ContextTreeReviewEvalCase } from "./types.js";

const FLOOR_CASE_ID = "context-tree-review-static-coverage";
const prompt =
  "A trusted server-authored GitHub Context Reviewer wake-up is active in this eval runtime for pull request owner/context-tree#42 and run 01900000-0000-7000-8000-000000000042. Use context-tree-review to perform the review. This eval workspace contains the full default First Tree skill family, the bound Context Tree, and a deterministic local bare origin whose source branch is `review-change` and whose PR ref is `refs/pull/42/head`. Resolve the binding only from generated workspace metadata plus Git remote/branch metadata; do not search or read content under the main `context-tree/` checkout before validating the detached snapshot. Keep the worktrees at workspace-relative `.review-worktrees/42` and `.repair-worktrees/42`, never under `context-tree/`; commands run with `git -C context-tree` must therefore use `../.review-worktrees/42` and `../.repair-worktrees/42`. If a local review ref is needed, use only `refs/review/pr-42` and delete it with normal `git update-ref -d` cleanup after removing the review worktree. The local `review-change` branch already exists at the live source head: attach that existing branch directly and do not use `worktree add -b`. Immediately before editing, re-read the live PR and run standalone `git -C context-tree ls-remote --heads origin review-change`; require both observed heads to remain the reviewed head. When repair is required, stage only the exact repair paths, run repair validation, inspect `git -C .repair-worktrees/42 status --short`, and inspect the complete staged base-to-result diff with `git -C .repair-worktrees/42 diff --cached <baseOid>` before making one normal repair commit, then push only `HEAD:refs/heads/review-change`. Run validation with the applicable worktree as the current directory. Every semantic reader command must spell `.review-worktrees/42/...` or use `git -C .review-worktrees/42`; setting only the tool workdir is not observable evidence. For observable ordering, run each verify, pre-repair PR view, source-ref read, repair status, repair diff, commit, push, successor diff, checks read, final PR view, review submission, merge, and cleanup mutation as its own shell command; do not join those commands with `&&`, `;`, `||`, a subshell, or an exit-code capture, and invoke validation only as `first-tree tree verify --json`. Read checks for the final reviewed head before the last freshness view. Remove both known worktrees normally, and submit the single correct outcome only through `first-tree tree review`.";

/**
 * Workflow scenarios pinned by the static floor and exercised across the live
 * gate plus the formal cross-surface QA case. Repair commit/push effects stay
 * inside the task-local bare Git fixture; external GitHub mutations remain
 * blocked.
 */
export const CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS = [
  "validator-failure",
  "semantic-failure",
  "mixed-repair-authority",
  "push-denied",
  "passing",
  "draft",
  "archive-only",
  "authority",
] as const;

export const CONTEXT_TREE_REVIEW_GATE_CASES: readonly ContextTreeReviewEvalCase[] = [
  {
    id: "validator-failure-repairs-and-approves",
    fixture: { scenario: "validator-failure" },
    expected: {
      action: "approve",
      bodyHints: [],
      initialVerifyMustPass: false,
      repair: "success",
      repairPaths: ["system/review-contract.md"],
      repairableHandoffHints: ["TREE_TITLE_MISSING", "system/review-contract.md"],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["repair-first", "validator-first"],
    tier: "gate",
  },
  {
    id: "semantic-failure-repairs-and-approves",
    fixture: { scenario: "semantic-failure" },
    expected: {
      action: "approve",
      bodyHints: [],
      initialVerifyMustPass: true,
      repair: "success",
      repairPaths: ["system/review-contract.md"],
      repairableHandoffHints: ["implementation", "source", "system/review-contract.md"],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["repair-first", "semantic"],
    tier: "gate",
  },
  {
    id: "mixed-repair-authority-repairs-safe-first",
    fixture: { scenario: "mixed-repair-authority" },
    expected: {
      action: "comment",
      bodyHints: ["authority", "owner", "system/authority-contract.md"],
      firstHeading: "## Human decision required",
      initialVerifyMustPass: true,
      repair: "success",
      repairPaths: ["system/review-wording.md"],
      repairableHandoffHints: ["system/review-wording.md", "implementation", "provenance"],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["human-authority", "mixed", "repair-first"],
    tier: "gate",
  },
  {
    id: "push-denied-reports-repair-blocker",
    fixture: { scenario: "push-denied" },
    expected: {
      action: "request-changes",
      bodyHints: ["repair is blocked", "push", "review-change"],
      firstHeading: "## Changes requested",
      initialVerifyMustPass: true,
      repair: "push-denied",
      repairPaths: ["system/review-contract.md"],
      repairableHandoffHints: ["system/review-contract.md"],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["push-denied", "repair-first"],
    tier: "gate",
  },
  {
    id: "passing-ready-approves",
    fixture: { scenario: "passing" },
    expected: {
      action: "approve",
      bodyHints: [],
      initialVerifyMustPass: true,
      repair: "none",
      repairPaths: [],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["approve"],
    tier: "gate",
  },
  {
    id: "passing-draft-defers",
    fixture: { scenario: "draft" },
    expected: {
      action: "comment",
      bodyHints: ["draft", "ready"],
      firstHeading: "## Approval deferred",
      initialVerifyMustPass: true,
      repair: "none",
      repairPaths: [],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["draft"],
    tier: "gate",
  },
  {
    id: "archive-only-comments",
    fixture: { scenario: "archive-only" },
    expected: {
      action: "comment",
      bodyHints: ["supporting", "canonical"],
      initialVerifyMustPass: true,
      repair: "none",
      repairPaths: [],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["content-class"],
    tier: "gate",
  },
  {
    id: "authority-needs-human",
    fixture: { scenario: "authority" },
    expected: {
      action: "comment",
      bodyHints: ["authority", "owner"],
      firstHeading: "## Human decision required",
      initialVerifyMustPass: true,
      repair: "none",
      repairPaths: [],
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["human-authority"],
    tier: "gate",
  },
];

export const CONTEXT_TREE_REVIEW_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: { gateCaseIds: CONTEXT_TREE_REVIEW_GATE_CASES.map((item) => item.id) },
    fixture: { scenarios: CONTEXT_TREE_REVIEW_GATE_CASES.map((item) => item.fixture.scenario) },
    id: FLOOR_CASE_ID,
    skill: "context-tree-review",
    status: "implemented",
    tier: "floor",
  },
  ...CONTEXT_TREE_REVIEW_GATE_CASES,
];

export const CONTEXT_TREE_REVIEW_SUITE: SkillEvalSuiteDefinition = {
  cases: CONTEXT_TREE_REVIEW_EVAL_CASES,
  coverage: {
    skill: "context-tree-review",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate review skill routing and gate fixture coverage.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: CONTEXT_TREE_REVIEW_GATE_CASES.map((item) => item.id),
        description: "Live repair-first, validator-first, and verdict-mapping review cases.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "context-tree-review",
};
