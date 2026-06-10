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

import { appendEvent, previewText } from "./events.js";
import type { EvalReporter } from "./reporter.js";
import { stripShimTraceLines } from "./reporter.js";
import type { CommandResult, FirstTreeReadEvalCase, FixtureValidation, RunPaths } from "./types.js";

const DOMAIN_NODE_TARGET_COUNT = 100;
const SKILL_NAME = "first-tree-read";

type DomainNode = {
  facts: readonly string[];
  path: string;
};

type RequiredTreeFile = {
  path: string;
  reason: string;
};

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function runCommand(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    args,
    command,
    cwd,
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function assertCommandOk(result: CommandResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${result.command} ${result.args.join(" ")} failed with exit ${result.exitCode}\n${result.stderr}${result.stdout}`,
  );
}

function titleFromPath(path: string): string {
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

function nodeMarkdown(node: DomainNode): string {
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

function rootNodeMarkdown(): string {
  return `---
title: "First Tree Read Eval Context"
owners: [eval-owner]
---

# First Tree Read Eval Context

This deterministic Context Tree fixture contains only software engineering
domain knowledge. It intentionally omits cooking, poetry, lifestyle, and other
non-software facts so off-topic prompts should not need a tree read.
`;
}

function memberNodeMarkdown(): string {
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

function treeAgentsMarkdown(): string {
  return `# Eval Context Tree

This is a local deterministic Context Tree fixture for first-tree-read skill
evaluations.
`;
}

function workspaceAgentsMarkdown(skillDescription: string): string {
  return `# Eval Workspace Instructions

Use installed skills only when the skill description applies to the user's
prompt. Do not call \`first-tree\` for casual or non-software prompts.

## Available Skills

| Skill | Load when |
|---|---|
| \`first-tree-read\` | ${skillDescription} |

When \`first-tree-read\` applies, load it by reading
\`.agents/skills/first-tree-read/SKILL.md\` before acting. Follow the loaded
skill workflow exactly. In particular, if the skill instructs you to inspect a
\`first-tree\` help command, run that command rather than guessing flags.
`;
}

function parseSkillDescription(skillMarkdown: string): string {
  const match = skillMarkdown.match(/^description:\s*"?(.+?)"?\s*$/mu);
  return match?.[1] ?? "Read relevant Context Tree files for the current repo from task signals.";
}

function installFirstTreeReadSkill(repoRoot: string, workspacePath: string): void {
  const sourceDir = join(repoRoot, "skills", SKILL_NAME);
  const agentsDir = join(workspacePath, ".agents", "skills", SKILL_NAME);
  const claudeDir = join(workspacePath, ".claude", "skills");
  const claudeLink = join(claudeDir, SKILL_NAME);

  if (!existsSync(join(sourceDir, "SKILL.md"))) {
    throw new Error(`Missing source skill: ${sourceDir}`);
  }

  rmSync(agentsDir, { force: true, recursive: true });
  mkdirSync(dirname(agentsDir), { recursive: true });
  cpSync(sourceDir, agentsDir, { recursive: true });

  rmSync(claudeLink, { force: true, recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  symlinkSync(join("..", "..", ".agents", "skills", SKILL_NAME), claudeLink, "dir");

  const skillMarkdown = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  writeText(join(workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown)));
}

function systemNodes(): DomainNode[] {
  return [
    { path: "systems/server/auth/jwt", facts: ["User JWT auth is the unified authorization surface."] },
    {
      path: "systems/server/auth/scopes",
      facts: ["Route scopes must be checked against live organization membership before cross-org actions."],
    },
    {
      path: "systems/server/http/routes",
      facts: ["HTTP routes must follow the repo path conventions document before auth or multi-org changes."],
    },
    {
      path: "systems/server/http/middleware",
      facts: ["API middleware maps service errors to HTTP status codes; services throw typed errors."],
    },
    { path: "systems/server/data/drizzle", facts: ["Drizzle schemas are the source of persistent table shape."] },
    { path: "systems/server/data/migrations", facts: ["Never hand-edit Drizzle migrations; generate them."] },
    {
      path: "systems/client/runtime/session",
      facts: ["Agent sessions are hosted by the client daemon and should not stop or restart that daemon."],
    },
    {
      path: "systems/client/runtime/agent-slot",
      facts: ["Agent slots deduplicate at-least-once inbox delivery from the server boundary."],
    },
    {
      path: "systems/client/websocket/inbox",
      facts: ["Inbox delivery is the server/client boundary; the client pulls and deduplicates messages."],
    },
    {
      path: "systems/client/bootstrap/skills",
      facts: ["First Tree skill payloads are installed into .agents/skills with .claude/skills symlinks."],
    },
    {
      path: "systems/client/config/resources",
      facts: ["Resource skill materialization is separate from bundled First Tree family skills."],
    },
    {
      path: "systems/client/handlers/codex",
      facts: ["Codex handlers should preserve streamed events for debugging model behavior."],
    },
    {
      path: "systems/web/dashboard/resources",
      facts: ["The web dashboard presents resources as operational settings, not marketing pages."],
    },
    {
      path: "systems/web/dashboard/clients",
      facts: ["Client management views describe pinned machines and connection health."],
    },
    { path: "systems/web/auth/login", facts: ["Web and CLI share the same user JWT identity model."] },
    { path: "systems/web/api/admin", facts: ["Admin API calls use the same JWT scope rules as CLI-managed agents."] },
    { path: "systems/web/ui/state", facts: ["User-facing workflows should preserve predictable navigation state."] },
    {
      path: "systems/web/context/tree-panel",
      facts: ["Context Tree UI should surface tree binding and validation state without self-binding agents."],
    },
    {
      path: "systems/cli/commands/tree-verify",
      facts: ["Tree verify validates Context Tree structure; tree tree browses hierarchy for selectors."],
    },
    { path: "systems/cli/commands/org-bind", facts: ["Workspace tree binding is an operator action."] },
    { path: "systems/cli/commands/chat-send", facts: ["Agent-to-agent action requires explicit chat send."] },
    { path: "systems/cli/config/channel-home", facts: ["Development channel state lives under .first-tree-dev."] },
    { path: "systems/cli/packaging/dev-install", facts: ["scripts/dev-install.sh installs first-tree-dev and ftd."] },
    { path: "systems/cli/output/errors", facts: ["CLI errors should be explicit about cwd and attempted selector."] },
    { path: "systems/shared/schemas/config", facts: ["Shared Zod schemas are the single source of DTO truth."] },
    { path: "systems/shared/schemas/messages", facts: ["Message IDs use UUID v7 for time ordering."] },
    {
      path: "systems/shared/schemas/resources",
      facts: ["Resource payloads must be narrowed from unknown before use."],
    },
    { path: "systems/shared/types/agents", facts: ["Agents are server-managed identities bound to one client."] },
    { path: "systems/shared/config/channel", facts: ["Channel-aware CLI names must be substituted before execution."] },
    { path: "systems/shared/validation/zod", facts: ["Prefer Zod-derived types over handwritten DTO duplication."] },
  ];
}

function domainsNodes(): DomainNode[] {
  const domains = ["auth", "messaging", "context-tree", "resources", "observability"];
  const topics = [
    ["contracts", "invariants"],
    ["contracts", "edge-cases"],
    ["runtime", "happy-path"],
    ["runtime", "failure-mode"],
    ["storage", "shape"],
    ["storage", "ownership"],
    ["interfaces", "cli"],
    ["interfaces", "web"],
  ];
  const facts: Record<string, string> = {
    auth: "Auth facts are limited to JWT shape, route scopes, membership checks, and client binding.",
    "context-tree": "Context Tree reads should use the current workspace binding before selecting files.",
    messaging: "Messaging facts describe immutable messages, inbox fan-out, and client-side deduplication.",
    observability: "Observability facts prefer structured logs and level-managed diagnostics.",
    resources: "Resource facts describe encrypted adapter credentials and resource skill boundaries.",
  };

  const nodes: DomainNode[] = [];
  for (const domain of domains) {
    for (const [group, topic] of topics) {
      nodes.push({
        facts: [facts[domain] ?? "Domain facts are software-only."],
        path: `domains/${domain}/${group}/${topic}`,
      });
    }
  }
  return nodes;
}

function operationNodes(): DomainNode[] {
  const areas = ["runtime", "daemon", "e2e", "release", "debugging"];
  const topics = [
    ["safety", "invariants"],
    ["safety", "failure-mode"],
    ["workflow", "setup"],
    ["workflow", "verification"],
    ["diagnostics", "logs"],
    ["diagnostics", "metrics"],
  ];
  const facts: Record<string, string> = {
    daemon: "Daemon lifecycle commands that stop or restart the host must not be run by hosted agents.",
    debugging: "Debugging work should preserve raw event data so false positives can be inspected later.",
    e2e: "E2E workflows are opt-in and should stay outside default test scripts.",
    release: "Version fields are not edited by coding agents during feature work.",
    runtime: "Runtime changes should keep server, client, command, shared, and web boundaries independent.",
  };

  const nodes: DomainNode[] = [];
  for (const area of areas) {
    for (const [group, topic] of topics) {
      nodes.push({
        facts: [facts[area] ?? "Operation facts are software-only."],
        path: `operations/${area}/${group}/${topic}`,
      });
    }
  }
  return nodes;
}

export function generateDomainNodes(): readonly DomainNode[] {
  const nodes = [...systemNodes(), ...domainsNodes(), ...operationNodes()];
  if (nodes.length !== DOMAIN_NODE_TARGET_COUNT) {
    throw new Error(`Fixture generator produced ${nodes.length} nodes; expected ${DOMAIN_NODE_TARGET_COUNT}.`);
  }
  return nodes;
}

function writeContextTreeFixture(paths: RunPaths): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  mkdirSync(contextTreePath, { recursive: true });
  mkdirSync(sourceRepoPath, { recursive: true });

  writeText(
    join(paths.workspacePath, ".first-tree", "workspace.json"),
    `${JSON.stringify({ sources: ["source-repo"], tree: "context-tree" }, null, 2)}\n`,
  );
  writeText(join(sourceRepoPath, "README.md"), "# Source Repo\n\nSoftware source fixture for first-tree-read evals.\n");

  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(contextTreePath, ".first-tree", "tree.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        treeId: "first-tree-read-eval",
        treeMode: "dedicated",
        treeRepoName: "context-tree",
      },
      null,
      2,
    )}\n`,
  );
  writeText(join(contextTreePath, "NODE.md"), rootNodeMarkdown());
  writeText(join(contextTreePath, "AGENTS.md"), treeAgentsMarkdown());
  writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());

  for (const node of generateDomainNodes()) {
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

export function createRunPaths(packageRoot: string, evalCase: FirstTreeReadEvalCase, startedAt: string): RunPaths {
  const repoRoot = dirname(dirname(packageRoot));
  const stamp = startedAt.replace(/[-:.]/gu, "").replace("T", "T").replace("Z", "Z");
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

export function setupFixture(evalCase: FirstTreeReadEvalCase, paths: RunPaths, reporter: EvalReporter): string | null {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    type: "fixture_setup_started",
    workspaceKind: evalCase.workspaceKind,
  });
  reporter.fixtureSetupStarted(evalCase.workspaceKind);

  installFirstTreeReadSkill(paths.repoRoot, paths.workspacePath);
  const contextTreePath = evalCase.workspaceKind === "context-tree" ? writeContextTreeFixture(paths) : null;

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    contextTreePath,
    type: "fixture_setup_finished",
    workspaceKind: evalCase.workspaceKind,
  });
  reporter.fixtureSetupFinished(evalCase.workspaceKind, contextTreePath);

  return contextTreePath;
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

  if (nodeDirs.length !== DOMAIN_NODE_TARGET_COUNT) {
    errors.push(`expected ${DOMAIN_NODE_TARGET_COUNT} domain nodes, found ${nodeDirs.length}`);
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
