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
import type { FirstTreeWriteEvalCase, FixtureValidation, RunPaths } from "./types.js";

export { createFirstTreeShim, createRunPaths };

const DOMAIN_NODE_TARGET_COUNT = 48;
const READ_SKILL_NAME = "first-tree-read";
const WRITE_SKILL_NAME = "first-tree-write";

function rootNodeMarkdown(): string {
  return `---
title: "First Tree Write Eval Context"
owners: [eval-owner]
---

# First Tree Write Eval Context

This deterministic Context Tree fixture contains several plausible server
auth and HTTP route nodes. Write evals should select the smallest correct
target after listing the tree hierarchy.
`;
}

function treeAgentsMarkdown(): string {
  return `# Eval Context Tree

This is a local deterministic Context Tree fixture for first-tree-write skill
evaluations.
`;
}

function workspaceAgentsMarkdown(skills: readonly { description: string; name: string }[]): string {
  const rows = skills.map((skill) => `| \`${skill.name}\` | ${skill.description} |`).join("\n");
  const writeDirective = skills.some((skill) => skill.name === WRITE_SKILL_NAME)
    ? `
When \`first-tree-write\` applies, load it by reading
\`.agents/skills/first-tree-write/SKILL.md\` before acting. Follow its workflow
exactly: use the source gate, run \`first-tree tree tree\` from the context repo
before selecting a target, read the target context, and make the intended write
target explicit before editing or proposing an edit.
`
    : "";
  const readDirective = skills.some((skill) => skill.name === READ_SKILL_NAME)
    ? `
When \`first-tree-read\` applies to a read-only lookup, load it by reading
\`.agents/skills/first-tree-read/SKILL.md\` before acting. Do not use the write
skill for read-only lookup prompts.
`
    : "";

  return `# Eval Workspace Instructions

Use installed skills only when the skill description applies to the user's
prompt. Do not load a write skill for read-only lookup prompts or prompts that
do not provide source material for a Context Tree mutation.

## Available Skills

| Skill | Load when |
|---|---|
${rows}
${writeDirective}${readDirective}
`;
}

function installWriteEvalSkills(repoRoot: string, workspacePath: string, evalCase: FirstTreeWriteEvalCase): void {
  const installed = [{ name: WRITE_SKILL_NAME, description: installSkill(repoRoot, workspacePath, WRITE_SKILL_NAME) }];
  if (evalCase.installedSkillSet === "read-write") {
    installed.unshift({ name: READ_SKILL_NAME, description: installSkill(repoRoot, workspacePath, READ_SKILL_NAME) });
  }
  writeText(join(workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(installed));
}

function coreNodes(): DomainNode[] {
  return [
    {
      path: "systems/server/auth/jwt",
      facts: [
        "User JWT auth is the unified authorization surface for Web/Admin API, CLI, and managed agents.",
        "Route handlers must re-check live organization membership before accepting cross-org actions.",
      ],
    },
    {
      path: "systems/server/auth/scopes",
      facts: [
        "Scopes describe allowed actions after user JWT identity is established; they do not replace live membership checks.",
      ],
    },
    {
      path: "systems/server/http/routes",
      facts: ["HTTP route paths and middleware classification follow docs/development/http-path-conventions.md."],
    },
    {
      path: "systems/server/http/middleware",
      facts: ["API route middleware maps user JWT auth failures before service-layer errors are exposed."],
    },
    {
      path: "systems/server/agents/binding",
      facts: ["Pinned agent relationships are runtime bindings, not durable authorization grants."],
    },
    {
      path: "systems/client/runtime/session",
      facts: ["Client daemon session state does not grant additional server authorization."],
    },
    {
      path: "systems/web/auth/login",
      facts: ["Web login issues the same user JWT used by CLI and managed agents."],
    },
    {
      path: "systems/cli/auth/login",
      facts: ["CLI login stores the user JWT in the channel home credentials file."],
    },
  ];
}

function fillerNodes(): DomainNode[] {
  const domains = ["data", "messaging", "resources", "context-tree", "observability"];
  const topics = [
    ["contracts", "invariants"],
    ["contracts", "edge-cases"],
    ["runtime", "happy-path"],
    ["runtime", "failure-mode"],
    ["storage", "shape"],
    ["interfaces", "cli"],
    ["interfaces", "web"],
    ["ownership", "review"],
  ];

  const nodes: DomainNode[] = [];
  for (const domain of domains) {
    for (const [group, topic] of topics) {
      nodes.push({
        facts: [`${domain} fixture context is present to make target selection non-trivial.`],
        path: `domains/${domain}/${group}/${topic}`,
      });
    }
  }
  return nodes;
}

export function generateDomainNodes(): readonly DomainNode[] {
  return [...coreNodes(), ...fillerNodes()];
}

function writeWriteContextTreeFixture(paths: RunPaths, evalCase: FirstTreeWriteEvalCase): string {
  return writeContextTreeFixture(paths, {
    case: evalCase,
    domainNodeTargetCount: DOMAIN_NODE_TARGET_COUNT,
    generateDomainNodes,
    rootNodeMarkdown,
    sourceReadmeMarkdown: "# Source Repo\n\nSoftware source fixture for first-tree-write evals.\n",
    treeAgentsMarkdown,
    treeId: "first-tree-write-eval",
  });
}

export function setupFixture(evalCase: FirstTreeWriteEvalCase, paths: RunPaths, reporter: EvalReporter): string | null {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    type: "fixture_setup_started",
    workspaceKind: evalCase.workspaceKind,
  });
  reporter.fixtureSetupStarted(evalCase.workspaceKind);

  installWriteEvalSkills(paths.repoRoot, paths.workspacePath, evalCase);
  const contextTreePath =
    evalCase.workspaceKind === "context-tree" ? writeWriteContextTreeFixture(paths, evalCase) : null;

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
