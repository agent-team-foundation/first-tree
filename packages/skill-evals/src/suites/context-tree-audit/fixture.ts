import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { AuditFixtureExpectation, AuditFixtureState, ContextTreeAuditEvalCase } from "./types.js";

export type AuditFixture = {
  auditFixturePath: string;
  expectation: AuditFixtureExpectation;
  expectedOriginMainOid: string | null;
  initialMainOid: string | null;
  initialAuditStatePaths: readonly string[];
  initialLocalBranches: readonly string[];
  initialWorktreePaths: readonly string[];
  originPath: string | null;
  treePath: string | null;
  verifyResultPath: string | null;
};

function auditStatePaths(workspacePath: string): readonly string[] {
  const found: string[] = [];
  function isBareRepository(path: string): boolean {
    return (
      existsSync(join(path, "HEAD")) &&
      existsSync(join(path, "objects")) &&
      existsSync(join(path, "refs")) &&
      lstatSync(join(path, "objects")).isDirectory() &&
      lstatSync(join(path, "refs")).isDirectory()
    );
  }
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const rel = relative(workspacePath, child);
      if ([".agents", ".claude", ".first-tree-eval"].includes(entry.name)) continue;
      const stat = lstatSync(child);
      if (entry.name === "context-tree" || entry.name === ".audit-worktrees") {
        found.push(rel);
      }
      if (
        entry.name === ".git" ||
        entry.name === "NODE.md" ||
        rel.endsWith("/.first-tree/VERSION") ||
        rel.endsWith("/.first-tree/tree.json")
      ) {
        found.push(rel);
      }
      if (stat.isDirectory() && isBareRepository(child)) found.push(`${rel}/[bare-git-repository]`);
      if (stat.isDirectory()) walk(child);
    }
  }
  walk(workspacePath);
  return [...new Set(found)].sort();
}

function expectedFinding(
  scenario: ContextTreeAuditEvalCase["fixture"]["scenario"],
): AuditFixtureExpectation["expectedFinding"] {
  if (scenario === "mechanical") {
    return {
      claimTokens: ["title"],
      evidenceTokens: ["title"],
      policyTokens: ["node", "shape"],
    };
  }
  if (scenario === "weak-cross-domain") {
    return {
      claimTokens: ["30", "90"],
      evidenceTokens: ["retention-policy.md", "30", "90"],
      policyTokens: ["canonical"],
    };
  }
  if (scenario === "decision-lock") {
    return {
      claimTokens: ["30", "90"],
      evidenceTokens: ["decisionlockscode", "audit-retention.txt", "90"],
      policyTokens: ["code", "tree", "drift"],
    };
  }
  if (["report-only", "stale-before-publish", "stale-before-write", "strong-local"].includes(scenario)) {
    return {
      claimTokens: ["retention", "30"],
      evidenceTokens: ["audit-retention.txt", "90"],
      policyTokens: ["code", "tree", "drift"],
    };
  }
  return null;
}

const DEFAULT_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-seed",
  "first-tree-file-bug",
  "first-tree-read",
  "first-tree-write",
  "context-tree-review",
  "context-tree-audit",
] as const;

function node(title: string, body: string, extraFrontmatter = ""): string {
  return `---\ntitle: "${title}"\nowners: [eval-owner]\n${extraFrontmatter}---\n\n# ${title}\n\n${body}\n`;
}

function workspaceAgents(skills: readonly { description: string; name: string }[], bound: boolean): string {
  const rows = skills.map((skill) => `| \`${skill.name}\` | ${skill.description} |`).join("\n");
  return `# Eval Workspace Instructions

## Available Skills

| Skill | Load when |
|---|---|
${rows}

An explicit broad audit of stored normal content loads \`context-tree-audit\` exclusively. Do not run \`first-tree-read\` first. Every evidence-backed tree edit is handed to \`first-tree-write\`; resulting pull requests are reviewed by \`context-tree-review\` and are never self-approved or merged by Audit.

## Context Tree Policy

The Context Tree stores durable current decisions, constraints, ownership, and cross-domain relationships with surviving rationale. Generated policy is the only content-policy baseline. Normal content is canonical current truth. Apply the decision and durability tests, edit rather than duplicate, keep implementation detail and delivery history in source systems, and require explicit human authority for ownership or \`decisionLocksCode\` conflicts. Code is the default drift authority unless a node explicitly locks code.

${bound ? "The bound Context Tree checkout is `./context-tree`; its current source evidence repository is `./source-repo`." : "No Context Tree is bound in this fixture. Do not guess or create one."}
`;
}

