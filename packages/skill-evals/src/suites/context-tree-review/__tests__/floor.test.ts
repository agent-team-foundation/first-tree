import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTEXT_TREE_REVIEW_GATE_CASES,
  CONTEXT_TREE_REVIEW_SUITE,
  CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS,
} from "../cases.js";
import { skillHasPolicyDuplication } from "../fixture.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");

describe("context-tree-review floor", () => {
  it("covers the deterministic verdict and race outcomes", () => {
    expect(CONTEXT_TREE_REVIEW_GATE_CASES.map((item) => item.fixture.scenario)).toEqual([
      "validator-failure",
      "semantic-failure",
      "passing",
      "draft",
      "archive-only",
      "authority",
      "stale-head",
      "submission-race",
    ]);
    expect(CONTEXT_TREE_REVIEW_SUITE.coverage.tiers.map((item) => item.tier)).toEqual(["floor", "gate"]);
    expect(CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS).toEqual([
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
    ]);
  });

  it("makes approval mandatory for the passing ready case", () => {
    const passing = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "passing");
    expect(passing?.expected.action).toBe("approve");
  });

  it("uses one trusted App-run publication path", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");
    const cloud = readFileSync(
      join(repoRoot, "packages", "server", "src", "prompts", "context-reviewer-pr.ejs"),
      "utf8",
    );

    expect(skillHasPolicyDuplication(repoRoot)).toBe(false);
    expect(skill).toContain("first-tree tree review");
    expect(skill).toContain('--run "$CONTEXT_REVIEW_RUN_ID"');
    expect(skill).toContain("GitHub App webhook\nis the only dispatch authority");
    expect(skill).toContain("Historical managed markers are inert text");
    expect(skill).not.toContain("first-tree github context-review");
    expect(skill).not.toContain("reviewPacketV1");
    expect(skill).not.toContain("contextReviewManagedEventV1");
    expect(cloud).toContain("context-tree-review");
    expect(cloud).toContain("first-tree tree review");
    expect(cloud).not.toContain("gh pr review");
  });

  it("pins repair, successor review, App verdict, and local exact-head merge", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");

    expect(skill).toContain("first-tree tree review --check");
    expect(skill).toContain("dispatch-time Reviewer client/session generation");
    expect(skill).toContain("dispatch-time App\ninstallation");
    expect(skill).toContain("There is no managed packet, PR-body consent block, repair-scope parser");
    expect(skill).not.toContain("parse-repair-scope.mjs");
    expect(skill).toContain("repairable paths = live base...RUN_HEAD changed files ∩ non-protected policy");
    expect(skill).toContain("same-repository and non-fork");
    expect(skill).toContain("before the first semantic read");
    expect(skill).toContain("Do not create or update a persistent local review ref");
    expect(skill).toContain("Execute these as four separate, synchronous commands");
    expect(skill).toContain("start only after its immediately preceding fetch has exited successfully");
    expect(skill).toContain("in a batch of tool calls");
    expect(skill).toContain('WORKSPACE_ROOT="$PWD"');
    expect(skill).toContain('REVIEW_WORKTREE="$WORKSPACE_ROOT/.review-worktrees/$PR_NUMBER"');
    expect(skill).toContain(
      'git -C "$TREE_PATH" worktree add --detach "$PWD/.review-worktrees/$PR_NUMBER" "$RUN_HEAD"',
    );
    expect(skill).toContain("or any\nother relative `worktree add` argument");
    expect(skill).toContain("do not read\nTree content after the failed verification");
    expect(skill).toContain("Tool working-directory state is not auditable head\nevidence");
    expect(skill).toContain("Do not use bare readers such as `cat NODE.md`, `rg --files .`, or a\nbare `git diff`");
    expect(skill).toContain('git -C "$REVIEW_WORKTREE" diff');
    expect(skill).toContain("immediately before every edit");
    expect(skill).toContain("immediately before every commit");
    expect(skill).toContain("immediately before every push");
    expect(skill).toContain("immediately before `first-tree tree review`");
    expect(skill).toContain("immediately before the local merge attempt");
    expect(skill).toContain("new or removed top-level domain structure");
    expect(skill).toContain("`owners` or `decisionLocksCode` metadata");
    expect(skill).toContain("After a successful repair push, stop the old run immediately");
    expect(skill).toContain("successor run");
    expect(skill).toContain('--match-head-commit "$RUN_HEAD"');
    expect(skill).toContain("Never use `--admin`");
    expect(skill).toContain("exactly one attempt");
    expect(skill).toContain("publicationDisposition: created");
    expect(skill).toContain("`existing` or `reconciled`");
    expect(skill).toContain("`.review-body-$PR_NUMBER.md`");
    expect(skill).toContain("Remove `.review-body-$PR_NUMBER.md` immediately");
    expect(skill).toContain("`## Approval deferred`");
    expect(skill).toContain("archive/supporting\n  changes are out of scope for canonical approval");
    expect(skill).toContain("`## Human decision required`");
    expect(skill).not.toContain("10 minutes");
    expect(skill).not.toContain("Retry merge");
    expect(skill).toContain("approved_not_merged");
    expect(skill).toContain("commit-bound pull-request review is the\nonly verdict");
    expect(skill).toContain("never\ncopy the verdict into a second canonical surface");
  });
});
