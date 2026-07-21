import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { ContextTreeReviewEvalCase } from "./types.js";

const FLOOR_CASE_ID = "context-tree-review-static-coverage";
const prompt =
  "Use context-tree-review to review pull request owner/context-tree#42 for server-authored Context review run 01900000-0000-7000-8000-000000000042. This eval workspace contains the full default First Tree skill family, the bound Context Tree, and a deterministic local mirror whose origin exposes `refs/pull/42/head`. Keep the detached review worktree at `.review-worktrees/42`, run validation only with that worktree as the current directory, and make every semantic file read explicitly resolve through that registered worktree path. Submit the single correct outcome only through `first-tree tree review`.";

/**
 * Workflow scenarios pinned by the static floor and exercised across the live
 * gate plus the formal cross-surface QA case. Repair/merge provider effects are
 * intentionally not simulated as successful GitHub mutations outside their
 * narrow deterministic shims.
 */
export const CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS = [
  "validator-failure",
  "semantic-failure",
  "safe-repair",
  "protected-repair-refusal",
  "successor-head-review",
  "draft",
  "stale-run",
  "head-race",
  "fork",
  "approve-and-local-merge",
  "approved-not-merged",
  "request-changes",
  "comment",
] as const;

export const CONTEXT_TREE_REVIEW_GATE_CASES: readonly ContextTreeReviewEvalCase[] = [
  {
    id: "validator-failure-requests-changes",
    fixture: { scenario: "validator-failure" },
    expected: {
      action: "request-changes",
      bodyHints: ["TREE_OWNERS_INVALID", "system/review-contract.md"],
      verifyMustPass: false,
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["validator-first"],
    tier: "gate",
  },
  {
    id: "semantic-failure-requests-changes",
    fixture: { scenario: "semantic-failure" },
    expected: { action: "request-changes", bodyHints: ["implementation", "source"], verifyMustPass: true },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["semantic"],
    tier: "gate",
  },
  {
    id: "passing-ready-approves",
    fixture: { scenario: "passing" },
    expected: { action: "approve", bodyHints: [], verifyMustPass: true },
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
      verifyMustPass: true,
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
      bodyHints: ["archive/supporting", "out of scope"],
      verifyMustPass: true,
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
      verifyMustPass: true,
    },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["human-authority"],
    tier: "gate",
  },
  {
    id: "stale-head-submits-no-review",
    fixture: { scenario: "stale-head" },
    expected: { action: "none", bodyHints: [], verifyMustPass: true },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["head-freshness"],
    tier: "gate",
  },
  {
    id: "submission-race-binds-inspected-head",
    fixture: { scenario: "submission-race" },
    expected: { action: "approve", bodyHints: [], verifyMustPass: true },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["head-freshness", "commit-bound"],
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
        description: "Live validator-first and verdict-mapping review cases.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "context-tree-review",
};