function auditNode(evalCase: ContextTreeAuditEvalCase): string {
  if (evalCase.fixture.scenario === "mechanical") {
    return `---\nowners: [eval-owner]\n---\n\n# Audit Contract\n\n## Decision\n\nStored audits use exact default-branch evidence.\n`;
  }
  if (evalCase.fixture.scenario === "decision-lock") {
    return node(
      "Audit Contract",
      "## Decision\n\nAudit evidence retention is 30 days.\n\n## Rationale\n\nThe locked decision constrains source behavior until an owner changes it.",
      "decisionLocksCode: true\n",
    );
  }
  if (evalCase.fixture.scenario === "weak-cross-domain") {
    return node(
      "Audit Contract",
      "## Decision\n\nAudit evidence retention is 30 days.\n\n## Rationale\n\nThis node and a sibling disagree, but no current source or human decision identifies the canonical value.",
    );
  }
  return node(
    "Audit Contract",
    "## Decision\n\nAudit evidence retention is 30 days.\n\n## Rationale\n\nThe current source configuration is the default drift authority for this unlocked operational claim.",
  );
}

function setupSourceRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  writeText(join(path, "config", "audit-retention.txt"), "audit_retention_days=90\n");
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "eval@example.invalid"],
    ["config", "user.name", "First Tree Eval"],
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "-m", "chore: seed source evidence"],
  ]) {
    assertCommandOk(runCommand("git", args, path));
  }
}

function recordVerification(paths: RunPaths, treePath: string): string {
  const verifyRunnerPath = join(paths.workspacePath, ".first-tree-eval", "source-verify.ts");
  const verifyModulePath = join(paths.repoRoot, "apps", "cli", "src", "commands", "tree", "verify.ts");
  writeText(
    verifyRunnerPath,
    `import { verifyTreeRoot } from ${JSON.stringify(verifyModulePath)};\nconst summary = verifyTreeRoot(process.cwd());\nprocess.stdout.write(JSON.stringify(summary) + "\\n");\nprocess.exit(summary.ok ? 0 : 1);\n`,
  );
  const result = runCommand(join(paths.packageRoot, "node_modules", ".bin", "tsx"), [verifyRunnerPath], treePath);
  const resultPath = join(paths.workspacePath, ".first-tree-eval", "source-verify-result.json");
  writeText(
    resultPath,
    `${JSON.stringify({ exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }, null, 2)}\n`,
  );
  return resultPath;
}

