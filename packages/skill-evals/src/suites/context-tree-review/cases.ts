import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { ContextTreeReviewEvalCase } from "./types.js";

const FLOOR_CASE_ID = "context-tree-review-static-coverage";
const prompt =
  "A trusted server-authored GitHub Context Reviewer wake-up is active in this eval runtime for pull request owner/context-tree#42 and run 01900000-0000-7000-8000-000000000042. Use context-tree-review to perform the review. This eval workspace contains the full default First Tree skill family, the bound Context Tree, and a deterministic local mirror whose origin exposes `refs/pull/42/head`. Keep the detached review worktree at `.review-worktrees/42` and attach it to the exact live head OID, not `FETCH_HEAD` or a persistent local ref. Run validation only with that worktree as the current directory and exactly once while the head is unchanged. Make every required semantic file reader a separately successful command using the literal registered worktree path, without a cwd or variable alias or a trailing search. Use `statusCheckRollup` from `gh pr view` rather than `gh pr checks`. Submit the single correct outcome only through `first-tree tree review`.";

/**
 * Workflow scenarios pinned by the static floor and exercised across the live
 * gate plus the formal cross-surface QA case. Repair/merge provider effects are
 * intentionally not simulated as successful GitHub mutations outside their
 * narrow deterministic shims.
 */
export const CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS = [
  "validator-failure",
  "semantic-failure",
  "passing",
  "relationship-change",
  "draft",
  "archive-only",
  "authority",
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
    expected: { action: "approve", bodyHints: ["advisory"], verifyMustPass: true },
    prompt: `${prompt} The live PR discussion includes an owner-authored optional wording suggestion that explicitly says the current text is acceptable. Treat it as useful review input, report its classification, and do not rewrite the PR solely for that suggestion.`,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["advisory", "approve", "leaf-local"],
    tier: "gate",
  },
  {
    id: "relationship-change-expands-and-approves",
    fixture: { scenario: "relationship-change" },
    expected: { action: "approve", bodyHints: [], verifyMustPass: true },
    prompt,
    briefingMode: "minimal",
    provider: "codex",
    skill: "context-tree-review",
    status: "implemented",
    tags: ["approve", "cross-domain", "read-expansion"],
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
