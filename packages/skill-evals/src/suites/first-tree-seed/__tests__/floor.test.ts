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
const durableProgressMarkdown = readFileSync(
  join(process.cwd(), "../../skills/first-tree-seed/references/durable-progress.md"),
  "utf8",
);
const skillVersion = readFileSync(join(process.cwd(), "../../skills/first-tree-seed/VERSION"), "utf8").trim();
const openAiMetadata = readFileSync(join(process.cwd(), "../../skills/first-tree-seed/agents/openai.yaml"), "utf8");

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

  it("supports explicit GitHub and GitLab tree provisioning", () => {
    expect(skillMarkdown).toContain("Use `gh` for GitHub and `glab` for GitLab");
    expect(skillMarkdown).toMatch(/Preserve the full GitLab\s+namespace/);
    expect(skillMarkdown).toContain('--provider "<github|gitlab>" --repo "<exact-repository-url>"');
    expect(skillMarkdown).toContain("--create --dir");
    expect(skillMarkdown).toContain("Use `--adopt` instead of `--create`");
    expect(skillMarkdown).toContain("Never\ncreate or simulate an approval rule");
    expect(skillMarkdown).toContain("exact-SHA merge");
    expect(skillMarkdown).toContain("Never substitute a GitHub App URL");
    expect(skillMarkdown).toContain("Provider-aware `tree init` always requires `--team`");
    const initCommands = [...skillMarkdown.matchAll(/^first-tree tree init .+$/gmu)].map((match) => match[0]);
    expect(initCommands.length).toBeGreaterThan(0);
    expect(initCommands.every((command) => command.includes("--team"))).toBe(true);
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

  it("checks durable fresh-process Phase 2 recovery before refusing state C", () => {
    const continuation = skillMarkdown.indexOf("Check durable Phase 2 recovery before classifying state C");
    const stateC = skillMarkdown.indexOf("**C — Already seeded.**");

    expect(continuation).toBeGreaterThan(-1);
    expect(stateC).toBeGreaterThan(continuation);
    expect(skillMarkdown).toContain("including from a new process, agent, or chat");
    expect(skillMarkdown).toContain("The old Chat transcript and private local cache are");
    expect(skillMarkdown).toContain("first-tree-seed-progress:v1");
    expect(skillMarkdown).toContain("first-tree tree seed --team");
    expect(durableProgressMarkdown).toContain("setup-chat history and private local caches");
    expect(durableProgressMarkdown).toContain("git cat-file -e <commit>^{commit}");
    expect(durableProgressMarkdown).toContain("Do not write an unchecked Phase 2 item");
    expect(durableProgressMarkdown).toContain("binding change");
  });

  it("publishes the portable Seed skill as version 0.5.1", () => {
    expect(skillVersion).toBe("0.5.1");
    expect(skillMarkdown).toContain("version: 0.5.1");
    expect(skillMarkdown).toContain('first-tree: ">=0.5.16 <0.6.0"');
    expect(openAiMetadata).toContain("$first-tree-seed");
    expect(openAiMetadata).toContain("merged durable progress");
    expect(openAiMetadata).not.toContain("in this chat");
  });

  it("configures PR-only GitHub branch rules after creating a GitHub Context Repo", () => {
    expect(skillMarkdown).toContain("only after `tree init` succeeds");
    expect(skillMarkdown).toMatch(/only when the\s+new Context Repo is a GitHub repository/);
    expect(skillMarkdown).toContain("Do not run it for an already-bound tree");
    expect(skillMarkdown).toContain("GitHub owns the repository merge gate here");
    expect(skillMarkdown).toMatch(/current diff requires at\s+least one approval/);
    expect(skillMarkdown).toMatch(/do not bind it to a\s+specific GitHub App or Code Owner/);
    expect(skillMarkdown).toContain("do not create a root `CODEOWNERS`");
    expect(skillMarkdown).toMatch(
      /Keep this rule independent of the\s+organization's current Context\s+Review workflow/,
    );
    expect(skillMarkdown).toContain("includes_parents=false&per_page=100");
    expect(skillMarkdown).toContain('(.source_type == null or .source_type == "Repository")');
    expect(skillMarkdown).toContain("Do not\nlook up inherited organization rulesets");
    expect(skillMarkdown).toContain("do not use a pipeline such as\n`gh api ... | head`");
    expect(skillMarkdown).toContain('"include": ["~DEFAULT_BRANCH"]');
    expect(skillMarkdown).toContain('"type": "non_fast_forward"');
    expect(skillMarkdown).toContain('"type": "pull_request"');
    expect(skillMarkdown).toContain('"required_approving_review_count": 1');
    expect(skillMarkdown).toContain('"require_code_owner_review": false');
    expect(skillMarkdown).toContain('"dismiss_stale_reviews_on_push": true');
    expect(skillMarkdown).toContain('"require_last_push_approval": false');
    expect(skillMarkdown).toContain('"required_review_thread_resolution": false');
    expect(skillMarkdown).toContain("single GitHub user cannot self-merge while the App\nReviewer is unavailable");
    expect(skillMarkdown).toContain("Do not compensate by broadening App permissions");
    expect(skillMarkdown).toMatch(/automatic GitHub branch-rule\s+setup failed/);
    expect(skillMarkdown).toMatch(
      /require pull requests, require at least one\s+current approval, dismiss stale approvals on push/,
    );
    expect(skillMarkdown).toContain("newly created GitHub Context Repo (validate workflows, CODEOWNERS ownership,");
    expect(skillMarkdown).not.toContain('"require_code_owner_review": true');
    expect(skillMarkdown).not.toMatch(/must not[^.]*require a GitHub approving review/i);
    expect(skillMarkdown).not.toContain('"required_approving_review_count": 0');
    expect(skillMarkdown).not.toContain("printf '* %s\\n' \"$code_owner_ref\"");
    expect(skillMarkdown).not.toContain("contents/.github/CODEOWNERS");
    expect(skillMarkdown).not.toContain("codeowners/errors");
  });

  it("delays App coverage guidance until a reviewable milestone", () => {
    expect(skillMarkdown).toContain("After the Phase 1 PR/MR is open");
    expect(skillMarkdown).toMatch(/do\s+not interrupt source resolution,\s+structure/u);
    expect(skillMarkdown).toMatch(/collect any uncovered\s+tree-repo recovery returned/u);
  });

  it("hands off Review Agent configuration to Setup without blocking Seed", () => {
    expect(skillMarkdown).toContain("After the Phase 1 PR/MR is open, check Review Agent configuration once");
    expect(skillMarkdown).toContain('first-tree org context-tree review-config --as-member --org "<team-id>" --json');
    expect(skillMarkdown).toMatch(/Review Agent selection through \*\*Settings →\s+Setup\*\*/u);
    expect(skillMarkdown).toMatch(/Setup owns\s+provider prerequisites and the Team mutation/u);
    expect(skillMarkdown).toContain("It is not a health or\n  readiness check");
    expect(skillMarkdown).toContain("first perform the Review Agent read");
    expect(skillMarkdown).toContain("send at most one combined setup handoff");
    expect(skillMarkdown).toMatch(/supersedes\s+the generated briefing's generic GitHub-follow setup prompt/u);
    expect(skillMarkdown).toContain("If only one is missing, mention\n  only that action");
    expect(skillMarkdown).toContain("creates no inferred debt and does not block Seed");
    expect(skillMarkdown).toContain("optional for Team, Chat, basic Tree use and Seed\n  completion");
    expect(skillMarkdown).toContain("only when this run verified that ruleset setup succeeded");
    expect(skillMarkdown).toContain("report the governance actually observed");
    expect(skillMarkdown).toContain("Do not repeat the Review Agent\nhandoff from Phase 1");

    const handoffRows = [
      "| GitHub coverage missing | Off | One combined handoff: authoritative coverage recovery plus Review Agent in Settings → Setup |",
      "| GitHub coverage missing | Configured or read failed/ambiguous | Coverage recovery only; infer no Review debt |",
      "| GitHub covered | Off | Review Agent in Settings → Setup only |",
      "| GitHub covered | Configured or read failed/ambiguous | No setup handoff |",
      "| GitLab | Off | Review Agent in Settings → Setup only; no GitHub App guidance |",
      "| GitLab | Configured or read failed/ambiguous | No setup handoff |",
    ];
    for (const row of handoffRows) {
      expect(skillMarkdown).toContain(row);
    }
  });

  it("follows GitLab tree MRs without inventing GitHub setup", () => {
    expect(skillMarkdown).toContain("first-tree gitlab follow <mr-url>");
    expect(skillMarkdown).toContain("created or an existing\ndeterministic MR is resolved/reused");
    expect(skillMarkdown).toContain("creating or resolving/reusing the task's GitLab MR");
    expect(skillMarkdown).toContain("returned pending or active state is success");
    expect(skillMarkdown).toContain("only pending waits\nfor a matching valid webhook");
    expect(skillMarkdown).toContain("failure does not invalidate the MR");
    expect(skillMarkdown).toContain("no GitHub App coverage guidance applies");
    expect(skillMarkdown).toContain("Never substitute a GitHub App URL");
    expect(skillMarkdown).toContain("Use **Settings → Setup** only for an actual Team capability");
  });

  it("discovers GitLab CI as a Tier 0 operations signal", () => {
    expect(skillMarkdown).toContain("`.gitlab-ci.yml`");
    expect(skillMarkdown).toContain("`.gitlab/`");
  });

  it("ships behavioral gates for managed sources and portable durable recovery", () => {
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

    const continuation = FIRST_TREE_SEED_GATE_CASES.find(
      (evalCase) => evalCase.id === "durable-phase2-new-process-continuation",
    );
    expect(continuation).toMatchObject({
      expected: { action: "continue_phase2", requireSourceRead: true, requireWorktree: true },
      fixture: {
        invocationMode: "portable",
        progressState: "matching-phase1",
        seedAuthority: "admin",
        sourceRepoState: "bare-readable",
        treeState: "phase1-approved",
      },
    });
    expect(continuation?.forbidden.actions).toContain("refuse_nonempty_tree");

    expect(
      FIRST_TREE_SEED_GATE_CASES.find((evalCase) => evalCase.id === "portable-ordinary-member-needs-admin"),
    ).toMatchObject({
      expected: { action: "report_needs_admin", requireSourceRead: false, requireWorktree: false },
      fixture: { invocationMode: "portable", seedAuthority: "member", treeState: "empty" },
    });
    for (const id of [
      "phase1-shaped-tree-without-durable-progress-refuses",
      "durable-phase2-source-identity-mismatch-refuses",
      "durable-phase2-unreadable-source-commit-refuses",
      "durable-phase2-binding-mismatch-refuses",
    ]) {
      expect(FIRST_TREE_SEED_GATE_CASES.some((evalCase) => evalCase.id === id)).toBe(true);
    }
  });
});
