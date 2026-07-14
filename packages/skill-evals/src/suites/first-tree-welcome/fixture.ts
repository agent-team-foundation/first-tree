import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent, previewText } from "../../core/events.js";
import { runFixtureVerify } from "../../core/fixture-verify.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FirstTreeWelcomeEvalCase, FixtureValidation } from "./types.js";

const SKILL_NAME = "first-tree-welcome";

function workspaceAgentsMarkdown(skillDescription: string, evalCase: FirstTreeWelcomeEvalCase): string {
  const sourceLine = (() => {
    if (evalCase.fixture.repoState === "selected-readable") {
      return "A selected readable source repo fixture is available at `./source-repo`.";
    }
    if (evalCase.fixture.repoState === "local-readable") {
      return "An ad-hoc local readable repo fixture is available at `./source-repo`; it is not a declared team source. Inspect it before deciding whether a post-value confirmation applies.";
    }
    if (evalCase.fixture.repoState === "selected-auth-fails") {
      return "A selected repository exists, but reading it fails with an authorization error. No repo evidence is readable; ask for a local project folder path or accessible URL.";
    }
    return "No readable source repository is connected in this eval workspace.";
  })();
  const treeLine = (() => {
    if (evalCase.fixture.treeState === "populated") {
      return "A populated Context Tree fixture is available at `./context-tree`.";
    }
    if (evalCase.fixture.treeState === "empty") {
      return "An empty bootstrap-only Context Tree fixture is available at `./context-tree`; it has no populated product evidence.";
    }
    return "No readable populated Context Tree is available in this eval workspace.";
  })();

  return `# First Tree Welcome Eval Workspace

This is a deterministic First Tree onboarding eval workspace. Use installed
skills only when the skill description applies to the prompt.

## Available Skills

| Skill | Load when |
|---|---|
| \`first-tree-welcome\` | ${skillDescription} |

When \`first-tree-welcome\` applies, load it by reading
\`.agents/skills/first-tree-welcome/SKILL.md\` before acting. Follow the loaded
skill workflow exactly.

## Eval Setup State

- Role: ${evalCase.fixture.role}
- Chat scenario: ${evalCase.fixture.chatScenario}
- GitHub App: ${evalCase.fixture.githubAppState}
- Repo state: ${evalCase.fixture.repoState}
- Context Tree state: ${evalCase.fixture.treeState}
- Tree setup chat: ${evalCase.fixture.treeSetupChat}

${sourceLine}
${treeLine}

If you need a tracked request, use
\`first-tree chat ask baixiaohang "<question>" --options '<json options>'\`.
The eval shim records chat commands only; it never sends a real message.

Do not use real GitHub, install GitHub Apps, create repositories, push, open
pull requests, create or bind Context Trees, or seed a Context Tree in this
eval workspace.
`;
}

function installFirstTreeWelcomeSkill(
  repoRoot: string,
  workspacePath: string,
  evalCase: FirstTreeWelcomeEvalCase,
): void {
  const skillMarkdown = installRepoSkill(repoRoot, workspacePath, SKILL_NAME);
  writeText(join(workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown), evalCase));
}

