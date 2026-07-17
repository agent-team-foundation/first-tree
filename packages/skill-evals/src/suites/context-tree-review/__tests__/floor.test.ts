import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_REVIEW_GATE_CASES, CONTEXT_TREE_REVIEW_SUITE } from "../cases.js";
import { skillHasPolicyDuplication } from "../fixture.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");

describe("context-tree-review floor", () => {
  it("covers every required live outcome", () => {
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
  });

  it("makes approval mandatory for the passing ready case", () => {
    const passing = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === "passing");
    expect(passing?.expected.action).toBe("approve");
  });

  it("keeps content policy out of the skill and legacy publication narrow", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");
    const cloud = readFileSync(
      join(repoRoot, "packages", "server", "src", "prompts", "context-reviewer-pr.ejs"),
      "utf8",
    );

    expect(skill).toContain("generated `AGENTS.md` / `CLAUDE.md` Context Tree Policy");
    expect(skillHasPolicyDuplication(repoRoot)).toBe(false);
    expect(skill).toContain("first-tree github context-review submit");
    expect(skill).toContain('--run "$CONTEXT_REVIEW_RUN_ID"');
    expect(skill).toContain("Legacy App compatibility");
    expect(skill).toContain("If the live PR contains the managed marker, submit nothing");
    expect(cloud).toContain("context-tree-review");
    expect(cloud).not.toContain("gh pr review");
    expect(cloud).not.toContain("tree verify");
  });

  it("pins the managed Reviewer repair and exact-head merge contract", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");

    expect(skill).toContain("There is no human review mode and no configurable merge method");
    expect(skill).toContain("first-tree org context-tree review-config --json");
    expect(skill).toContain("Immediately before each edit, commit, push, GitHub comment/status write, and");
    expect(skill).toContain("There is no fixed repair-count limit");
    expect(skill).toContain('--match-head-commit "$REVIEWED_HEAD"');
    expect(skill).toContain("--squash");
    expect(skill).toContain("Never submit GitHub `APPROVE`");
    expect(skill).toContain("not a distributed transaction with");
  });
});
