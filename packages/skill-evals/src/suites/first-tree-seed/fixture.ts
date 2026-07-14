import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent, previewText } from "../../core/events.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FirstTreeSeedEvalCase, FixtureValidation } from "./types.js";

const SEED_SKILL_NAME = "first-tree-seed";

export function sourceDefaultBranch(evalCase: FirstTreeSeedEvalCase): string {
  return evalCase.fixture.sourceDefaultBranch ?? "main";
}

export function sourceRemoteRef(evalCase: FirstTreeSeedEvalCase): string {
  return `refs/remotes/origin/${sourceDefaultBranch(evalCase)}`;
}

function sourceWorktreeRef(evalCase: FirstTreeSeedEvalCase): string {
  return `origin/${sourceDefaultBranch(evalCase)}`;
}

function workspaceAgentsMarkdown(
  workspacePath: string,
  seedDescription: string,
  evalCase: FirstTreeSeedEvalCase,
): string {
  const sourceRepoPath = join(workspacePath, "source-repos", "source-repo");
  const sourceWorktreePath = join(workspacePath, "worktrees", "seed-source-repo");
  const chatSourcePath = join(workspacePath, "provided-source");
  const sourceBranch = sourceDefaultBranch(evalCase);
  const sourceForge = evalCase.fixture.sourceForge ?? "github";
  const sourceLine =
    evalCase.fixture.sourceRepoState === "missing"
      ? `The manifest source \`source-repo\` is intentionally missing from \`${sourceRepoPath}\`.`
      : evalCase.fixture.sourceRepoState === "chat-local-readable"
        ? `The workspace manifest intentionally declares no sources. The user supplied the readable local Git checkout \`${chatSourcePath}\` in this setup chat; use it directly without requiring GitHub App installation or team-resource registration.`
        : evalCase.fixture.sourceRepoState === "real-first-tree-bare-readable"
          ? `The manifest source \`source-repo\` exists as a bare clone of the current first-tree repo at \`${sourceRepoPath}\`.`
          : `The manifest source \`source-repo\` exists as a bare clone at \`${sourceRepoPath}\`. Its forge is ${sourceForge}, and its default branch is \`${sourceBranch}\`.`;
  const treeLine =
    evalCase.fixture.treeState === "unbound"
      ? 'The workspace is NOT bound to a Context Tree yet: `./.first-tree/workspace.json` has no `tree` field and no `./context-tree` exists. Per state A, the tree must be created and bound with `first-tree tree init --title "<team display name>" --dir "<workspaceRoot>/context-tree"` (the `--dir` pin is load-bearing so the created clone lands where the workspace expects it).'
      : evalCase.fixture.treeState === "empty"
        ? "The Context Tree at `./context-tree` is newly provisioned and empty."
        : evalCase.fixture.treeState === "phase1-approved"
          ? "The Context Tree at `./context-tree` has a Phase-1-shaped skeleton. Its shape alone does not prove that this chat owns the setup lifecycle; inspect the visible prior-turn transcript when one is provided."
          : "The Context Tree at `./context-tree` is already populated with durable domains.";
  const contextTreeStateLine =
    evalCase.fixture.treeState === "unbound"
      ? "- Context Tree: unbound (no `tree` field in the manifest; conventional path would be `./context-tree`)"
      : "- Context Tree: `./context-tree`";
  const chatHistoryLine =
    evalCase.fixture.chatHistoryState === "approved-phase1"
      ? "- Visible prior-turn transcript: `./.first-tree-eval/chat-history.md` (inspect it before applying the populated-tree continuation exception)"
      : evalCase.fixture.chatHistoryState === "absent"
        ? "- Visible prior-turn transcript: absent for this chat"
        : null;

  return `# First Tree Seed Eval Workspace

This is a deterministic First Tree seed eval workspace. Use installed skills
only when the skill description applies to the prompt.

## Available Skills

| Skill | Load when |
|---|---|
| \`first-tree-seed\` | ${seedDescription} |

When \`first-tree-seed\` applies, load it by reading
\`.agents/skills/first-tree-seed/SKILL.md\` before acting. The generated
Context Tree Policy below is the shared content baseline for seed.

## Context Tree Policy

The tree records durable decisions, constraints, ownership, and cross-domain
relationships; source repos record implementation detail. Use the Double Test:
a candidate belongs only when it establishes or changes a decision future
agents must respect and remains durable if the triggering commit or PR is
rewritten. Capture current truth and rationale, not history, PR references, or
actionable future work. Normal tree content is canonical; archive/supporting
and member content are non-normal classes with narrower authority.

## Eval Workspace State

- Workspace manifest: \`./.first-tree/workspace.json\`
${contextTreeStateLine}
${chatHistoryLine ?? ""}
- Sources root: \`./source-repos\`
- Declared source: \`source-repo\`
- Tree state: ${evalCase.fixture.treeState}
- Source state: ${evalCase.fixture.sourceRepoState}
- Source forge: ${sourceForge}
- Source default branch: \`${sourceBranch}\`

${treeLine}
${sourceLine}

${
  evalCase.fixture.sourceRepoState === "chat-local-readable"
    ? `## Chat-provided Source Protocol

The user supplied \`${chatSourcePath}\` as an already readable, non-bare local
Git checkout. Read it directly. Do not materialize a bare-source worktree and
do not require GitHub App installation or source-resource registration.`
    : `## Source Worktrees Protocol

Declared sources are agent-managed bare clones. Do not read source files
directly from \`${sourceRepoPath}\`; it is a git object store, not a
checkout. To read source, materialize a read worktree:

\`\`\`bash
git -C ${sourceRepoPath} fetch origin
git -C ${sourceRepoPath} worktree add ${sourceWorktreePath} ${sourceWorktreeRef(evalCase)}
\`\`\`

Then read files under \`${sourceWorktreePath}\`.`
}

