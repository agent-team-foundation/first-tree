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
      "draft",
      "archive-only",
      "authority",
    ]);
    expect(CONTEXT_TREE_REVIEW_SUITE.coverage.tiers.map((item) => item.tier)).toEqual(["floor", "gate"]);
    expect(CONTEXT_TREE_REVIEW_WORKFLOW_SCENARIOS).toEqual([
      "validator-failure",
      "semantic-failure",
      "mixed-repair-authority",
      "push-denied",
      "passing",
      "draft",
      "archive-only",
      "authority",
    ]);
  });

  it("makes approval mandatory for the passing ready case", () => {
    const passing = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "passing");
    expect(passing?.expected.action).toBe("approve");
  });

  it("requires repair-first behavior for deterministic findings", () => {
    const validator = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "validator-failure");
    const semantic = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "semantic-failure");
    const mixed = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "mixed-repair-authority");
    const denied = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "push-denied");

    expect(validator?.expected).toMatchObject({ action: "approve", repair: "success" });
    expect(semantic?.expected).toMatchObject({ action: "approve", repair: "success" });
    expect(mixed?.expected).toMatchObject({ action: "comment", repair: "success" });
    expect(denied?.expected).toMatchObject({ action: "request-changes", repair: "push-denied" });
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

  it("pins mandatory local repair, App verdict, and repository-gated local merge", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");

    expect(skill).toContain("first-tree org context-tree review-config --json");
    expect(skill).toContain("No PR-body consent\n  block or task packet is required");
    expect(skill).toContain("`SAFE_REPAIR` is an obligation, not an option");
    expect(skill).toContain("A mixed review must repair all");
    expect(skill).toContain("Never ask the author to perform a\n  `SAFE_REPAIR`");
    expect(skill).toContain("same-repository and non-fork");
    expect(skill).toContain("ready for review, same-repository and non-fork");
    expect(skill).toContain("`PROTECTED_DECISION`");
    expect(skill).toContain("`REPAIR_BLOCKED`");
    expect(skill).toContain("top-level domain structure");
    expect(skill).toContain("`owners` or `decisionLocksCode` metadata");
    expect(skill).toContain("Immediately before mutation, re-read the live PR and source ref");
    expect(skill).toContain('with `git diff "$BASE_OID"` before staging or committing');
    expect(skill).toContain("branch-attached repair worktree through normal `git worktree remove`");
    expect(skill).toContain('gh pr merge "$PR_NUMBER" --repo "$REPOSITORY" --squash');
    expect(skill).not.toContain("--match-head-commit");
    expect(skill).not.toContain("parse-repair-scope");
    expect(skill).toContain("Never use `--admin`");
    expect(skill).toContain("App-authored PR review is the only GitHub verdict");
    expect(skill).toContain("do not copy the\nGitHub verdict into a second canonical comment/status/receipt");
  });

  it("keeps Context Tree review GitHub-only and fails closed for GitLab", () => {
    const skillDir = join(repoRoot, "skills", "context-tree-review");
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const description = skill.split("\n").find((line) => line.startsWith("description:"));
    const openai = readFileSync(join(skillDir, "agents", "openai.yaml"), "utf8");

    expect(description).toMatch(/Review a GitHub pull request/);
    expect(description).toMatch(/do not use it for GitLab Merge Requests/);
    expect(skill).toContain("This workflow is GitHub-only");
    expect(skill).toContain("ordinary independent GitLab MR review path");
    expect(skill).toContain("A GitLab URL, Merge Request identifier, or bound GitLab upstream");
    expect(skill).toContain("A local mirror cannot override this exclusion");
    expect(skill).toContain("classify the upstream before any clone");
    expect(skill).toContain("stop before any Reviewer configuration\n   lookup, clone");
    expect(skill).toContain("never fall back to\n   `gh` or substitute `glab`");
    expect(skill).toContain("A local filesystem mirror is not provider\n   authority");
    expect(skill).toContain("prove a GitHub pull request before any fetch");
    expect(openai).toContain("trusted GitHub App Context Reviewer run");
  });
});
