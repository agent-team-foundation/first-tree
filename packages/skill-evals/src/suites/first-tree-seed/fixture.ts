import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent, previewText } from "../../core/events.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FirstTreeSeedEvalCase, FixtureValidation } from "./types.js";

const SEED_SKILL_NAME = "first-tree-seed";
const WRITE_SKILL_NAME = "first-tree-write";

function workspaceAgentsMarkdown(
  workspacePath: string,
  seedDescription: string,
  writeDescription: string,
  evalCase: FirstTreeSeedEvalCase,
): string {
  const sourceRepoPath = join(workspacePath, "source-repos", "source-repo");
  const sourceWorktreePath = join(workspacePath, "worktrees", "seed-source-repo");
  const sourceLine =
    evalCase.fixture.sourceRepoState === "missing"
      ? `The manifest source \`source-repo\` is intentionally missing from \`${sourceRepoPath}\`.`
      : evalCase.fixture.sourceRepoState === "real-first-tree-bare-readable"
        ? `The manifest source \`source-repo\` exists as a bare clone of the current first-tree repo at \`${sourceRepoPath}\`.`
        : `The manifest source \`source-repo\` exists as a bare clone at \`${sourceRepoPath}\`.`;
  const treeLine =
    evalCase.fixture.treeState === "empty"
      ? "The Context Tree at `./context-tree` is newly provisioned and empty."
      : "The Context Tree at `./context-tree` is already populated with durable domains.";

  return `# First Tree Seed Eval Workspace

This is a deterministic First Tree seed eval workspace. Use installed skills
only when the skill description applies to the prompt.

## Available Skills

| Skill | Load when |
|---|---|
| \`first-tree-seed\` | ${seedDescription} |
| \`first-tree-write\` | ${writeDescription} |

When \`first-tree-seed\` applies, load it by reading
\`.agents/skills/first-tree-seed/SKILL.md\` before acting. The seed skill may
also require reading \`.agents/skills/first-tree-write/SKILL.md\`; that file is
installed in this workspace.

## Eval Workspace State

- Workspace manifest: \`./.first-tree/workspace.json\`
- Context Tree: \`./context-tree\`
- Sources root: \`./source-repos\`
- Declared source: \`source-repo\`
- Tree state: ${evalCase.fixture.treeState}
- Source state: ${evalCase.fixture.sourceRepoState}

${treeLine}
${sourceLine}

## Source Worktrees Protocol

Declared sources are agent-managed bare clones. Do not read source files
directly from \`${sourceRepoPath}\`; it is a git object store, not a
checkout. To read source, materialize a read worktree:

\`\`\`bash
git -C ${sourceRepoPath} fetch origin
git -C ${sourceRepoPath} worktree add ${sourceWorktreePath} origin/main
\`\`\`

Then read files under \`${sourceWorktreePath}\`.

Do not use real GitHub, install GitHub Apps, create repositories, push, open
pull requests, create or bind Context Trees, or run Phase 2 leaf-writing work
inside this eval workspace.
`;
}

function installSeedSkills(repoRoot: string, workspacePath: string, evalCase: FirstTreeSeedEvalCase): void {
  const seedMarkdown = installRepoSkill(repoRoot, workspacePath, SEED_SKILL_NAME);
  const writeMarkdown = installRepoSkill(repoRoot, workspacePath, WRITE_SKILL_NAME);
  writeText(
    join(workspacePath, "AGENTS.md"),
    workspaceAgentsMarkdown(
      workspacePath,
      parseSkillDescription(seedMarkdown),
      parseSkillDescription(writeMarkdown),
      evalCase,
    ),
  );
}

function writeWorkspaceManifest(paths: RunPaths): void {
  writeText(
    join(paths.workspacePath, ".first-tree", "workspace.json"),
    `${JSON.stringify({ sources: ["source-repo"], sourcesRoot: "source-repos", tree: "context-tree" }, null, 2)}\n`,
  );
}