${
  evalCase.expected.requireGithubGovernanceBootstrap
    ? `## GitHub Governance Eval Exception

This case uses local shims for \`tree init\`, \`gh\`, \`git push\`, and the local
bare \`origin\` created by the shim. You may perform only the simulated Context
Repo governance path requested in the prompt: create the tree, write and push
\`.github/CODEOWNERS\` to the shimmed origin, validate it through the \`gh\` shim,
and create/update the repository-local ruleset through the \`gh\` shim. Do not
open PRs, create real GitHub repositories, or perform unrelated GitHub actions.`
    : evalCase.expected.requireGithubGovernanceRecovery
      ? `## GitHub Governance Recovery Eval Exception

This case uses local shims for \`tree init\` and \`gh\`. You may run discovery
commands needed to detect the simulated governance setup failure, but you must
not commit/push \`CODEOWNERS\` or create/update the ruleset after the failure.`
      : `Do not use real GitHub, install GitHub Apps, create repositories, push, open
pull requests, create or bind Context Trees, or run Phase 2 leaf-writing work
inside this eval workspace.`
}
`;
}

function installSeedSkills(repoRoot: string, workspacePath: string, evalCase: FirstTreeSeedEvalCase): void {
  const seedMarkdown = installRepoSkill(repoRoot, workspacePath, SEED_SKILL_NAME);
  writeText(
    join(workspacePath, "AGENTS.md"),
    workspaceAgentsMarkdown(workspacePath, parseSkillDescription(seedMarkdown), evalCase),
  );
}

function writeWorkspaceManifest(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): void {
  const sources = evalCase.fixture.sourceRepoState === "chat-local-readable" ? [] : ["source-repo"];
  const manifest =
    evalCase.fixture.treeState === "unbound"
      ? { sources, sourcesRoot: "source-repos" }
      : { sources, sourcesRoot: "source-repos", tree: "context-tree" };
  writeText(join(paths.workspacePath, ".first-tree", "workspace.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function approvedPhase1ChatHistoryMarkdown(): string {
  return `# Visible Context Tree setup chat transcript

## Assistant — earlier turn

Phase 1 proposal: create the reviewed top-level \`product\` and \`system\`
domains, with \`product/onboarding\` and \`system/cloud\` as second-level
domains. Please approve this skeleton before I write the structure PR.

## User — earlier turn

Approved. Use that exact Phase 1 skeleton.

## Assistant — earlier turn

Phase 1 PR handoff: the approved structure PR is ready. Merge it, then reply in
this setup chat so I can verify the default branch and continue Phase 2.
`;
}