export function setupFixture(evalCase: ContextTreeAuditEvalCase, paths: RunPaths): AuditFixture {
  const installedSkills = DEFAULT_SKILL_NAMES.map((name) => ({
    description: parseSkillDescription(installRepoSkill(paths.repoRoot, paths.workspacePath, name)),
    name,
  }));
  const bound = evalCase.fixture.scenario !== "no-binding";
  writeText(join(paths.workspacePath, "AGENTS.md"), workspaceAgents(installedSkills, bound));
  writeText(
    join(paths.workspacePath, ".first-tree", "workspace.json"),
    `${JSON.stringify(bound ? { sources: [{ path: "source-repo" }], tree: "context-tree" } : { sources: [] }, null, 2)}\n`,
  );

  const repo = "owner/context-tree";
  const scope = "system/audit-contract.md";
  const auditWorktreePath = bound ? join(paths.workspacePath, ".audit-worktrees", evalCase.id) : null;
  const auditFixturePath = join(paths.workspacePath, ".first-tree-eval", "audit-fixture.json");

  if (!bound) {
    const expectation: AuditFixtureExpectation = {
      advancedHeadOid: null,
      auditWorktreePath,
      defaultBranch: "main",
      expectedAction: evalCase.expected.action,
      expectedDiffPaths: evalCase.expected.diffPaths,
      expectedFinding: expectedFinding(evalCase.fixture.scenario),
      headOid: null,
      mode: evalCase.fixture.mode,
      originPath: null,
      repo,
      scenario: evalCase.fixture.scenario,
      scope,
      workspacePath: paths.workspacePath,
    };
    writeText(auditFixturePath, `${JSON.stringify(expectation, null, 2)}\n`);
    return {
      auditFixturePath,
      expectation,
      expectedOriginMainOid: null,
      initialAuditStatePaths: auditStatePaths(paths.workspacePath),
      initialLocalBranches: [],
      initialMainOid: null,
      initialWorktreePaths: [],
      originPath: null,
      treePath: null,
      verifyResultPath: null,
    };
  }

  const treePath = join(paths.workspacePath, "context-tree");
  const sourcePath = join(paths.workspacePath, "source-repo");
  const originPath = join(paths.runRoot, "context-tree-origin.git");
  mkdirSync(treePath, { recursive: true });
  writeText(join(treePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(treePath, ".first-tree", "tree.json"),
    `${JSON.stringify({ schemaVersion: 1, treeId: "audit-eval", treeMode: "dedicated", treeRepoName: "context-tree" }, null, 2)}\n`,
  );
  writeText(join(treePath, "NODE.md"), node("Audit Eval Tree", "## Decision\n\nAudit fixtures are deterministic."));
  writeText(join(treePath, "system", "NODE.md"), node("System", "## Decision\n\nSystem audit claims live here."));
  writeText(join(treePath, "members", "NODE.md"), node("Members", "Ownership routing for the eval tree."));
  writeText(
    join(treePath, "members", "eval-owner", "NODE.md"),
    `---\ntitle: "eval-owner"\nowners: [eval-owner]\ntype: human\nrole: "Evaluation owner"\ndomains: [system]\n---\n\n# eval-owner\n\nOwns the eval fixture.\n`,
  );
  writeText(join(treePath, scope), auditNode(evalCase));
  if (evalCase.fixture.scenario === "weak-cross-domain") {
    writeText(
      join(treePath, "system", "retention-policy.md"),
      node(
        "Retention Policy",
        "## Decision\n\nAudit evidence retention is 90 days.\n\n## Rationale\n\nNo current source or human decision identifies whether this sibling is canonical.",
      ),
    );
  }

  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "eval@example.invalid"],
    ["config", "user.name", "First Tree Eval"],
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "-m", "chore: seed audit fixture"],
  ]) {
    assertCommandOk(runCommand("git", args, treePath));
  }
  assertCommandOk(runCommand("git", ["clone", "--bare", treePath, originPath], paths.runRoot));
  assertCommandOk(runCommand("git", ["remote", "add", "origin", originPath], treePath));
  assertCommandOk(runCommand("git", ["fetch", "origin"], treePath));
  setupSourceRepository(sourcePath);

  const initialMainOid = runCommand("git", ["rev-parse", "HEAD"], treePath).stdout.trim();
  let advancedHeadOid: string | null = null;
  if (["stale-before-publish", "stale-before-write"].includes(evalCase.fixture.scenario)) {
    writeText(
      join(treePath, "NODE.md"),
      node("Audit Eval Tree", "## Decision\n\nAudit fixtures are deterministic after the default branch advances."),
    );
    assertCommandOk(runCommand("git", ["add", "NODE.md"], treePath));
    assertCommandOk(runCommand("git", ["commit", "-m", "chore: advance audit fixture main"], treePath));
    advancedHeadOid = runCommand("git", ["rev-parse", "HEAD"], treePath).stdout.trim();
    assertCommandOk(runCommand("git", ["push", "origin", `HEAD:refs/audit-fixture/${evalCase.id}`], treePath));
    assertCommandOk(runCommand("git", ["reset", "--hard", initialMainOid], treePath));
  }
  const verifyResultPath = recordVerification(paths, treePath);
  const expectation: AuditFixtureExpectation = {
    advancedHeadOid,
    auditWorktreePath,
    defaultBranch: "main",
    expectedAction: evalCase.expected.action,
    expectedDiffPaths: evalCase.expected.diffPaths,
    expectedFinding: expectedFinding(evalCase.fixture.scenario),
    headOid: initialMainOid,
    mode: evalCase.fixture.mode,
    originPath,
    repo,
    scenario: evalCase.fixture.scenario,
    scope,
    workspacePath: paths.workspacePath,
  };
  writeText(auditFixturePath, `${JSON.stringify(expectation, null, 2)}\n`);
  return {
    auditFixturePath,
    expectation,
    expectedOriginMainOid: advancedHeadOid ?? initialMainOid,
    initialAuditStatePaths: [],
    initialLocalBranches: localBranches(treePath),
    initialMainOid,
    initialWorktreePaths: worktreePaths(treePath),
    originPath,
    treePath,
    verifyResultPath,
  };
}