function rootNodeMarkdown(): string {
  return `---
title: "Seed Eval Context"
owners: [eval-owner]
---

# Seed Eval Context

This deterministic Context Tree fixture is already populated and must not be
seeded again.
`;
}

function systemNodeMarkdown(): string {
  return `---
title: "System"
owners: [eval-owner]
---

# System

Durable system constraints for the seed eval fixture.
`;
}

function cliNodeMarkdown(): string {
  return `---
title: "CLI"
owners: [eval-owner]
description: "The CLI owns local workspace and Context Tree operations."
---

# CLI

## Decision

The local CLI owns workspace and Context Tree operations.

## Rationale

Agents need a stable local command surface before Cloud onboarding is complete.
`;
}

function memberNodeMarkdown(): string {
  return `---
title: "eval-owner"
owners: [eval-owner]
type: human
role: "Evaluation fixture owner"
domains:
  - "system"
---

# eval-owner

Owns the deterministic seed eval fixture.
`;
}

function contextTreeMetadata(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      treeId: "first-tree-seed-eval",
      treeMode: "dedicated",
      treeRepoName: "context-tree",
    },
    null,
    2,
  )}\n`;
}

function initGitRepo(repoPath: string, message: string): void {
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], repoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], repoPath));
  assertCommandOk(runCommand("git", ["add", "."], repoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", message], repoPath));
}

function writeContextTreeFixture(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  mkdirSync(contextTreePath, { recursive: true });
  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(join(contextTreePath, ".first-tree", "tree.json"), contextTreeMetadata());

  if (evalCase.fixture.treeState === "nonempty") {
    writeText(join(contextTreePath, "NODE.md"), rootNodeMarkdown());
    writeText(join(contextTreePath, "system", "NODE.md"), systemNodeMarkdown());
    writeText(join(contextTreePath, "system", "cli.md"), cliNodeMarkdown());
    writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());
  }

  initGitRepo(
    contextTreePath,
    evalCase.fixture.treeState === "empty"
      ? "chore: provision empty context tree"
      : "chore: seed populated context tree",
  );
  return contextTreePath;
}

function sourceReadmeMarkdown(): string {
  return `# Apollo Console

Apollo Console is a TypeScript workspace for operating a small agent team. It
ships a CLI, a web dashboard, and shared packages for runtime coordination.

Strong structural signals:

- \`apps/cli\` owns local workspace and Context Tree commands.
- \`apps/web\` owns onboarding and operator dashboard screens.
- \`packages/runtime\` owns agent session orchestration.
- \`docs/team-practice.md\` records collaboration conventions.
`;
}

function cliReadmeMarkdown(): string {
  return `# CLI App

The CLI manages local workspace setup, Context Tree commands, and agent
configuration.
`;
}

function webReadmeMarkdown(): string {
  return `# Web Dashboard

The web dashboard handles onboarding, repository selection, and operator
status views.
`;
}

function architectureMarkdown(): string {
  return `# Architecture

The system splits concerns across local CLI operations, Cloud onboarding, web
operator surfaces, and runtime packages. Context Tree content should organize
around these concerns rather than mirror every source directory.
`;
}

function teamPracticeMarkdown(): string {
  return `# Team Practice

The team uses agent handoffs, review gates, and Context Tree updates to keep
durable context separate from implementation details.
`;
}

function writeSourceOriginFixture(paths: RunPaths): string {
  const sourceOriginPath = join(paths.runRoot, "source-origin");
  mkdirSync(sourceOriginPath, { recursive: true });
  writeText(join(sourceOriginPath, "README.md"), sourceReadmeMarkdown());
  writeText(join(sourceOriginPath, "apps", "cli", "README.md"), cliReadmeMarkdown());
  writeText(join(sourceOriginPath, "apps", "web", "README.md"), webReadmeMarkdown());
  writeText(join(sourceOriginPath, "docs", "architecture.md"), architectureMarkdown());
  writeText(join(sourceOriginPath, "docs", "team-practice.md"), teamPracticeMarkdown());
  writeText(
    join(sourceOriginPath, "package.json"),
    `${JSON.stringify({ name: "apollo-console", workspaces: ["apps/*", "packages/*"] }, null, 2)}\n`,
  );
  initGitRepo(sourceOriginPath, "chore: seed source fixture");
  return sourceOriginPath;
}