function writeChatHistoryFixture(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): void {
  if (evalCase.fixture.chatHistoryState !== "approved-phase1") return;
  writeText(join(paths.workspacePath, ".first-tree-eval", "chat-history.md"), approvedPhase1ChatHistoryMarkdown());
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

function approvedSkeletonRootMarkdown(): string {
  return `---
title: "Approved Seed Skeleton"
owners: [eval-owner]
---

# Approved Seed Skeleton

Approved Phase 1 domain skeleton. Phase 2 leaf content is not drafted yet.
`;
}

function approvedSkeletonNodeMarkdown(title: string): string {
  return `---
title: "${title}"
owners: [eval-owner]
---

# ${title}

Approved Phase 1 node awaiting Phase 2 leaf content.
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

function initGitRepo(repoPath: string, message: string, initialBranch = "main"): void {
  assertCommandOk(runCommand("git", ["init", `--initial-branch=${initialBranch}`], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], repoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], repoPath));
  assertCommandOk(runCommand("git", ["add", "."], repoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", message], repoPath));
}

function writeContextTreeFixture(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  if (evalCase.fixture.treeState === "unbound") {
    // State A: the workspace is genuinely unbound. Do NOT provision a
    // context-tree; the state check must create + bind it with `tree init --dir`.
    return contextTreePath;
  }
  mkdirSync(contextTreePath, { recursive: true });
  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(join(contextTreePath, ".first-tree", "tree.json"), contextTreeMetadata());

  if (evalCase.fixture.treeState === "nonempty") {
    writeText(join(contextTreePath, "NODE.md"), rootNodeMarkdown());
    writeText(join(contextTreePath, "system", "NODE.md"), systemNodeMarkdown());
    writeText(join(contextTreePath, "system", "cli.md"), cliNodeMarkdown());
    writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());
  } else if (evalCase.fixture.treeState === "phase1-approved") {
    writeText(join(contextTreePath, "NODE.md"), approvedSkeletonRootMarkdown());
    writeText(join(contextTreePath, "system", "NODE.md"), approvedSkeletonNodeMarkdown("System"));
    writeText(join(contextTreePath, "system", "cloud", "NODE.md"), approvedSkeletonNodeMarkdown("Cloud"));
    writeText(join(contextTreePath, "product", "NODE.md"), approvedSkeletonNodeMarkdown("Product"));
    writeText(join(contextTreePath, "product", "onboarding", "NODE.md"), approvedSkeletonNodeMarkdown("Onboarding"));
  }

  initGitRepo(
    contextTreePath,
    evalCase.fixture.treeState === "empty"
      ? "chore: provision empty context tree"
      : evalCase.fixture.treeState === "phase1-approved"
        ? "docs: merge approved phase one skeleton"
        : "chore: seed populated context tree",
  );
  if (evalCase.fixture.treeState === "phase1-approved") {
    const treeOriginPath = join(paths.runRoot, "context-tree-origin.git");
    assertCommandOk(runCommand("git", ["clone", "--bare", contextTreePath, treeOriginPath], paths.workspacePath));
    assertCommandOk(runCommand("git", ["remote", "add", "origin", treeOriginPath], contextTreePath));
    assertCommandOk(runCommand("git", ["fetch", "origin"], contextTreePath));
    assertCommandOk(runCommand("git", ["remote", "set-head", "origin", "main"], contextTreePath));
  }
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

function writeSourceOriginFixture(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): string {
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
  initGitRepo(sourceOriginPath, "chore: seed source fixture", sourceDefaultBranch(evalCase));
  return sourceOriginPath;
}

function writeBareSourceFixture(paths: RunPaths, evalCase: FirstTreeSeedEvalCase): string | null {
  if (evalCase.fixture.sourceRepoState === "missing") {
    return null;
  }

  if (evalCase.fixture.sourceRepoState === "real-first-tree-bare-readable") {
    return writeRealFirstTreeBareSourceFixture(paths);
  }

  const sourceOriginPath = writeSourceOriginFixture(paths, evalCase);
  if (evalCase.fixture.sourceRepoState === "chat-local-readable") {
    const chatSourcePath = join(paths.workspacePath, "provided-source");
    assertCommandOk(runCommand("git", ["clone", sourceOriginPath, chatSourcePath], paths.workspacePath));
    return chatSourcePath;
  }

  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  mkdirSync(join(paths.workspacePath, "source-repos"), { recursive: true });
  assertCommandOk(runCommand("git", ["clone", "--bare", sourceOriginPath, sourceRepoPath], paths.workspacePath));
  assertCommandOk(
    runCommand("git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], sourceRepoPath),
  );
  assertCommandOk(runCommand("git", ["fetch", "origin"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["remote", "set-head", "origin", sourceDefaultBranch(evalCase)], sourceRepoPath));
  assertCommandOk(runCommand("git", ["rev-parse", sourceRemoteRef(evalCase)], sourceRepoPath));
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
  const repoHead = gitHead(paths.repoRoot);
  if (repoHead === null) {
    throw new Error(`real first-tree repo is missing HEAD: ${paths.repoRoot}`);
  }
  assertCommandOk(
    runCommand("git", ["clone", "--bare", "--no-local", paths.repoRoot, sourceOriginPath], paths.workspacePath),
  );
  assertCommandOk(runCommand("git", ["update-ref", "refs/heads/main", repoHead], sourceOriginPath));
  assertCommandOk(runCommand("git", ["symbolic-ref", "HEAD", "refs/heads/main"], sourceOriginPath));
  const removeOrigin = runCommand("git", ["remote", "remove", "origin"], sourceOriginPath);
  if (removeOrigin.exitCode !== 0 && !removeOrigin.stderr.includes("No such remote")) {
    assertCommandOk(removeOrigin);
  }
  const sourceMain = gitHead(sourceOriginPath, "refs/heads/main");
  if (sourceMain !== repoHead) {
    throw new Error(`real first-tree source origin main ${sourceMain ?? "missing"} does not match ${repoHead}`);
  }
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
  writeWorkspaceManifest(paths, evalCase);
  writeChatHistoryFixture(paths, evalCase);
  const contextTreePath = writeContextTreeFixture(paths, evalCase);
  const sourceRepoPath = writeBareSourceFixture(paths, evalCase);
  mkdirSync(join(paths.workspacePath, "worktrees"), { recursive: true });

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    contextTreeHead: gitHead(contextTreePath),
    contextTreePath,
    sourceRepoHead:
      sourceRepoPath === null
        ? null
        : gitHead(
            sourceRepoPath,
            evalCase.fixture.sourceRepoState === "chat-local-readable" ? "HEAD" : sourceRemoteRef(evalCase),
          ),
    sourceRepoPath,
    type: "fixture_setup_finished",
    workspaceKind: "seed-bootstrap",
  });
  reporter.fixtureSetupFinished("seed-bootstrap", contextTreePath);

  return contextTreePath;
}

function validateSourceRepo(paths: RunPaths, evalCase: FirstTreeSeedEvalCase, errors: string[]): boolean {
  if (evalCase.fixture.sourceRepoState === "chat-local-readable") {
    const chatSourcePath = join(paths.workspacePath, "provided-source");
    if (!existsSync(chatSourcePath)) {
      errors.push(`missing chat-provided source checkout: ${chatSourcePath}`);
      return false;
    }
    const bare = runCommand("git", ["rev-parse", "--is-bare-repository"], chatSourcePath);
    if (bare.stdout.trim() !== "false" || gitHead(chatSourcePath) === null) {
      errors.push(`chat-provided source is not a readable Git checkout: ${chatSourcePath}`);
      return false;
    }
    return true;
  }

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
  const remoteDefault = runCommand("git", ["rev-parse", sourceRemoteRef(evalCase)], sourceRepoPath);
  if (remoteDefault.exitCode !== 0) {
    errors.push(`source repo is missing ${sourceRemoteRef(evalCase)}: ${previewText(remoteDefault.stderr)}`);
    return false;
  }
  return true;
}

function validateTreeUnbound(paths: RunPaths, contextTreePath: string, errors: string[]): boolean {
  let ok = true;
  if (existsSync(contextTreePath)) {
    errors.push(`unbound tree fixture must not pre-create a context tree: ${contextTreePath}`);
    ok = false;
  }
  const manifestPath = join(paths.workspacePath, ".first-tree", "workspace.json");
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error: unknown) {
    errors.push(
      `unbound tree fixture manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const tree =
    typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>).tree
      : undefined;
  if (typeof tree === "string" && tree.trim() !== "") {
    errors.push(`unbound tree fixture manifest must not bind a tree, found tree=${tree}`);
    ok = false;
  }
  return ok;
}