function writeWorkspaceManifest(paths: RunPaths, evalCase: FirstTreeWelcomeEvalCase): void {
  const hasReadableRepo = evalCase.fixture.repoState === "selected-readable";
  const hasContextTree = evalCase.fixture.treeState === "populated" || evalCase.fixture.treeState === "empty";
  const manifest = {
    sources: hasReadableRepo ? ["source-repo"] : [],
    tree: hasContextTree ? "context-tree" : null,
  };
  writeText(join(paths.workspacePath, ".first-tree", "workspace.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function sourceReadmeMarkdown(): string {
  return `# Acme Support Dashboard

This fixture is a small Next.js dashboard for support agents. The app has a
checkout recovery panel and a session-expiry flow.

Useful first-pass evidence:

- \`src/auth/session.ts\` contains an expired session TODO.
- \`src/checkout/recovery.ts\` contains checkout recovery logic without nearby
  tests.
- The README says to verify local changes with \`pnpm test\`.
`;
}

function sessionSource(): string {
  return `export function describeSessionExpiry(): string {
  // TODO: expired session handling should return a clear re-auth prompt.
  return "expired";
}
`;
}

function checkoutSource(): string {
  return `export function recoverCheckout(cartId: string): string {
  return "recover:" + cartId;
}
`;
}

function writeSourceRepoFixture(paths: RunPaths): string {
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  mkdirSync(sourceRepoPath, { recursive: true });
  writeText(join(sourceRepoPath, "README.md"), sourceReadmeMarkdown());
  writeText(join(sourceRepoPath, "src", "auth", "session.ts"), sessionSource());
  writeText(join(sourceRepoPath, "src", "checkout", "recovery.ts"), checkoutSource());
  writeText(
    join(sourceRepoPath, "package.json"),
    `${JSON.stringify({ name: "acme-support-dashboard", scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], sourceRepoPath));
  assertCommandOk(
    runCommand("git", ["remote", "add", "origin", "git@github.com:acme/support-dashboard.git"], sourceRepoPath),
  );
  assertCommandOk(runCommand("git", ["add", "."], sourceRepoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", "chore: seed welcome source fixture"], sourceRepoPath));
  return sourceRepoPath;
}

function gitHead(repoPath: string): string {
  return runCommand("git", ["rev-parse", "HEAD"], repoPath).stdout.trim();
}

function rootNodeMarkdown(): string {
  return `---
title: "Welcome Eval Context"
owners: [eval-owner]
---

# Welcome Eval Context

This deterministic Context Tree fixture is used to evaluate first-tree-welcome.
`;
}

function productNodeMarkdown(): string {
  return `---
title: "Product"
owners: [eval-owner]
---

# Product

Durable product constraints for the welcome eval fixture.
`;
}

function checkoutReliabilityMarkdown(): string {
  return `---
title: "Checkout Reliability"
owners: [eval-owner]
description: "Checkout reliability is the first support-dashboard confidence target."
---

# Checkout Reliability

## Decision

The support dashboard prioritizes checkout reliability before broad refactors.

## Rationale

Support agents need confidence that checkout recovery and expired-session flows
fail clearly before they expand the dashboard surface.

## Constraints

- First tasks should be small, verifiable, and tied to checkout or session
  evidence.
- Broad architecture rewrites are not a welcome-chat first task.
`;
}

function treeAgentsMarkdown(): string {
  return `# Eval Context Tree

This is a local deterministic Context Tree fixture for first-tree-welcome
evaluations.
`;
}

function memberNodeMarkdown(): string {
  return `---
title: "eval-owner"
owners: [eval-owner]
type: human
role: "Evaluation fixture owner"
domains:
  - "product"
---

# eval-owner

Owns the deterministic welcome eval fixture.
`;
}

function writeContextTreeFixture(paths: RunPaths): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  mkdirSync(contextTreePath, { recursive: true });
  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(contextTreePath, ".first-tree", "tree.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        treeId: "first-tree-welcome-eval",
        treeMode: "dedicated",
        treeRepoName: "context-tree",
      },
      null,
      2,
    )}\n`,
  );
  writeText(join(contextTreePath, "AGENTS.md"), treeAgentsMarkdown());
  writeText(join(contextTreePath, "NODE.md"), rootNodeMarkdown());
  writeText(join(contextTreePath, "product", "NODE.md"), productNodeMarkdown());
  writeText(join(contextTreePath, "product", "checkout-reliability.md"), checkoutReliabilityMarkdown());
  writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());

  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], contextTreePath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], contextTreePath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], contextTreePath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], contextTreePath));
  assertCommandOk(runCommand("git", ["add", "."], contextTreePath));
  assertCommandOk(runCommand("git", ["commit", "-m", "chore: seed welcome context tree"], contextTreePath));
  return contextTreePath;
}