function writeBareSourceFixture(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): string | null {
  if (evalCase.fixture.sourceRepoState === "missing") {
    return null;
  }

  if (evalCase.fixture.sourceRepoState === "real-first-tree-bare-readable") {
    return writeRealFirstTreeBareSourceFixture(paths);
  }

  const sourceOriginPath = writeSourceOriginFixture(paths);
  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  mkdirSync(join(paths.workspacePath, "source-repos"), { recursive: true });
  assertCommandOk(runCommand("git", ["clone", "--bare", sourceOriginPath, sourceRepoPath], paths.workspacePath));
  assertCommandOk(
    runCommand("git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], sourceRepoPath),
  );
  assertCommandOk(runCommand("git", ["fetch", "origin"], sourceRepoPath));
  return sourceRepoPath;
}

function writeRealFirstTreeBareSourceFixture(paths: RunPaths): string {
  const sourceOriginPath = writeRealFirstTreeSourceOriginFixture(paths);
  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  mkdirSync(join(paths.workspacePath, "source-repos"), { recursive: true });
  assertCommandOk(runCommand("git", ["init", "--bare", sourceRepoPath], paths.workspacePath));
  assertCommandOk(runCommand("git", ["remote", "add", "origin", sourceOriginPath], sourceRepoPath));
  assertCommandOk(
    runCommand("git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], sourceRepoPath),
  );
  assertCommandOk(runCommand("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], sourceRepoPath));
  const sourceMain = gitHead(sourceOriginPath, "refs/heads/main");
  if (sourceMain === null) {
    throw new Error(`real first-tree source origin is missing refs/heads/main: ${sourceOriginPath}`);
  }
  assertCommandOk(runCommand("git", ["update-ref", "refs/remotes/origin/main", sourceMain], sourceRepoPath));
  assertCommandOk(runCommand("git", ["rev-parse", "refs/remotes/origin/main"], sourceRepoPath));
  return sourceRepoPath;
}

function writeRealFirstTreeSourceOriginFixture(paths: RunPaths): string {
  const sourceOriginPath = join(paths.workspacePath, ".first-tree-eval", "source-origin");
  assertCommandOk(runCommand("git", ["init", "--bare", sourceOriginPath], paths.workspacePath));
  assertCommandOk(runCommand("git", ["remote", "add", "source", paths.repoRoot], sourceOriginPath));
  assertCommandOk(runCommand("git", ["fetch", "source", "HEAD:refs/heads/main"], sourceOriginPath));
  assertCommandOk(runCommand("git", ["symbolic-ref", "HEAD", "refs/heads/main"], sourceOriginPath));
  assertCommandOk(runCommand("git", ["remote", "remove", "source"], sourceOriginPath));
  assertCommandOk(runCommand("git", ["rev-parse", "refs/heads/main"], sourceOriginPath));
  return sourceOriginPath;
}

function gitHead(repoPath: string, ref = "HEAD"): string | null {
  const result = runCommand("git", ["rev-parse", ref], repoPath);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export function setupFixture(evalCase: FirstTreeSeedEvalCase, paths: RunPaths, reporter: EvalReporter): string {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    fixture: evalCase.fixture,
    type: "fixture_setup_started",
    workspaceKind: "seed-bootstrap",
  });
  reporter.fixtureSetupStarted("seed-bootstrap");

  installSeedSkills(paths.repoRoot, paths.workspacePath, evalCase);
  writeWorkspaceManifest(paths);
  const contextTreePath = writeContextTreeFixture(paths, evalCase);
  const sourceRepoPath = writeBareSourceFixture(paths, evalCase);
  mkdirSync(join(paths.workspacePath, "worktrees"), { recursive: true });

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    contextTreeHead: gitHead(contextTreePath),
    contextTreePath,
    sourceRepoHead: sourceRepoPath === null ? null : gitHead(sourceRepoPath, "refs/remotes/origin/main"),
    sourceRepoPath,
    type: "fixture_setup_finished",
    workspaceKind: "seed-bootstrap",
  });
  reporter.fixtureSetupFinished("seed-bootstrap", contextTreePath);

  return contextTreePath;
}

function validateSourceRepo(paths: RunPaths, evalCase: FirstTreeSeedEvalCase, errors: string[]): boolean {
  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  if (evalCase.fixture.sourceRepoState === "missing") {
    if (existsSync(sourceRepoPath)) {
      errors.push(`source repo should be missing but exists: ${sourceRepoPath}`);
      return false;
    }
    return true;
  }

  if (!existsSync(sourceRepoPath)) {
    errors.push(`missing source repo: ${sourceRepoPath}`);
    return false;
  }

  const bare = runCommand("git", ["rev-parse", "--is-bare-repository"], sourceRepoPath);
  if (bare.stdout.trim() !== "true") {
    errors.push(`source repo is not bare: ${sourceRepoPath}`);
    return false;
  }
  const remoteMain = runCommand("git", ["rev-parse", "refs/remotes/origin/main"], sourceRepoPath);
  if (remoteMain.exitCode !== 0) {
    errors.push(`source repo is missing refs/remotes/origin/main: ${previewText(remoteMain.stderr)}`);
    return false;
  }
  return true;
}

function validateTreeEmpty(contextTreePath: string, evalCase: FirstTreeSeedEvalCase, errors: string[]): boolean {
  if (evalCase.fixture.treeState === "nonempty") return true;
  const forbiddenEntries = readdirSync(contextTreePath).filter((entry) => {
    if (entry === ".git" || entry === ".first-tree" || entry === ".github") return false;
    return !entry.startsWith(".");
  });
  if (forbiddenEntries.length > 0) {
    errors.push(`empty tree fixture has non-empty entries: ${forbiddenEntries.join(", ")}`);
    return false;
  }
  return true;
}

export function validateFixture(
  paths: RunPaths,
  contextTreePath: string,
  evalCase: FirstTreeSeedEvalCase,
  verbose: boolean,
  reporter: EvalReporter,
): FixtureValidation {
  const errors: string[] = [];
  const manifestPath = join(paths.workspacePath, ".first-tree", "workspace.json");
  const requiredFiles = [
    manifestPath,
    join(contextTreePath, ".first-tree", "VERSION"),
    join(contextTreePath, ".first-tree", "tree.json"),
  ];
  const missingFiles = requiredFiles.filter((file) => !existsSync(file));
  for (const missing of missingFiles) {
    errors.push(`missing required file: ${missing}`);
  }

  const treeEmptyOk = validateTreeEmpty(contextTreePath, evalCase, errors);
  const sourceRepoOk = validateSourceRepo(paths, evalCase, errors);
  void verbose;
  reporter.fixtureValidationSkipped();

  return {
    contextTreeVerifyResult: null,
    errors,
    ok: errors.length === 0,
    requiredFilesOk: missingFiles.length === 0,
    sourceRepoOk,
    treeEmptyOk,
  };
}

export function cleanupSeedReadWorktrees(paths: RunPaths): void {
  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  const worktreeRoot = join(paths.workspacePath, "worktrees");
  if (!existsSync(sourceRepoPath) || !existsSync(worktreeRoot)) return;

  for (const entry of readdirSync(worktreeRoot)) {
    const candidate = join(worktreeRoot, entry);
    if (!entry.startsWith("seed-source-repo")) continue;
    const result = runCommand(
      "git",
      ["-C", sourceRepoPath, "worktree", "remove", candidate, "--force"],
      paths.workspacePath,
    );
    if (result.exitCode !== 0) {
      rmSync(candidate, { force: true, recursive: true });
    }
  }
}