function validateTreeEmpty(
  paths: RunPaths,
  contextTreePath: string,
  evalCase: FirstTreeSeedEvalCase,
  errors: string[],
): boolean {
  if (evalCase.fixture.treeState === "nonempty") return true;
  if (evalCase.fixture.treeState === "phase1-approved") {
    const localHead = gitHead(contextTreePath);
    const remoteHead = gitHead(contextTreePath, "refs/remotes/origin/main");
    const remoteDefault = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], contextTreePath);
    if (localHead === null || remoteHead !== localHead || remoteDefault.stdout.trim() !== "refs/remotes/origin/main") {
      errors.push("approved Phase 1 fixture must be merged into the configured origin default branch.");
      return false;
    }
    return true;
  }
  if (evalCase.fixture.treeState === "unbound") return validateTreeUnbound(paths, contextTreePath, errors);
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
  // An unbound workspace (state A) has no provisioned context tree, so
  // the tree's `.first-tree` metadata files do not exist yet by design.
  const requiredFiles =
    evalCase.fixture.treeState === "unbound"
      ? [manifestPath]
      : [
          manifestPath,
          join(contextTreePath, ".first-tree", "VERSION"),
          join(contextTreePath, ".first-tree", "tree.json"),
        ];
  if (evalCase.fixture.chatHistoryState === "approved-phase1") {
    requiredFiles.push(join(paths.workspacePath, ".first-tree-eval", "chat-history.md"));
  }
  const missingFiles = requiredFiles.filter((file) => !existsSync(file));
  for (const missing of missingFiles) {
    errors.push(`missing required file: ${missing}`);
  }
  const chatHistoryPath = join(paths.workspacePath, ".first-tree-eval", "chat-history.md");
  if (evalCase.fixture.chatHistoryState === "absent" && existsSync(chatHistoryPath)) {
    errors.push(`chat history should be absent but exists: ${chatHistoryPath}`);
  }

  const treeEmptyOk = validateTreeEmpty(paths, contextTreePath, evalCase, errors);
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
