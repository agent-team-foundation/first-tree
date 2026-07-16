import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { ContextTreeReviewEvalCase, ReviewFixtureExpectation, ReviewFixtureIntegrity } from "./types.js";

export type ReviewFixture = {
  expectation: ReviewFixtureExpectation;
  fixturePath: string;
  originPath: string;
  originRefs: string;
  reviewWorktreePath: string;
  treeConfig: string;
  treePath: string;
  treeRefs: string;
  treeWorktrees: string;
  verifyResultPath: string;
};

function node(title: string, body: string, owners = "[eval-owner]"): string {
  return `---\ntitle: "${title}"\nowners: ${owners}\n---\n\n# ${title}\n\n${body}\n`;
}

const DEFAULT_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-seed",
  "first-tree-file-bug",
  "first-tree-read",
  "first-tree-write",
  "context-tree-review",
  "context-tree-audit",
  "first-tree-qa",
] as const;

function workspaceAgents(skills: readonly { description: string; name: string }[]): string {
  const rows = skills.map((skill) => `| \`${skill.name}\` | ${skill.description} |`).join("\n");
  return `# Eval Workspace Instructions\n\n## Available Skills\n\n| Skill | Load when |\n|---|---|\n${rows}\n\nA Cloud Context Reviewer wake-up or an explicit Context Tree PR review loads \`context-tree-review\` exclusively. Do not load \`first-tree-read\` first; the review skill owns detached PR-head discovery, validation, and semantic reads. Load \`.agents/skills/context-tree-review/SKILL.md\` before reviewing the Context Tree PR.\n\n## Context Tree Policy\n\nThe Context Tree stores durable current decisions, constraints, ownership, and cross-domain relationships with surviving rationale. Source repositories store implementation details and delivery history. Normal content is canonical current truth; archive/supporting content is evidence only; member content routes ownership. Normal nodes must remain self-contained without archive material. Apply What / Why / Who, edit rather than duplicate, and require explicit human authority for ownership changes and \`decisionLocksCode\`. Do not put source mirrors, PR provenance, implementation detail, or actionable future work in normal nodes.\n\nThe bound Context Tree is \`./context-tree\`. Review is read-only.\n`;
}

function changedBody(scenario: ContextTreeReviewEvalCase["fixture"]["scenario"]): { path: string; content: string } {
  if (scenario === "archive-only") {
    return {
      path: "raw-context/proposal.md",
      content: node("Archived Proposal", "Exploratory notes retained only as supporting evidence."),
    };
  }
  if (scenario === "validator-failure") {
    return {
      path: "system/review-contract.md",
      content: `---\ntitle: "Review Contract"\nowners: []\n---\n\n# Review Contract\n\n## Decision\n\nReview outcomes are head-bound.\n`,
    };
  }
  if (scenario === "semantic-failure") {
    return {
      path: "system/review-contract.md",
      content: node(
        "Review Contract",
        "## Decision\n\nThe implementation calls `reviewPullRequest()` from `reviewer.ts` and sends `POST /reviews`.\n\n## Constraints\n\nShipped in PR #42. Copy future source changes here.",
      ),
    };
  }
  if (scenario === "authority") {
    return {
      path: "system/review-contract.md",
      content: `---\ntitle: "Review Contract"\nowners: [new-owner]\ndecisionLocksCode: true\n---\n\n# Review Contract\n\n## Decision\n\nThe tree overrides source behavior for review outcomes.\n\n## Rationale\n\nThe pull request does not include a human ownership or authority decision.\n`,
    };
  }
  return {
    path: "system/review-contract.md",
    content: node(
      "Review Contract",
      "## Decision\n\nContext Tree pull request reviews are bound to the current head and produce one explicit verdict.\n\n## Rationale\n\nA single head-bound verdict prevents stale approvals and gives owners one auditable semantic outcome.\n\n## Constraints\n\nReviewers do not edit or merge the proposed tree change.",
    ),
  };
}

