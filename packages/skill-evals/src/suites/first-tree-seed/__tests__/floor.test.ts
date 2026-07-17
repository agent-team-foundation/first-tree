import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
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

  it("ships valid YAML frontmatter", () => {
    const frontmatter = skillMarkdown.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
    const parsed = parseDocument(frontmatter);

    expect(parsed.errors).toEqual([]);
    expect(parsed.get("description")).toContain("yet: either no tree exists");
  });

  it("supports GitLab sources without inventing GitLab tree provisioning", () => {
    expect(skillMarkdown).toContain("Use `gh` for GitHub and `glab` for GitLab");
    expect(skillMarkdown).toMatch(/Preserve the full GitLab\s+namespace/);
    expect(skillMarkdown).toMatch(/current\s+`first-tree tree init` provisioning is GitHub-only/);
    expect(skillMarkdown).toContain("do not substitute `glab` for this command");
    expect(skillMarkdown).toContain("Never substitute `/settings/github`");
  });

  it("materializes declared source worktrees from the resolved source ref, not origin/main", () => {
    expect(skillMarkdown).toContain("declared/pinned ref when one exists");
    expect(skillMarkdown).toContain('remote_ref="refs/remotes/origin/$source_ref"');
    expect(skillMarkdown).toContain("refs/remotes/origin/HEAD");
    expect(skillMarkdown).toContain("Do not hard-code `origin/main`");
    expect(skillMarkdown).toContain("Do not pass a branch-like declared");

    const sourceWorktreeSection =
      skillMarkdown.match(/### Materialize source read worktrees[\s\S]*?## The Two Phases/u)?.[0] ?? "";
    expect(sourceWorktreeSection).not.toContain("worktree add <workspaceRoot>/worktrees/seed-<source> origin/main");
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

  it("configures PR-only GitHub branch rules after creating a GitHub Context Repo", () => {
    expect(skillMarkdown).toContain("only after `tree init` succeeds");
    expect(skillMarkdown).toMatch(/only when the\s+new Context Repo is a GitHub repository/);
    expect(skillMarkdown).toContain("Do not run it for an already-bound tree");
    expect(skillMarkdown).toContain("GitHub owns only the repository-shape guard here");
    expect(skillMarkdown).toMatch(/Context Review owns\s+the review verdict/);
    expect(skillMarkdown).toContain("must not create a root `CODEOWNERS` mapping");
    expect(skillMarkdown).toMatch(/Keep this rule independent of the\s+organization's current Context Review workflow/);
    expect(skillMarkdown).toContain("includes_parents=false&per_page=100");
    expect(skillMarkdown).toContain('(.source_type == null or .source_type == "Repository")');
    expect(skillMarkdown).toContain("Do not\nlook up inherited organization rulesets");
    expect(skillMarkdown).toContain("do not use a pipeline such as\n`gh api ... | head`");
    expect(skillMarkdown).toContain('"include": ["~DEFAULT_BRANCH"]');
    expect(skillMarkdown).toContain('"type": "non_fast_forward"');
    expect(skillMarkdown).toContain('"type": "pull_request"');
    expect(skillMarkdown).toContain('"required_approving_review_count": 0');
    expect(skillMarkdown).toContain('"require_code_owner_review": false');
    expect(skillMarkdown).toContain('"dismiss_stale_reviews_on_push": false');
    expect(skillMarkdown).toContain('"require_last_push_approval": false');
    expect(skillMarkdown).toContain('"required_review_thread_resolution": false');
    expect(skillMarkdown).toMatch(/automatic GitHub branch-rule\s+setup failed/);
    expect(skillMarkdown).toMatch(
      /require pull requests, block force pushes, and\s+require zero approving or Code Owner reviews/,
    );
    expect(skillMarkdown).toContain("newly created GitHub Context Repo (validate workflows, CODEOWNERS ownership,");
    expect(skillMarkdown).not.toContain('"required_approving_review_count": 1');
    expect(skillMarkdown).not.toContain('"require_code_owner_review": true');
    expect(skillMarkdown).not.toContain("printf '* %s\\n' \"$code_owner_ref\"");
    expect(skillMarkdown).not.toContain("contents/.github/CODEOWNERS");
    expect(skillMarkdown).not.toContain("codeowners/errors");
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

    const gitlabNonMain = FIRST_TREE_SEED_GATE_CASES.find(
      (evalCase) => evalCase.id === "gitlab-non-main-source-worktree-protocol",
    );
    expect(gitlabNonMain).toMatchObject({
      expected: { action: "materialize_bare_worktree", requireSourceRead: true, requireWorktree: true },
      fixture: {
        sourceDeclaredRef: "trunk",
        sourceDefaultBranch: "trunk",
        sourceForge: "gitlab",
        sourceLocalBranchState: "stale",
        sourceRepoState: "bare-readable",
      },
    });

    const continuation = FIRST_TREE_SEED_GATE_CASES.find((evalCase) => evalCase.id === "same-chat-phase2-continuation");
    expect(continuation).toMatchObject({
      expected: { action: "continue_phase2", requireSourceRead: true, requireWorktree: true },
      fixture: { sourceRepoState: "bare-readable", treeState: "phase1-approved" },
    });
    expect(continuation?.forbidden.actions).toContain("refuse_nonempty_tree");
  });
});
