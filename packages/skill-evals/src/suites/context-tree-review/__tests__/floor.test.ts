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
    expect(skill).toContain("`FIRST_TREE_CHAT_ID` + `FIRST_TREE_AGENT_ID` + the inspected SHA");
    expect(skill).toContain(
      "<!-- first-tree-context-review-result:v1 chat=<chat-uuid> reviewer=<reviewer-uuid> head=<head-sha> -->",
    );
    expect(skill).toContain(
      "<!-- first-tree-context-review-comment:v2 id=<github-comment-id> to=@<recipient-agent-name> -->",
    );
    expect(skill).toContain("positive numeric comment id and URL");
    expect(skill).toContain("actual `chat send` recipient");
    expect(skill).toContain("one LF or\nCRLF file terminator");
    expect(skill).toContain("must equal the\nGitHub comment body byte for byte");
    expect(skill).toContain("do not add the\noutcome, escape values, hash the tuple, or vary field names/order");
    expect(skill).toContain("Another Reviewer's same-head `READY`");
    expect(skill).toContain("If assignment later returns to A on the same head");
    expect(skill).toContain("A runtime or Host switch that preserves the same `FIRST_TREE_AGENT_ID`");
    expect(skill).toContain("page the complete PR Chat history");
    expect(skill).toContain("two consecutive complete-history passes");
    expect(skill).toContain("`(id, createdAt, metadata.editedAt)` digest");
    expect(skill).toContain("inspect `metadata.editedAt` on every message in the complete");
    expect(skill).toContain("an in-place edit after the terminal boundary is freshness-unproven");
    expect(skill).toContain("`createdAt` and `updatedAt`/`lastEditedAt`");
    expect(skill).toContain("authoritative\n`senderId` to equal the marker's Reviewer UUID");
    expect(skill).toContain("Immediately before the GitHub projection");
    expect(skill).toContain("own just-written canonical comment\nand status are the sole expected delta");
    expect(skill).toContain("substantive evidence, a blocking finding, a human decision, or a managed");
    expect(skill).toContain("A later protected `contextReviewManagedEventV1` message is only a GitHub");
    expect(skill).toContain("webhook's immutable comment id equals the\nterminal receipt");
    expect(skill).toContain("changed body from the same author, same comment id, and same\nmarker is new review input");
    expect(skill).toContain("A stale or unproven result cannot be reused and cannot authorize merge");
    expect(skill).toContain("Another Reviewer's result never authorizes merge");
    expect(skill).toContain("Immediately before each edit, commit, push, GitHub comment/status write, and");
    expect(skill).toContain("There is no fixed repair-count limit");
    expect(skill).toContain('--match-head-commit "$REVIEWED_HEAD"');
    expect(skill).toContain("--squash");
    expect(skill).toContain("Never submit GitHub `APPROVE`");
    expect(skill).toContain("not a distributed transaction with");
  });
});
