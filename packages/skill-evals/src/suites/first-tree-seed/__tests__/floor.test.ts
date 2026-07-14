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
    expect(skillMarkdown).toMatch(/local\s+project folder or GitHub\/GitLab repository URL/);
    expect(skillMarkdown).toContain("Do not send them to Settings");
    expect(skillMarkdown).toMatch(/rather\s+than asking for the First\s+Tree GitHub App/);
  });

  it("supports GitLab sources without inventing GitLab tree provisioning", () => {
    expect(skillMarkdown).toContain("Use `gh` for GitHub and `glab` for GitLab");
    expect(skillMarkdown).toMatch(/Preserve the full GitLab\s+namespace/);
    expect(skillMarkdown).toMatch(/current\s+`first-tree tree init` provisioning is GitHub-only/);
    expect(skillMarkdown).toContain("do not substitute `glab` for this command");
    expect(skillMarkdown).toContain("Never substitute `/settings/github`");
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

  it("configures GitHub governance only after creating a GitHub Context Repo", () => {
    expect(skillMarkdown).toContain("only after `tree init` succeeds");
    expect(skillMarkdown).toMatch(/only when the\s+new Context Repo is a GitHub repository/);
    expect(skillMarkdown).toContain("Do not run it for an already-bound tree");
    expect(skillMarkdown).toContain("First make the Code Owner gate real and satisfiable");
    expect(skillMarkdown).toContain('repo_owner_type=$(gh api "repos/$repo" --jq .owner.type)');
    expect(skillMarkdown).toContain("pr_author_login=$(gh api user --jq .login)");
    expect(skillMarkdown).toContain('if [ "$repo_owner_type" = "Organization" ]; then');
    expect(skillMarkdown).toContain("repos/$repo/teams?per_page=100");
    expect(skillMarkdown).toContain('.privacy != "secret"');
    expect(skillMarkdown).toContain("orgs/$repo_owner/teams/$candidate_team_slug/members?per_page=100");
    expect(skillMarkdown).toContain("non_author_member");
    expect(skillMarkdown).toContain(".login != $author");
    expect(skillMarkdown).toContain("Personal repositories\nskip the teams lookup");
    expect(skillMarkdown).toContain("Do **not** make the\nactive `gh` user the only Code Owner");
    expect(skillMarkdown).toContain('printf \'* %s\\n\' "$code_owner_ref" > "<tree>/.github/CODEOWNERS"');
    expect(skillMarkdown).toContain('git -C "<tree>" push origin "HEAD:$default_branch"');
    expect(skillMarkdown).toContain("contents/.github/CODEOWNERS?ref=$default_branch");
    expect(skillMarkdown).toContain("codeowners/errors?ref=$default_branch");
    expect(skillMarkdown).toContain("covers every path (`*`)");
    expect(skillMarkdown).toContain("do not\nenable `require_code_owner_review`, do not `POST` or `PUT` the ruleset");
    expect(skillMarkdown).toContain("includes_parents=false&per_page=100");
    expect(skillMarkdown).toContain('(.source_type == null or .source_type == "Repository")');
    expect(skillMarkdown).toContain("Do not\nlook up inherited organization rulesets");
    expect(skillMarkdown).toContain("do not use a pipeline such as\n`gh api ... | head`");
    expect(skillMarkdown).toContain('"include": ["~DEFAULT_BRANCH"]');
    expect(skillMarkdown).toContain('"type": "non_fast_forward"');
    expect(skillMarkdown).toContain('"type": "pull_request"');
    expect(skillMarkdown).toContain('"required_approving_review_count": 1');
    expect(skillMarkdown).toContain('"require_code_owner_review": true');
    expect(skillMarkdown).toContain('"dismiss_stale_reviews_on_push": false');
    expect(skillMarkdown).toContain('"require_last_push_approval": false');
    expect(skillMarkdown).toContain('"required_review_thread_resolution": false');
    expect(skillMarkdown).toMatch(/automatic GitHub governance\s+setup failed/);
    expect(skillMarkdown).toContain("root `CODEOWNERS` mapping and branch rules");
    expect(skillMarkdown).toContain("bootstrap root `CODEOWNERS` mapping and\n  default-branch ruleset");
    expect(skillMarkdown).not.toMatch(/rulesets,\s+CODEOWNERS\) — out of scope/);
  });

  it("delays App coverage guidance until a reviewable milestone", () => {
    expect(skillMarkdown).toContain("After the Phase 1 PR/MR is open");
    expect(skillMarkdown).toMatch(/do not interrupt source resolution,\s+structure/);
    expect(skillMarkdown).toMatch(/Relay only a recovery URL returned/);
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