export function setupFixture(evalCase: ContextTreeReviewEvalCase, paths: RunPaths): ReviewFixture {
  const installedSkills = DEFAULT_SKILL_NAMES.map((name) => ({
    description: parseSkillDescription(installRepoSkill(paths.repoRoot, paths.workspacePath, name)),
    name,
  }));
  writeText(join(paths.workspacePath, "AGENTS.md"), workspaceAgents(installedSkills));
  writeText(
    join(paths.workspacePath, ".first-tree", "workspace.json"),
    `${JSON.stringify({ tree: "context-tree" }, null, 2)}\n`,
  );

  const treePath = join(paths.workspacePath, "context-tree");
  mkdirSync(treePath, { recursive: true });
  writeText(join(treePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(treePath, ".first-tree", "tree.json"),
    `${JSON.stringify({ schemaVersion: 1, treeId: "review-eval", treeMode: "dedicated", treeRepoName: "context-tree" }, null, 2)}\n`,
  );
  writeText(
    join(treePath, "NODE.md"),
    node("Review Eval Tree", "## Decision\n\nThis tree provides deterministic review fixtures."),
  );
  writeText(
    join(treePath, "system", "NODE.md"),
    node("System", "## Decision\n\nSystem review decisions live in this domain."),
  );
  writeText(join(treePath, "members", "NODE.md"), node("Members", "Ownership routing for the eval tree."));
  writeText(
    join(treePath, "members", "eval-owner", "NODE.md"),
    `---\ntitle: "eval-owner"\nowners: [eval-owner]\ntype: human\nrole: "Evaluation owner"\ndomains: [system]\n---\n\n# eval-owner\n\nOwns the eval fixture.\n`,
  );

  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "eval@example.invalid"],
    ["config", "user.name", "First Tree Eval"],
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "-m", "chore: seed review fixture"],
  ])
    assertCommandOk(runCommand("git", args, treePath));
  const baseOid = runCommand("git", ["rev-parse", "HEAD"], treePath).stdout.trim();
  const originPath = join(paths.runRoot, "context-tree-origin.git");
  assertCommandOk(runCommand("git", ["init", "--bare", originPath], paths.runRoot));
  assertCommandOk(runCommand("git", ["remote", "add", "origin", originPath], treePath));
  assertCommandOk(runCommand("git", ["push", "-u", "origin", "main"], treePath));
  assertCommandOk(runCommand("git", ["switch", "-c", "review-change"], treePath));
  const changed = changedBody(evalCase.fixture.scenario);
  writeText(join(treePath, changed.path), changed.content);
  assertCommandOk(runCommand("git", ["add", "."], treePath));
  assertCommandOk(runCommand("git", ["commit", "-m", "docs: update review contract"], treePath));
  const headOid = runCommand("git", ["rev-parse", "HEAD"], treePath).stdout.trim();
  const verifyRunnerPath = join(paths.runRoot, "run-source-verify.ts");
  const verifyModulePath = join(paths.repoRoot, "apps", "cli", "src", "commands", "tree", "verify.ts");
  writeText(
    verifyRunnerPath,
    `import { verifyTreeRoot } from ${JSON.stringify(verifyModulePath)};\nconst summary = verifyTreeRoot(process.cwd());\nprocess.stdout.write(JSON.stringify(summary) + "\\n");\nprocess.exit(summary.ok ? 0 : 1);\n`,
  );
  const verifyResult = runCommand(join(paths.packageRoot, "node_modules", ".bin", "tsx"), [verifyRunnerPath], treePath);
  const verifyResultPath = join(paths.workspacePath, ".first-tree-eval", "source-verify-result.json");
  writeText(
    verifyResultPath,
    `${JSON.stringify({ exitCode: verifyResult.exitCode, stderr: verifyResult.stderr, stdout: verifyResult.stdout }, null, 2)}\n`,
  );
  assertCommandOk(runCommand("git", ["push", "origin", `HEAD:refs/pull/42/head`], treePath));
  assertCommandOk(runCommand("git", ["switch", "main"], treePath));

  const view = {
    author: { login: "contributor" },
    baseRefName: "main",
    baseRefOid: baseOid,
    body: "Update the durable review contract.",
    files: [{ path: changed.path }],
    headRefName: "review-change",
    headRefOid: headOid,
    isDraft: evalCase.fixture.scenario === "draft",
    number: 42,
    state: "OPEN",
    title: "Update review contract",
    url: "https://github.com/owner/context-tree/pull/42",
  };
  const secondView = evalCase.fixture.scenario === "stale-head" ? { ...view, headRefOid: baseOid } : view;
  const submissionHeadOid = evalCase.fixture.scenario === "submission-race" ? baseOid : secondView.headRefOid;
  const reviewerLogin = "read-only-reviewer";
  const runId = "01900000-0000-7000-8000-000000000042";
  const fixturePath = join(paths.workspacePath, ".first-tree-eval", "gh-review-fixture.json");
  const repo = "owner/context-tree";
  const prNumber = 42;
  const reviewWorktreePath = join(paths.workspacePath, ".review-worktrees", "42");
  writeText(
    fixturePath,
    `${JSON.stringify({ prNumber, repo, reviewHeadOid: headOid, reviewerLogin, reviewWorktreePath, runId, submissionHeadOid, views: [view, secondView] }, null, 2)}\n`,
  );
  const originRefs = runCommand("git", ["for-each-ref", "--format=%(refname):%(objectname)"], originPath).stdout;
  const treeConfig = runCommand("git", ["config", "--local", "--list"], treePath).stdout;
  const treeRefs = runCommand("git", ["for-each-ref", "--format=%(refname):%(objectname)"], treePath).stdout;
  const treeWorktrees = runCommand("git", ["worktree", "list", "--porcelain"], treePath).stdout;
  return {
    expectation: {
      baseOid,
      expectedFinalDraft: view.isDraft,
      expectedFinalHeadOid: secondView.headRefOid,
      expectedFinalState: "OPEN",
      governedPaths: evalCase.fixture.scenario === "archive-only" ? [] : [changed.path],
      headOid,
      prNumber,
      repo,
      runId,
      submissionHeadOid,
      workspacePath: paths.workspacePath,
    },
    fixturePath,
    originPath,
    originRefs,
    reviewWorktreePath,
    treeConfig,
    treePath,
    treeRefs,
    treeWorktrees,
    verifyResultPath,
  };
}

