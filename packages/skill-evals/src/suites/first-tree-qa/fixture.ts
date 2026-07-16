import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent } from "../../core/events.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FirstTreeQaEvalCase, FixtureValidation } from "./types.js";

const SKILL_NAME = "first-tree-qa";

function workspaceAgentsMarkdown(skillDescription: string): string {
  return [
    "# First Tree QA Eval Workspace",
    "",
    "This workspace contains one product repository at `source-repo/`. Treat that",
    "repository as the immutable product under test. Put all run context, plans,",
    "evidence, and reports in the sibling `qa-artifacts/` directory.",
    "",
    "## Available Skills",
    "",
    "| Skill | Load when |",
    "|---|---|",
    `| \`first-tree-qa\` | ${skillDescription} |`,
    "",
    "When `first-tree-qa` applies, read",
    "`.agents/skills/first-tree-qa/SKILL.md` before acting.",
    "",
  ].join("\n");
}

function productReadme(): string {
  return [
    "# Northstar",
    "",
    "Northstar ships two formal product surfaces: a command-line client and a web",
    "console. Both surfaces use the same dependency-free local harness command:",
    "",
    "    node tools/product.mjs harness <cli|web> <build|run|drive|observe|measure|reset>",
    "",
    "The command exits non-zero when a capability is unavailable. Continue checking",
    "the remaining capabilities so the final readiness record describes the complete",
    "surface matrix. Measurements print a lightweight latency sample.",
    "",
    "The deterministic status process boundary is already covered by `node --test`.",
    "Live QA must still exercise the documented public task command.",
    "",
    "After the whole product is ready, the requested CLI status behavior is exercised",
    "with:",
    "",
    "    node tools/product.mjs task cli status",
    "",
    "Do not edit this repository while validating it.",
    "",
  ].join("\n");
}

function productScript(): string {
  return [
    "import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { dirname, resolve } from 'node:path';",
    "import { statusText } from '../src/status.mjs';",
    "",
    "const args = process.argv.slice(2);",
    "const artifacts = resolve(process.cwd(), '..', 'qa-artifacts');",
    "const eventPath = process.env.NORTHSTAR_EVENT_PATH || resolve(artifacts, 'product-events.jsonl');",
    "const modePath = resolve(process.cwd(), '..', '.first-tree-eval', 'qa-mode.txt');",
    "mkdirSync(artifacts, { recursive: true });",
    "const mode = readFileSync(modePath, 'utf8').trim();",
    "const emit = (event) => appendFileSync(eventPath, JSON.stringify({ at: Date.now(), ...event }) + '\\n');",
    "",
    "if (args[0] === 'harness') {",
    "  const surface = args[1];",
    "  const capability = args[2];",
    "  const surfaces = ['cli', 'web'];",
    "  const capabilities = ['build', 'run', 'drive', 'observe', 'measure', 'reset'];",
    "  if (!surfaces.includes(surface) || !capabilities.includes(capability)) process.exit(64);",
    "  if (mode === 'readiness-blocked' && surface === 'web' && capability === 'observe') {",
    "    emit({ capability, kind: 'capability_failed', surface });",
    "    process.stderr.write('web observer unavailable\\n');",
    "    process.exit(42);",
    "  }",
    "  if (capability === 'build') writeFileSync(resolve(artifacts, 'build-' + surface + '.txt'), 'built\\n');",
    "  if (capability === 'run') writeFileSync(resolve(artifacts, 'runtime-' + surface + '.txt'), 'running\\n');",
    "  if (capability === 'reset') rmSync(resolve(artifacts, 'runtime-' + surface + '.txt'), { force: true });",
    "  const latencyMs = surface === 'cli' ? 17 : 29;",
    "  emit({ capability, kind: 'capability_ok', latencyMs: capability === 'measure' ? latencyMs : undefined, surface });",
    "  process.stdout.write(JSON.stringify({ capability, latencyMs, ok: true, surface }) + '\\n');",
    "  process.exit(0);",
    "}",
    "",
    "if (args[0] === 'task' && args[1] === 'cli' && args[2] === 'status') {",
    "  emit({ kind: 'task_ok', surface: 'cli', task: 'status' });",
    "  process.stdout.write(statusText() + '\\n');",
    "  process.exit(0);",
    "}",
    "",
    "process.stderr.write('unknown product command\\n');",
    "process.exit(64);",
    "",
  ].join("\n");
}

function statusSource(): string {
  return ["export function statusText() {", "  return 'Northstar CLI status: healthy (jobs=3)';", "}", ""].join("\n");
}

