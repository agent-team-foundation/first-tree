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
    expect(skill).toContain("GitHub App webhook is the only review-dispatch authority");
    expect(skill).toContain("Historical\n`first-tree-context-review:managed-v1` text has no behavior");
    expect(skill).not.toContain("first-tree github context-review");
    expect(skill).not.toContain("reviewPacketV1");
    expect(skill).not.toContain("contextReviewManagedEventV1");
    expect(cloud).toContain("context-tree-review");
    expect(cloud).toContain("first-tree tree review");
    expect(cloud).not.toContain("gh pr review");
  });

  it("pins repair, successor review, App verdict, and local exact-head merge", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");

    expect(skill).toContain("first-tree org context-tree review-config --json");
    expect(skill).toContain("There is no packet");
    expect(skill).toContain("scripts/parse-repair-scope.mjs");
    expect(skill).toContain("fixed consent sentence and Repair scope heading exactly\nonce and in order");
    expect(skill).toContain("missing, duplicate, invalid or ambiguous\nblock disables automatic repair only");
    expect(skill).toContain("same-repository, non-fork PR");
    expect(skill).toContain("intersection of the parsed scope, that changed\nset and the protection rules");
    expect(skill).toContain("reread PR body, open/draft/base/head-repository/source-ref/head state");
    expect(skill).toContain("top-level domain structure");
    expect(skill).toContain("`owners` or `decisionLocksCode` metadata");
    expect(skill).toContain("current run ends immediately without\ncalling `tree review`");
    expect(skill).toContain("successor exact-head run");
    expect(skill).toContain('--match-head-commit "$REVIEWED_HEAD"');
    expect(skill).toContain("Never use `--admin`");
    expect(skill).toContain("approved_not_merged");
    expect(skill).toContain("commit-bound review is the only GitHub verdict");
    expect(skill).toContain("do not\ncopy the GitHub verdict into a second canonical comment/status/receipt");
  });
});