function writeEmptyContextTreeFixture(paths: RunPaths): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  mkdirSync(contextTreePath, { recursive: true });
  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(contextTreePath, ".first-tree", "tree.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        treeId: "first-tree-welcome-empty-eval",
        treeMode: "dedicated",
        treeRepoName: "context-tree",
      },
      null,
      2,
    )}\n`,
  );
  writeText(join(contextTreePath, "AGENTS.md"), treeAgentsMarkdown());
  writeText(join(contextTreePath, "NODE.md"), rootNodeMarkdown());
  writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());

  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], contextTreePath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], contextTreePath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], contextTreePath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], contextTreePath));
  assertCommandOk(runCommand("git", ["add", "."], contextTreePath));
  assertCommandOk(runCommand("git", ["commit", "-m", "chore: seed empty welcome context tree"], contextTreePath));
  return contextTreePath;
}

export function setupFixture(
  evalCase: FirstTreeWelcomeEvalCase,
  paths: RunPaths,
  reporter: EvalReporter,
): string | null {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    fixture: evalCase.fixture,
    type: "fixture_setup_started",
    workspaceKind: "welcome-onboarding",
  });
  reporter.fixtureSetupStarted("welcome-onboarding");

  installFirstTreeWelcomeSkill(paths.repoRoot, paths.workspacePath, evalCase);
  writeWorkspaceManifest(paths, evalCase);
  let sourceRepoHead: string | null = null;
  if (evalCase.fixture.repoState === "selected-readable" || evalCase.fixture.repoState === "local-readable") {
    const sourceRepoPath = writeSourceRepoFixture(paths);
    sourceRepoHead = gitHead(sourceRepoPath);
  }
  const contextTreePath =
    evalCase.fixture.treeState === "populated"
      ? writeContextTreeFixture(paths)
      : evalCase.fixture.treeState === "empty"
        ? writeEmptyContextTreeFixture(paths)
        : null;
  const contextTreeHead = contextTreePath === null ? null : gitHead(contextTreePath);

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    contextTreeHead,
    contextTreePath,
    sourceRepoHead,
    type: "fixture_setup_finished",
    workspaceKind: "welcome-onboarding",
  });
  reporter.fixtureSetupFinished("welcome-onboarding", contextTreePath);

  return contextTreePath;
}

export function validateFixture(
  paths: RunPaths,
  contextTreePath: string | null,
  evalCase: FirstTreeWelcomeEvalCase,
  caseId: string,
  verbose: boolean,
  reporter: EvalReporter,
): FixtureValidation {
  const errors: string[] = [];
  if (contextTreePath === null) {
    reporter.fixtureValidationSkipped();
    return {
      contextTreeVerifyResult: null,
      errors,
      ok: true,
      requiredFilesOk: true,
    };
  }

  const requiredFiles = [
    join(contextTreePath, ".first-tree", "VERSION"),
    join(contextTreePath, ".first-tree", "tree.json"),
    join(contextTreePath, "NODE.md"),
    join(contextTreePath, "members", "eval-owner", "NODE.md"),
    ...(evalCase.fixture.treeState === "populated"
      ? [join(contextTreePath, "product", "NODE.md"), join(contextTreePath, "product", "checkout-reliability.md")]
      : []),
  ];
  const missingFiles = requiredFiles.filter((file) => !existsSync(file));
  for (const missing of missingFiles) {
    errors.push(`missing required file: ${missing}`);
  }

  const verifyResult = runFixtureVerify({ caseId, contextTreePath, paths, reporter, verbose });
  if (verifyResult.exitCode !== 0) {
    errors.push(
      `tree verify failed with exit ${verifyResult.exitCode}: ${previewText(verifyResult.stderr || verifyResult.stdout)}`,
    );
  }

  return {
    contextTreeVerifyResult: verifyResult,
    errors,
    ok: errors.length === 0,
    requiredFilesOk: missingFiles.length === 0,
  };
}