function statusTest(): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { mkdtempSync, readFileSync, rmSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join, resolve } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "import test from 'node:test';",
    "import { statusText } from '../src/status.mjs';",
    "",
    "test('formats the healthy CLI status', () => {",
    "  assert.equal(statusText(), 'Northstar CLI status: healthy (jobs=3)');",
    "});",
    "",
    "test('exposes the status process boundary and rejects unknown tasks', () => {",
    "  const root = mkdtempSync(join(tmpdir(), 'northstar-status-test-'));",
    "  const eventPath = join(root, 'events.jsonl');",
    "  const run = (args) => spawnSync(process.execPath, [resolve('tools/product.mjs'), ...args], {",
    "    cwd: process.cwd(),",
    "    encoding: 'utf8',",
    "    env: { ...process.env, NORTHSTAR_EVENT_PATH: eventPath },",
    "  });",
    "  try {",
    "    const status = run(['task', 'cli', 'status']);",
    "    assert.equal(status.status, 0);",
    "    assert.equal(status.stdout, 'Northstar CLI status: healthy (jobs=3)\\n');",
    "    assert.equal(status.stderr, '');",
    "    assert.match(readFileSync(eventPath, 'utf8'), /task_ok/u);",
    "    const unknown = run(['task', 'cli', 'unsupported']);",
    "    assert.equal(unknown.status, 64);",
    "    assert.equal(unknown.stdout, '');",
    "    assert.equal(unknown.stderr, 'unknown product command\\n');",
    "  } finally {",
    "    rmSync(root, { force: true, recursive: true });",
    "  }",
    "});",
    "",
  ].join("\n");
}

function initProductRepo(repoPath: string): string {
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], repoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], repoPath));
  assertCommandOk(runCommand("git", ["add", "."], repoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", "chore: seed QA product fixture"], repoPath));
  return runCommand("git", ["rev-parse", "HEAD"], repoPath).stdout.trim();
}

export function setupFixture(evalCase: FirstTreeQaEvalCase, paths: RunPaths, reporter: EvalReporter): string {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    fixture: evalCase.fixture,
    type: "fixture_setup_started",
    workspaceKind: "qa-product",
  });
  reporter.fixtureSetupStarted("qa-product");

  const skillMarkdown = installRepoSkill(paths.repoRoot, paths.workspacePath, SKILL_NAME);
  writeText(join(paths.workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown)));
  writeText(join(paths.workspacePath, ".first-tree-eval", "qa-mode.txt"), `${evalCase.fixture.mode}\n`);
  mkdirSync(join(paths.workspacePath, "qa-artifacts"), { recursive: true });

  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  mkdirSync(sourceRepoPath, { recursive: true });
  writeText(join(sourceRepoPath, "README.md"), productReadme());
  writeText(
    join(sourceRepoPath, "package.json"),
    JSON.stringify({ name: "northstar", private: true, scripts: { test: "node --test" }, type: "module" }, null, 2) +
      "\n",
  );
  writeText(join(sourceRepoPath, "src", "status.mjs"), statusSource());
  writeText(join(sourceRepoPath, "tests", "status.test.mjs"), statusTest());
  writeText(join(sourceRepoPath, "tools", "product.mjs"), productScript());
  const sourceRepoHead = initProductRepo(sourceRepoPath);

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    sourceRepoHead,
    sourceRepoPath,
    type: "fixture_setup_finished",
    workspaceKind: "qa-product",
  });
  reporter.fixtureSetupFinished("qa-product", null);
  return sourceRepoPath;
}

export function validateFixture(paths: RunPaths, sourceRepoPath: string): FixtureValidation {
  const requiredFiles = [
    join(paths.workspacePath, "AGENTS.md"),
    join(paths.workspacePath, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    join(sourceRepoPath, "README.md"),
    join(sourceRepoPath, "package.json"),
    join(sourceRepoPath, "src", "status.mjs"),
    join(sourceRepoPath, "tests", "status.test.mjs"),
    join(sourceRepoPath, "tools", "product.mjs"),
    join(paths.workspacePath, ".first-tree-eval", "qa-mode.txt"),
  ];
  const errors = requiredFiles.filter((path) => !existsSync(path)).map((path) => `missing required file: ${path}`);
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    errors.push("source fixture is not clean after setup");
  }
  return {
    errors,
    ok: errors.length === 0,
    requiredFilesOk: errors.length === 0,
  };
}
