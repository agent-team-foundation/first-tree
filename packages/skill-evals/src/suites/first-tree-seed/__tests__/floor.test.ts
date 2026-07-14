import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_TREE_SEED_GATE_CASES, FIRST_TREE_SEED_SUITE } from "../cases.js";

const validateFloor = FIRST_TREE_SEED_SUITE.validateFloor;
if (!validateFloor) {
  throw new Error("first-tree-seed suite must define validateFloor");
}

const skillMarkdown = readFileSync(join(process.cwd(), "../../skills/first-tree-seed/SKILL.md"), "utf8");

describe("first-tree-seed floor invariants", () => {
  it("accepts the shipped lifecycle cases", () => {
    expect(validateFloor(FIRST_TREE_SEED_SUITE.cases)).toEqual([]);
  });

  it("keeps chat-provided sources independent of GitHub App setup", () => {
    expect(skillMarkdown).toContain("An empty or absent `manifest.sources` is valid");
    expect(skillMarkdown).toMatch(/local\s+project folder or GitHub repository URL/);
    expect(skillMarkdown).toContain("Do not send them to Settings");
    expect(skillMarkdown).toMatch(/rather than asking for the First\s+Tree GitHub App/);
  });

  it("keeps the confirmation gate while collapsing delivery to one PR", () => {
    expect(skillMarkdown).toContain("same run");
    expect(skillMarkdown).toContain("single reviewable PR");
    expect(skillMarkdown).toContain("There is no\nintermediate PR and no merge between the passes");
    expect(skillMarkdown).toContain("The one human gate is the **in-chat checklist approval**, not a PR merge.");
    expect(skillMarkdown).toContain("Do not write anything — structure or content — before the user has signed");
    expect(skillMarkdown).toContain("there is no ping, no merge, and no waiting");
    expect(skillMarkdown).toContain("chore/seed-tree");
    expect(skillMarkdown).toMatch(/Do not\s+use `git ls-tree`, `git show`, `git grep`/);
  });

  it("delays App coverage guidance until a reviewable milestone", () => {
    expect(skillMarkdown).toContain("After the seed PR is open");
    expect(skillMarkdown).toContain("do not interrupt source resolution, structure");
    expect(skillMarkdown).toContain("relay only a recovery URL returned");
  });

  it("ships behavioral gates for chat-supplied sources and post-confirmation single-PR delivery", () => {
    const chatSource = FIRST_TREE_SEED_GATE_CASES.find((evalCase) => evalCase.id === "empty-manifest-chat-source");
    expect(chatSource).toMatchObject({
      expected: { action: "propose_skeleton", requireSourceRead: true, requireWorktree: false },
      fixture: { sourceRepoState: "chat-local-readable", treeState: "empty" },
    });
    expect(chatSource?.forbidden.actions).toContain("require_github_app");

    const build = FIRST_TREE_SEED_GATE_CASES.find(
      (evalCase) => evalCase.id === "same-chat-approved-skeleton-builds-single-pr",
    );
    expect(build).toMatchObject({
      expected: {
        action: "build_single_pr",
        requireChatHistoryRead: true,
        requireSourceRead: true,
        requireWorktree: true,
      },
      fixture: { chatHistoryState: "approved-skeleton", sourceRepoState: "bare-readable", treeState: "empty" },
    });
    expect(build?.forbidden.actions).toContain("restart_skeleton_proposal");
    expect(build?.forbidden.actions).toContain("legacy_two_pr_handoff");
  });
});