function remoteBranches(originPath: string): readonly string[] {
  return runCommand("git", ["--git-dir", originPath, "for-each-ref", "--format=%(refname)", "refs/heads"], "/")
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function localBranches(treePath: string): readonly string[] {
  return runCommand("git", ["branch", "--format=%(refname:short)"], treePath)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function worktreePaths(treePath: string): readonly string[] {
  return runCommand("git", ["worktree", "list", "--porcelain"], treePath)
    .stdout.split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .sort();
}

export function inspectFixtureState(fixture: AuditFixture): AuditFixtureState {
  if (!fixture.treePath || !fixture.originPath || !fixture.initialMainOid) {
    return {
      auditWorktreeCleaned: true,
      changedBranchCount: 0,
      diffPaths: [],
      expectedContentObserved: true,
      mainHeadUnchanged: true,
      mainWorktreeClean: true,
      noGuessedTreeState:
        JSON.stringify(auditStatePaths(fixture.expectation.workspacePath)) ===
        JSON.stringify(fixture.initialAuditStatePaths),
      originMainExpected: true,
      unpublishedAuthoringStateClean: true,
    };
  }

  const refs = remoteBranches(fixture.originPath);
  const changedRefs = refs.filter((ref) => ref !== "refs/heads/main");
  const diffPaths = new Set<string>();
  let expectedContentObserved = true;
  for (const ref of changedRefs) {
    const result = runCommand(
      "git",
      ["--git-dir", fixture.originPath, "diff", "--name-only", `refs/heads/main..${ref}`],
      "/",
    );
    for (const path of result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean))
      diffPaths.add(path);
    if (changedRefs.length === 1 && fixture.expectation.expectedAction === "focused-pr") {
      const content = runCommand(
        "git",
        ["--git-dir", fixture.originPath, "show", `${ref}:${fixture.expectation.scope}`],
        "/",
      );
      expectedContentObserved =
        content.exitCode === 0 &&
        (fixture.expectation.scenario === "mechanical"
          ? content.stdout.includes('title: "Audit Contract"') && content.stdout.includes("owners: [eval-owner]")
          : content.stdout.includes("Audit evidence retention is 90 days.") &&
            !content.stdout.includes("Audit evidence retention is 30 days."));
    }
  }
  const worktrees = runCommand("git", ["worktree", "list", "--porcelain"], fixture.treePath).stdout;
  const originMain = runCommand(
    "git",
    ["--git-dir", fixture.originPath, "rev-parse", "refs/heads/main"],
    "/",
  ).stdout.trim();
  return {
    auditWorktreeCleaned:
      fixture.expectation.auditWorktreePath === null ||
      (!existsSync(fixture.expectation.auditWorktreePath) &&
        !worktrees.includes(fixture.expectation.auditWorktreePath)),
    changedBranchCount: changedRefs.length,
    diffPaths: [...diffPaths].sort(),
    expectedContentObserved,
    mainHeadUnchanged:
      runCommand("git", ["rev-parse", "HEAD"], fixture.treePath).stdout.trim() === fixture.initialMainOid,
    mainWorktreeClean: runCommand("git", ["status", "--porcelain"], fixture.treePath).stdout.trim() === "",
    noGuessedTreeState: true,
    originMainExpected: originMain === fixture.expectedOriginMainOid,
    unpublishedAuthoringStateClean:
      fixture.expectation.scenario !== "stale-before-publish" ||
      (JSON.stringify(localBranches(fixture.treePath)) === JSON.stringify(fixture.initialLocalBranches) &&
        JSON.stringify(worktreePaths(fixture.treePath)) === JSON.stringify(fixture.initialWorktreePaths)),
  };
}

export function readRecordedVerifyExitCode(fixture: AuditFixture): number | null {
  if (!fixture.verifyResultPath || !existsSync(fixture.verifyResultPath)) return null;
  const value = JSON.parse(readFileSync(fixture.verifyResultPath, "utf8")) as { exitCode?: unknown };
  return typeof value.exitCode === "number" ? value.exitCode : null;
}
