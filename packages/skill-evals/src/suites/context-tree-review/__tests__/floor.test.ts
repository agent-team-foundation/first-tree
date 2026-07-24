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
  it("covers the deterministic review outcomes", () => {
    expect(CONTEXT_TREE_REVIEW_GATE_CASES.map((item) => item.fixture.scenario)).toEqual([
      "validator-failure",
      "semantic-failure",
      "mixed-repair-authority",
      "push-denied",
      "passing",
      "relationship-change",
      "draft",
      "archive-only",
      "authority",
      "passing",
      "semantic-failure",
    ]);
    expect(CONTEXT_TREE_REVIEW_SUITE.coverage.tiers.map((item) => item.tier)).toEqual(["floor", "gate"]);
    expect(CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS).toEqual([
      "validator-failure",
      "semantic-failure",
      "mixed-repair-authority",
      "push-denied",
      "passing",
      "relationship-change",
      "draft",
      "archive-only",
      "authority",
    ]);
    expect(
      CONTEXT_TREE_REVIEW_GATE_CASES.filter((item) => item.forgeProvider === "gitlab").map((item) => item.id),
    ).toEqual(["gitlab-passing-exact-sha-merges", "gitlab-semantic-repair-rereviews-and-merges"]);
  });

  it("makes approval mandatory for the passing ready case", () => {
    const passing = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "passing");
    expect(passing?.expected.action).toBe("approve");
    expect(passing?.prompt).toContain("current checks and freshness");
  });

  it("keeps draft findings read-only and deferred", () => {
    const draft = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "draft");
    expect(draft?.expected).toMatchObject({
      action: "comment",
      firstHeading: "## Approval deferred",
      repair: "none",
    });
    expect(draft?.expected.bodyHints).toContain("implementation");
  });

  it("requires repair-first behavior for deterministic findings", () => {
    const validator = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "validator-failure");
    const semantic = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "semantic-failure");
    const mixed = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "mixed-repair-authority");
    const denied = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "push-denied");

    expect(validator?.expected).toMatchObject({ action: "approve", repair: "success" });
    expect(semantic?.expected).toMatchObject({ action: "approve", repair: "success" });
    expect(mixed?.expected).toMatchObject({
      action: "request-changes",
      firstHeading: "## Changes requested",
      repair: "success",
    });
    expect(denied?.expected).toMatchObject({ action: "request-changes", repair: "push-denied" });
    expect(denied?.expected.bodyHints).toEqual(expect.arrayContaining(["push", "review-change"]));
  });

  it("maps a proven authority violation to request changes", () => {
    const authority = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "authority");
    expect(authority?.expected).toMatchObject({
      action: "request-changes",
      firstHeading: "## Changes requested",
    });
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
    expect(skill).toContain("GitHub App webhook owns review dispatch");
    expect(skill).toContain("Historical managed marker text\nhas no behavior");
    expect(skill).not.toContain("first-tree github context-review");
    expect(skill).not.toContain("reviewPacketV1");
    expect(skill).not.toContain("contextReviewManagedEventV1");
    expect(cloud).toContain("context-tree-review");
    expect(cloud).toContain("first-tree tree review");
    expect(cloud).not.toContain("gh pr review");
  });

  it("pins mandatory local repair, App verdict, and response-head local merge", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");

    expect(skill).toContain("first-tree org context-tree review-config --json");
    expect(skill).toContain("No PR-body consent\n  block or task packet is required");
    expect(skill).toContain("`SAFE_REPAIR` is an obligation, not an option");
    expect(skill).toContain("A mixed review must repair all");
    expect(skill).toMatch(/Never ask the author\s+to perform a `SAFE_REPAIR`/u);
    expect(skill).toContain("same-repository and non-fork");
    expect(skill).toContain("ready for review, same-repository and non-fork");
    expect(skill).toContain("`PROTECTED_DECISION`");
    expect(skill).toContain("`REPAIR_BLOCKED`");
    expect(skill).toContain("top-level domain structure");
    expect(skill).toContain("`owners` or `decisionLocksCode` metadata");
    expect(skill).toContain("Immediately before mutation, rerun");
    expect(skill).toContain("Immediately before push, rerun\n`first-tree org context-tree review-config --json`");
    expect(skill).toContain("Untouched protected residuals retain\ntheir original classification");
    expect(skill).toContain('staged base-to-result diff with `git diff --cached --no-ext-diff "$BASE_OID"`');
    expect(skill).toContain("A draft PR is read-only even when its findings would be mechanically");
    expect(skill).toContain("Immediately before submitting any outcome, rerun");
    expect(skill).toContain("base/target ref\nto equal that live binding branch");
    expect(skill).toContain("After check polling completes, rerun the same live Reviewer configuration check");
    expect(skill).toContain("its repository, state, draft flag,\nbase/target ref/OID and head repository/ref/OID");
    expect(skill).toContain("branch-attached repair worktree through normal `git worktree remove`");
    expect(skill).toContain("`data.reviewedHead` is the only merge authority");
    expect(skill).toMatch(/gh api \\\s+--method PUT/u);
    expect(skill).toContain('"sha=$REVIEWED_HEAD"');
    expect(skill).toContain("merge_method=squash");
    expect(skill).toContain("exactly one merge `PUT`");
    expect(skill).not.toContain('gh pr merge "$PR_NUMBER"');
    expect(skill).not.toContain("--match-head-commit");
    expect(skill).not.toContain("parse-repair-scope");
    expect(skill).toContain("Never use `--admin`");
    expect(skill).toContain("App-authored PR review is the only GitHub verdict");
    expect(skill).toContain("do not copy the\nGitHub verdict into a second canonical comment/status/receipt");
    expect(skill).toMatch(/> Executed by \*\*First Tree Context Reviewer\*\* · head \*\*<short-head>\*\*/u);
    expect(skill).toContain("name the repair commit and label the current host `gh` login");
    expect(skill).toMatch(/do not present it as proof of the\s+commit author, push credential or merger/u);
    expect(skill).toMatch(/do not expose an internal Agent name\s+or UUID/u);
    expect(skill).toMatch(/Do not imply a local mutation when\s+none occurred or predeclare the later merge actor/u);
  });

  it("requires two-pass final-head review and full repair re-review without a ledger protocol", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");

    expect(skill).toContain("### Evidence pass");
    expect(skill).toContain("### Challenge pass");
    expect(skill).toContain("**Decision steward:**");
    expect(skill).toContain("**Tree curator:**");
    expect(skill).toContain("**Future agent:**");
    expect(skill).toContain("not extra agents, outputs, votes or protocol\nstate");
    expect(skill).toContain("### Calibrated final checklist");
    expect(skill).toContain("`PASS`,\n`N/A` or `FINDING`");
    expect(skill).toContain("Only an unresolved `Blocking` finding prevents\n`APPROVE`");
    expect(skill).toContain("only `Advisory` findings still receives\n`APPROVE`");
    expect(skill).toContain("observable diff trigger");
    expect(skill).toMatch(/leaf-local body change with none of these\s+observable triggers/u);
    expect(skill).toContain("Do not\nrecursively read every descendant");
    expect(skill).toContain("do not read unrelated domains merely because the tree is\nsmall");
    expect(skill).toContain("proven unauthorized ownership, lock or governance");
    expect(skill).toMatch(/this is\s+focused PR review, not a\s+whole-tree audit/u);
    expect(skill).toContain("Do not manufacture a finding merely to\ndemonstrate adversarial review");
    expect(skill).toContain("Both passes must complete on the final head");
    expect(skill).toContain("restart the full\nvalidator-first review on the resulting head");
    expect(skill).toMatch(/repair did\s+not introduce a new blocker/u);
    expect(skill).toContain("not a required machine-formatted\nledger");
    expect(skill).not.toContain("reviewPacketV1");
  });

  it("routes trusted Context Tree review through distinct GitHub and GitLab contracts", () => {
    const skillDir = join(repoRoot, "skills", "context-tree-review");
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const description = skill.split("\n").find((line) => line.startsWith("description:"));
    const openai = readFileSync(join(skillDir, "agents", "openai.yaml"), "utf8");

    expect(description).toMatch(/Review a GitHub pull request or GitLab merge request/);
    expect(skill).toContain("A local mirror\ncannot override provider authority");
    expect(skill).toContain("For a GitHub run use only\n   `gh`; for a GitLab run use only `glab`");
    expect(skill).toContain("`contextReviewConnectionId` and\n`contextReviewInstanceOrigin`");
    expect(skill).toContain("the same `gitlabConnection.id`, and the same\nexact normalized");
    expect(skill).toContain("before every\nrepair edit, commit, push, MR note, and merge mutation");
    expect(skill).toContain("GitLab has no First Tree approval action");
    expect(skill).toContain("Never run `first-tree tree review`");
    expect(skill).toContain("Use `glab mr note`");
    expect(skill).toContain('glab mr merge "$MR_IID"');
    expect(skill).toContain('--sha "$REVIEWED_HEAD"');
    expect(skill).toMatch(/Merge\s+Requests API documents and enforces the SHA compare-and-set/u);
    expect(skill).toContain("Never replace CAS with “read head then merge unconditionally.”");
    expect(skill).toContain("exactly one read-only `glab mr view` or `glab api` reconciliation");
    expect(skill).toContain("pipeline_or_protection");
    expect(skill).toContain("let Note webhooks self-trigger a review");
    expect(skill).toContain("App-authored PR\n  review is the only GitHub verdict");
    expect(openai).toContain("provider-scoped Context Reviewer run");
  });
});
