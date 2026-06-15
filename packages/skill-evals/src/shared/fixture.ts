import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { assertCommandOk, runCommand } from "./commands.js";
import { appendEvent, previewText } from "./events.js";
import type { EvalReporter } from "./reporter.js";
import { stripShimTraceLines } from "./reporter.js";
import type { CommandResult, FixtureValidation, RunPaths, SkillEvalCaseBase } from "./types.js";

export type DomainNode = {
  facts: readonly string[];
  path: string;
};

export type RequiredTreeFile = {
  path: string;
  reason: string;
};

export type InstalledSkill = {
  name: string;
};

export type ContextTreeFixtureOptions<TCase extends SkillEvalCaseBase> = {
  case: TCase;
  domainNodeTargetCount: number;
  generateDomainNodes: () => readonly DomainNode[];
  rootNodeMarkdown: () => string;
  sourceReadmeMarkdown: string;
  treeAgentsMarkdown: () => string;
  treeId: string;
};

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function parseSkillDescription(skillMarkdown: string): string {
  const match = skillMarkdown.match(/^description:\s*"?(.+?)"?\s*$/mu);
  return match?.[1] ?? "First Tree repo-local skill.";
}

export function installSkill(repoRoot: string, workspacePath: string, skillName: string): string {
  const sourceDir = join(repoRoot, "skills", skillName);
  const agentsDir = join(workspacePath, ".agents", "skills", skillName);
  const claudeDir = join(workspacePath, ".claude", "skills");
  const claudeLink = join(claudeDir, skillName);

  if (!existsSync(join(sourceDir, "SKILL.md"))) {
    throw new Error(`Missing source skill: ${sourceDir}`);
  }

  rmSync(agentsDir, { force: true, recursive: true });
  mkdirSync(dirname(agentsDir), { recursive: true });
  cpSync(sourceDir, agentsDir, { recursive: true });

  rmSync(claudeLink, { force: true, recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  symlinkSync(join("..", "..", ".agents", "skills", skillName), claudeLink, "dir");

  return parseSkillDescription(readFileSync(join(sourceDir, "SKILL.md"), "utf8"));
}

export function createRunPaths(packageRoot: string, evalCase: SkillEvalCaseBase, startedAt: string): RunPaths {
  const repoRoot = dirname(dirname(packageRoot));
  const stamp = startedAt.replace(/[-:.]/gu, "");
  const runRoot = join(packageRoot, ".runs", `${stamp}-${evalCase.id}`);
  const workspacePath = join(runRoot, "workspace");
  const binDir = join(runRoot, "bin");
  const shellEnvDir = join(runRoot, "shell-env");

  rmSync(runRoot, { force: true, recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(shellEnvDir, { recursive: true });

  return {
    binDir,
    eventsPath: join(runRoot, "events.jsonl"),
    packageRoot,
    repoRoot,
    runRoot,
    shellEnvDir,
    summaryJsonPath: join(runRoot, "summary.json"),
    summaryMdPath: join(runRoot, "summary.md"),
    workspacePath,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function writeShellPathBootstrap(paths: RunPaths): void {
  const bootstrap = `export PATH=${shellSingleQuote(paths.binDir)}:\${PATH:-}\n`;
  writeText(join(paths.shellEnvDir, ".zshenv"), bootstrap);
  writeText(join(paths.shellEnvDir, ".zprofile"), bootstrap);
  writeText(join(paths.shellEnvDir, ".bash_profile"), bootstrap);
  writeText(join(paths.shellEnvDir, "bash-env"), bootstrap);
  writeText(join(paths.shellEnvDir, "sh-env"), bootstrap);
}

export function createFirstTreeShim(paths: RunPaths): void {
  const tsxBin = join(paths.repoRoot, "node_modules", ".bin", "tsx");
  const cliEntry = join(paths.repoRoot, "apps", "cli", "src", "cli", "index.ts");
  const shimPath = join(paths.binDir, "first-tree");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const EVENTS_PATH = ${JSON.stringify(paths.eventsPath)};
const TSX_BIN = ${JSON.stringify(tsxBin)};
const CLI_ENTRY = ${JSON.stringify(cliEntry)};

function preview(value) {
  if (!value) return "";
  return value.length <= 4000 ? value : value.slice(0, 4000) + "...<truncated " + (value.length - 4000) + " chars>";
}

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function formatArg(arg) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(argv) {
  return argv.map(formatArg).join(" ");
}

function trace(message) {
  if (process.env.FIRST_TREE_EVAL_VERBOSE === "1") {
    const caseId = process.env.FIRST_TREE_EVAL_CASE_ID || "unknown";
    process.stderr.write("[" + caseId + "] " + message + "\\n");
  }
}

const argv = process.argv.slice(2);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
append({ type: "first_tree_call", phase, argv, cwd: process.cwd() });
trace("first-tree call: " + commandLine(argv));

const realCommand = process.env.FIRST_TREE_EVAL_REAL_FIRST_TREE || TSX_BIN;
const realArgs = process.env.FIRST_TREE_EVAL_REAL_FIRST_TREE ? argv : [CLI_ENTRY, ...argv];
const result = spawnSync(realCommand, realArgs, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode: 127,
    error: String(result.error),
    stdoutPreview: preview(result.stdout || ""),
    stderrPreview: preview(result.stderr || ""),
  });
  trace("first-tree result: exit=127 error=" + preview(String(result.error)));
  process.exit(127);
}

const exitCode = result.status == null ? 1 : result.status;
append({
  type: "first_tree_result",
  phase,
  argv,
  cwd: process.cwd(),
  exitCode,
  signal: result.signal || null,
  stdoutPreview: preview(result.stdout || ""),
  stderrPreview: preview(result.stderr || ""),
});
trace("first-tree result: exit=" + exitCode);

process.exit(exitCode);
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}

export function titleFromPath(path: string): string {
  return path
    .split("/")
    .map((part) =>
      part
        .split("-")
        .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
        .join(" "),
    )
    .join(" ");
}

export function nodeMarkdown(node: DomainNode): string {
  const facts =
    node.facts.length > 0
      ? node.facts.map((fact) => `- ${fact}`).join("\n")
      : "- This eval node provides software-domain context only.";

  return `---
title: "${titleFromPath(node.path)}"
owners: [eval-owner]
---

# ${titleFromPath(node.path)}

${facts}
`;
}

export function memberNodeMarkdown(): string {
  return `---
title: "eval-owner"
owners: [eval-owner]
type: human
role: "Evaluation fixture owner"
domains:
  - "software architecture"
  - "context tree"
---

# eval-owner

Owns the deterministic eval fixture.
`;
}

export function writeContextTreeFixture<TCase extends SkillEvalCaseBase>(
  paths: RunPaths,
  options: ContextTreeFixtureOptions<TCase>,
): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  mkdirSync(contextTreePath, { recursive: true });
  mkdirSync(sourceRepoPath, { recursive: true });

  writeText(
    join(paths.workspacePath, ".first-tree", "workspace.json"),
    `${JSON.stringify({ sources: ["source-repo"], tree: "context-tree" }, null, 2)}\n`,
  );
  writeText(join(sourceRepoPath, "README.md"), options.sourceReadmeMarkdown);

  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(contextTreePath, ".first-tree", "tree.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        treeId: options.treeId,
        treeMode: "dedicated",
        treeRepoName: "context-tree",
      },
      null,
      2,
    )}\n`,
  );
  writeText(join(contextTreePath, "NODE.md"), options.rootNodeMarkdown());
  writeText(join(contextTreePath, "AGENTS.md"), options.treeAgentsMarkdown());
  writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());

  const domainNodes = options.generateDomainNodes();
  if (domainNodes.length !== options.domainNodeTargetCount) {
    throw new Error(
      `Fixture generator produced ${domainNodes.length} nodes; expected ${options.domainNodeTargetCount}.`,
    );
  }

  for (const node of domainNodes) {
    writeText(join(contextTreePath, node.path, "NODE.md"), nodeMarkdown(node));
  }

  initializeGitRepo(paths, contextTreePath);
  return contextTreePath;
}

function initializeGitRepo(paths: RunPaths, contextTreePath: string): void {
  const originPath = join(paths.runRoot, "context-tree-origin.git");
  const commands: CommandResult[] = [
    runCommand("git", ["init", "--initial-branch=main"], contextTreePath),
    runCommand("git", ["config", "user.email", "eval@example.invalid"], contextTreePath),
    runCommand("git", ["config", "user.name", "First Tree Eval"], contextTreePath),
    runCommand("git", ["config", "commit.gpgsign", "false"], contextTreePath),
    runCommand("git", ["add", "."], contextTreePath),
    runCommand("git", ["commit", "-m", "chore: seed eval context tree"], contextTreePath),
    runCommand("git", ["init", "--bare", originPath], paths.runRoot),
    runCommand("git", ["remote", "add", "origin", originPath], contextTreePath),
    runCommand("git", ["push", "-u", "origin", "main"], contextTreePath),
  ];

  for (const result of commands) {
    assertCommandOk(result);
  }
}

function requiredTreeFiles(contextTreePath: string): readonly RequiredTreeFile[] {
  return [
    { path: join(contextTreePath, ".first-tree", "VERSION"), reason: "framework version" },
    { path: join(contextTreePath, ".first-tree", "tree.json"), reason: "tree identity" },
    { path: join(contextTreePath, "NODE.md"), reason: "root node" },
    { path: join(contextTreePath, "members", "eval-owner", "NODE.md"), reason: "member node" },
    { path: join(contextTreePath, "AGENTS.md"), reason: "tree instructions" },
  ];
}

function collectNodeDirs(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    const entries = existsSync(dir) ? readdirSafe(dir) : [];
    for (const entry of entries) {
      const child = join(dir, entry);
      if (entry.startsWith(".") || entry === "node_modules") continue;
      if (!isDirectory(child)) continue;
      if (existsSync(join(child, "NODE.md"))) {
        const relPath = relative(root, child).replace(/\\/gu, "/");
        if (!relPath.startsWith("members/")) found.push(relPath);
      }
      walk(child);
    }
  }
  walk(root);
  return found.sort();
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function validateFixture(
  paths: RunPaths,
  contextTreePath: string | null,
  caseId: string,
  verbose: boolean,
  reporter: EvalReporter,
  domainNodeTargetCount: number,
): FixtureValidation {
  if (contextTreePath === null) {
    reporter.fixtureValidationSkipped();
    return {
      domainNodeCount: 0,
      errors: [],
      minDepthOk: true,
      ok: true,
      requiredFilesOk: true,
      verifyResult: null,
    };
  }

  const errors: string[] = [];
  const nodeDirs = collectNodeDirs(contextTreePath);
  const minDepthOk = nodeDirs.every((path) => path.split("/").length >= 3);
  const missingFiles = requiredTreeFiles(contextTreePath).filter((file) => !existsSync(file.path));
  const requiredFilesOk = missingFiles.length === 0;

  if (nodeDirs.length !== domainNodeTargetCount) {
    errors.push(`expected ${domainNodeTargetCount} domain nodes, found ${nodeDirs.length}`);
  }
  if (!minDepthOk) {
    errors.push("all domain node paths must have depth >= 3 below the context tree root");
  }
  for (const missing of missingFiles) {
    errors.push(`missing ${missing.reason}: ${missing.path}`);
  }

  const verifyResult = runFixtureVerify(paths, contextTreePath, caseId, verbose, reporter);
  if (verifyResult.exitCode !== 0) {
    errors.push(
      `tree verify failed with exit ${verifyResult.exitCode}: ${previewText(verifyResult.stderr || verifyResult.stdout)}`,
    );
  }

  return {
    domainNodeCount: nodeDirs.length,
    errors,
    minDepthOk,
    ok: errors.length === 0,
    requiredFilesOk,
    verifyResult,
  };
}

function runFixtureVerify(
  paths: RunPaths,
  contextTreePath: string,
  caseId: string,
  verbose: boolean,
  reporter: EvalReporter,
): CommandResult {
  const args = ["tree", "verify", "--tree-path", contextTreePath];
  appendEvent(paths.eventsPath, {
    contextTreePath,
    type: "fixture_validation_started",
  });
  reporter.fixtureValidationStarted(args, contextTreePath);

  const env = {
    ...process.env,
    FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
    FIRST_TREE_EVAL_CASE_ID: caseId,
    FIRST_TREE_EVAL_PHASE: "fixture_validation",
    FIRST_TREE_EVAL_VERBOSE: verbose ? "1" : "0",
    PATH: `${paths.binDir}:${process.env.PATH ?? ""}`,
  };
  const result = spawnSync("first-tree", args, {
    cwd: paths.workspacePath,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  reporter.shimTraceLines(stderr);

  const commandResult: CommandResult = {
    args,
    command: "first-tree",
    cwd: paths.workspacePath,
    exitCode: result.status ?? 1,
    stderr: stripShimTraceLines(stderr),
    stdout,
  };

  appendEvent(paths.eventsPath, {
    exitCode: commandResult.exitCode,
    stderrPreview: previewText(commandResult.stderr),
    stdoutPreview: previewText(commandResult.stdout),
    type: "fixture_validation_finished",
  });
  reporter.fixtureValidationFinished(commandResult);

  return commandResult;
}
