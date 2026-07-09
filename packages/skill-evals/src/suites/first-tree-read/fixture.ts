import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent, previewText } from "../../core/events.js";
import { runFixtureVerify } from "../../core/fixture-verify.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { CommandResult, RunPaths } from "../../core/types.js";
import type { FirstTreeReadEvalCase, FixtureValidation } from "./types.js";

const DOMAIN_NODE_TARGET_COUNT = 100;
const NAVIGATION_NODE_MARKER = "evalNodeKind: navigation";
const SKILL_NAME = "first-tree-read";
const RUNTIME_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-write",
  "first-tree-file-bug",
] as const;

type DomainNode = {
  facts: readonly string[];
  path: string;
};

type RequiredTreeFile = {
  path: string;
  reason: string;
};

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

function navigationNodeMarkdown(path: string): string {
  return `---
title: "${titleFromPath(path)}"
owners: [eval-owner]
${NAVIGATION_NODE_MARKER}
---

# ${titleFromPath(path)}

This navigation node exists so agents can browse this eval fixture by natural
Context Tree parent paths. Durable facts for grading live in descendant nodes.
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

function installFirstTreeReadSkill(repoRoot: string, workspacePath: string): void {
  const skillMarkdown = installRepoSkill(repoRoot, workspacePath, SKILL_NAME);
  writeText(join(workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown)));
}

function runtimeGeneratedWorkspaceAgentsMarkdown(
  workspacePath: string,
  contextTreePath: string,
  descriptions: ReadonlyMap<string, string>,
): string {
  const sourceRepoPath = join(workspacePath, "source-repo");
  const skillRows = RUNTIME_SKILL_NAMES.map(
    (skill) => `| \`${skill}\` | ${descriptions.get(skill) ?? "Use when this skill applies."} |`,
  ).join("\n");

  return `<!-- ======================================================================
  first-tree:generated — this file is rebuilt by the First Tree runtime at
  every session start. This eval fixture covers generated briefing shape and
  First Tree skill topology only; it is not a live First Tree Cloud E2E.
====================================================================== -->

# Identity

You are First Tree Read Eval Agent, a personal assistant agent.

# Working in First Tree (First Tree Managed)

Your fixed working directory is \`${workspacePath}\`. The runtime marker
\`.first-tree-workspace\` is the project-root boundary for provider sessions.

## Source Repositories

- \`${sourceRepoPath}\` (fixture source repo)

# Context Tree (First Tree Managed)

The current Context Tree checkout is \`${contextTreePath}\`.

## Context Tree Policy

The tree records durable decisions, constraints, ownership, and cross-domain
relationships; source repos record implementation detail. Default to normal
tree content as current truth. Treat archive/supporting and member content as
non-normal classes with narrower authority.

Read task-scoped tree context before acting on software project questions:

1. Read \`.agents/skills/first-tree-read/SKILL.md\`.
2. Inspect \`first-tree tree tree --help\`.
3. Use \`first-tree tree tree\` selectors before answering.

# Skills (First Tree Managed)

## First Tree Family

| Skill | Load when |
|---|---|
${skillRows}

All First Tree skills are installed in every workspace. Runtime metadata can
activate skills, but visible instructions still define when the agent should
load them.
`;
}

function writeClaudeBriefingSymlink(workspacePath: string): void {
  const claudeMdPath = join(workspacePath, "CLAUDE.md");
  rmSync(claudeMdPath, { force: true });
  symlinkSync("AGENTS.md", claudeMdPath);
}

function installRuntimeGeneratedBriefing(repoRoot: string, workspacePath: string, contextTreePath: string): void {
  const descriptions = new Map<string, string>();
  for (const skill of RUNTIME_SKILL_NAMES) {
    const skillMarkdown = installRepoSkill(repoRoot, workspacePath, skill);
    descriptions.set(skill, parseSkillDescription(skillMarkdown));
  }

  writeText(
    join(workspacePath, ".first-tree-workspace", "identity.json"),
    `${JSON.stringify(
      {
        agentId: "first-tree-read-eval-agent",
        contextTreePath,
        delegateMention: null,
        displayName: "First Tree Read Eval Agent",
        metadata: {},
        serverUrl: "https://example.invalid",
        type: "agent",
        visibility: "private",
      },
      null,
      2,
    )}\n`,
  );
  writeText(
    join(workspacePath, "AGENTS.md"),
    runtimeGeneratedWorkspaceAgentsMarkdown(workspacePath, contextTreePath, descriptions),
  );
  writeClaudeBriefingSymlink(workspacePath);
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

function navigationParentPaths(nodes: readonly DomainNode[]): readonly string[] {
  const paths = new Set<string>();
  for (const node of nodes) {
    const parts = node.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      paths.add(parts.slice(0, index).join("/"));
    }
  }
  return [...paths].sort();
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

  const domainNodes = generateDomainNodes();
  for (const parentPath of navigationParentPaths(domainNodes)) {
    writeText(join(contextTreePath, parentPath, "NODE.md"), navigationNodeMarkdown(parentPath));
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

export function setupFixture(evalCase: FirstTreeReadEvalCase, paths: RunPaths, reporter: EvalReporter): string | null {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    type: "fixture_setup_started",
    workspaceKind: evalCase.workspaceKind,
  });
  reporter.fixtureSetupStarted(evalCase.workspaceKind);

  const contextTreePath = evalCase.workspaceKind === "context-tree" ? writeContextTreeFixture(paths) : null;
  if (evalCase.briefingMode === "runtime-generated") {
    if (contextTreePath === null) {
      throw new Error("runtime-generated first-tree-read fixture requires a context-tree workspace.");
    }
    installRuntimeGeneratedBriefing(paths.repoRoot, paths.workspacePath, contextTreePath);
  } else {
    installFirstTreeReadSkill(paths.repoRoot, paths.workspacePath);
  }

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
      const nodeFilePath = join(child, "NODE.md");
      if (existsSync(nodeFilePath) && !isNavigationNode(nodeFilePath)) {
        const relPath = relative(root, child).replace(/\\/gu, "/");
        if (!relPath.startsWith("members/")) found.push(relPath);
      }
      walk(child);
    }
  }
  walk(root);
  return found.sort();
}

function isNavigationNode(nodeFilePath: string): boolean {
  try {
    return readFileSync(nodeFilePath, "utf8").includes(NAVIGATION_NODE_MARKER);
  } catch {
    return false;
  }
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

  const verifyResult = runFixtureVerify({ caseId, contextTreePath, paths, reporter, verbose });
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
