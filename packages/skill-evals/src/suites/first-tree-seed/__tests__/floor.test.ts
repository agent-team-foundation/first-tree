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

  it("checks same-chat Phase 2 continuation before refusing state C", () => {
    const continuation = skillMarkdown.indexOf("Check for a Phase 2 continuation before classifying state C");
    const stateC = skillMarkdown.indexOf("**C — Already seeded.**");

    expect(continuation).toBeGreaterThan(-1);
    expect(stateC).toBeGreaterThan(continuation);
    expect(skillMarkdown).toContain("this setup chat's visible history");
    expect(skillMarkdown).toContain("re-resolve the same readable sources and enter Phase 2");
    expect(skillMarkdown).toContain("applies only to the Context Tree checkout");
    expect(skillMarkdown).toMatch(/Do not\s+use `git ls-tree`, `git show`, `git grep`/);
    expect(skillMarkdown).toContain("not a leftover checkout");
  });

  it("configures GitHub branch rules only after creating a GitHub Context Repo", () => {
    expect(skillMarkdown).toContain("only after `tree init` succeeds");
    expect(skillMarkdown).toMatch(/only when the\s+new Context Repo is a GitHub repository/);
    expect(skillMarkdown).toContain("Do not run it for an already-bound tree");
    expect(skillMarkdown).toContain("repo=$(gh repo view");
    expect(skillMarkdown).toContain('gh api "repos/$repo/rulesets"');
    expect(skillMarkdown).toContain('"include": ["~DEFAULT_BRANCH"]');
    expect(skillMarkdown).toContain('"type": "non_fast_forward"');
    expect(skillMarkdown).toContain('"type": "pull_request"');
    expect(skillMarkdown).toContain('"required_approving_review_count": 1');
    expect(skillMarkdown).toContain('"require_code_owner_review": true');
    expect(skillMarkdown).toContain('"dismiss_stale_reviews_on_push": false');
    expect(skillMarkdown).toContain('"require_last_push_approval": false');
    expect(skillMarkdown).toContain('"required_review_thread_resolution": false');
    expect(skillMarkdown).toMatch(/automatic\s+branch-rule setup failed/);
    expect(skillMarkdown).toContain("newly created GitHub Context Repo (validate workflows, CODEOWNERS, extra");
    expect(skillMarkdown).not.toMatch(/rulesets,\s+CODEOWNERS\) — out of scope/);
  });

  it("delays App coverage guidance until a reviewable milestone", () => {
    expect(skillMarkdown).toContain("After the Phase 1 PR is open");
    expect(skillMarkdown).toContain("do not interrupt source resolution, structure");
    expect(skillMarkdown).toContain("relay only a recovery URL returned");
  });

  it("ships behavioral gates for chat-supplied sources and same-chat Phase 2 continuation", () => {
    const chatSource = FIRST_TREE_SEED_GATE_CASES.find((evalCase) => evalCase.id === "empty-manifest-chat-source");
    expect(chatSource).toMatchObject({
      expected: { action: "propose_phase1_skeleton", requireSourceRead: true, requireWorktree: false },
      fixture: { sourceRepoState: "chat-local-readable", treeState: "empty" },
    });
    expect(chatSource?.forbidden.actions).toContain("require_github_app");

    const continuation = FIRST_TREE_SEED_GATE_CASES.find((evalCase) => evalCase.id === "same-chat-phase2-continuation");
    expect(continuation).toMatchObject({
      expected: { action: "continue_phase2", requireSourceRead: true, requireWorktree: true },
      fixture: { sourceRepoState: "bare-readable", treeState: "phase1-approved" },
    });
    expect(continuation?.forbidden.actions).toContain("refuse_nonempty_tree");
  });
});
