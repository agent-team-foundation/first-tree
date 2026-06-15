import { join } from "node:path";

import { appendEvent } from "../shared/events.js";
import {
  createFirstTreeShim,
  createRunPaths,
  type DomainNode,
  installSkill,
  validateFixture as validateSharedFixture,
  writeContextTreeFixture,
  writeText,
} from "../shared/fixture.js";
import type { EvalReporter } from "../shared/reporter.js";
import type { FirstTreeReadEvalCase, FixtureValidation, RunPaths } from "./types.js";

export { createFirstTreeShim, createRunPaths };

const DOMAIN_NODE_TARGET_COUNT = 100;
const SKILL_NAME = "first-tree-read";

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
  const skillDescription = installSkill(repoRoot, workspacePath, SKILL_NAME);
  writeText(join(workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(skillDescription));
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
  return [...systemNodes(), ...domainsNodes(), ...operationNodes()];
}

function writeReadContextTreeFixture(paths: RunPaths, evalCase: FirstTreeReadEvalCase): string {
  return writeContextTreeFixture(paths, {
    case: evalCase,
    domainNodeTargetCount: DOMAIN_NODE_TARGET_COUNT,
    generateDomainNodes,
    rootNodeMarkdown,
    sourceReadmeMarkdown: "# Source Repo\n\nSoftware source fixture for first-tree-read evals.\n",
    treeAgentsMarkdown,
    treeId: "first-tree-read-eval",
  });
}

export function setupFixture(evalCase: FirstTreeReadEvalCase, paths: RunPaths, reporter: EvalReporter): string | null {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    type: "fixture_setup_started",
    workspaceKind: evalCase.workspaceKind,
  });
  reporter.fixtureSetupStarted(evalCase.workspaceKind);

  installFirstTreeReadSkill(paths.repoRoot, paths.workspacePath);
  const contextTreePath =
    evalCase.workspaceKind === "context-tree" ? writeReadContextTreeFixture(paths, evalCase) : null;

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    contextTreePath,
    type: "fixture_setup_finished",
    workspaceKind: evalCase.workspaceKind,
  });
  reporter.fixtureSetupFinished(evalCase.workspaceKind, contextTreePath);

  return contextTreePath;
}

export function validateFixture(
  paths: RunPaths,
  contextTreePath: string | null,
  caseId: string,
  verbose: boolean,
  reporter: EvalReporter,
): FixtureValidation {
  return validateSharedFixture(paths, contextTreePath, caseId, verbose, reporter, DOMAIN_NODE_TARGET_COUNT);
}