export function inspectFixtureIntegrity(fixture: ReviewFixture): ReviewFixtureIntegrity {
  const worktrees = runCommand("git", ["worktree", "list", "--porcelain"], fixture.treePath).stdout;
  return {
    mainHeadUnchanged:
      runCommand("git", ["rev-parse", "HEAD"], fixture.treePath).stdout.trim() === fixture.expectation.baseOid,
    mainWorktreeClean: runCommand("git", ["status", "--porcelain"], fixture.treePath).stdout.trim() === "",
    originRefsUnchanged:
      runCommand("git", ["for-each-ref", "--format=%(refname):%(objectname)"], fixture.originPath).stdout ===
      fixture.originRefs,
    reviewWorktreeCleaned: !existsSync(fixture.reviewWorktreePath) && !worktrees.includes(fixture.reviewWorktreePath),
    treeConfigUnchanged:
      runCommand("git", ["config", "--local", "--list"], fixture.treePath).stdout === fixture.treeConfig,
    treeRefsUnchanged:
      runCommand("git", ["for-each-ref", "--format=%(refname):%(objectname)"], fixture.treePath).stdout ===
      fixture.treeRefs,
    treeWorktreesUnchanged: worktrees === fixture.treeWorktrees,
  };
}

export function skillHasPolicyDuplication(repoRoot: string): boolean {
  const text = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");
  return /Double Test|What\s*\/\s*Why\s*\/\s*Who|Source-System Boundary|Node Shape/iu.test(text);
}
