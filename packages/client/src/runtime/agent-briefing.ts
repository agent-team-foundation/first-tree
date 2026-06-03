import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { buildChatSystemPrompt, generateToolsDoc, type PredeclaredSourceRepo } from "./bootstrap.js";
import type { ChatContext } from "./chat-context.js";
import type { AgentIdentity } from "./handler.js";
import { buildResourceSkillsBriefing } from "./resource-skills.js";

export type BuildAgentBriefingOptions = {
  identity: AgentIdentity;
  payload: AgentRuntimeConfigPayload | null;
  chatContext: ChatContext | undefined;
  workspacePath: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
  contextTreePath: string | null;
};

/**
 * Build the unified agent briefing materialised at `<workspacePath>/AGENTS.md`.
 * `<workspacePath>/CLAUDE.md` is a symlink to it (see {@link ensureClaudeMdSymlink}),
 * so Codex (which walks up for `AGENTS.md`) and Claude Code (which loads
 * `CLAUDE.md` via `settingSources: ["project"]`) read the same content.
 *
 * One channel, all sections — no more split between a stable on-disk briefing
 * and a per-turn SDK `systemPrompt.append`. The hub-managed
 * `agent_configs.payload.prompt.append` lands here too, so admin updates take
 * effect on the next session start/resume via briefing rewrite (same semantics
 * Codex has carried since proposal §⓪.3).
 *
 * Section order (omit any block that has no content):
 *   1. `# Agent Identity`
 *   2. `## Agent-Specific Behavior`  (per-agent prompt.append)
 *   3. `# Working Directory Convention` + `## Source Repositories` +
 *      `## Creating Worktrees On Demand` + `## Current Chat Context`
 *      (built by {@link buildChatSystemPrompt})
 *   4. `## Operating Instructions` (AGENT.md), `## Organization Domain Map`
 *      (root NODE.md), `## Context Tree Location` — all gated on
 *      `contextTreePath !== null`
 *   5. `# First Tree Agent Runtime` ({@link generateToolsDoc})
 */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  const sections: string[] = [];

  sections.push(identitySection(opts.identity));

  const agentBehavior = opts.payload?.prompt.append?.trim() ?? "";
  if (agentBehavior) {
    sections.push(`## Agent-Specific Behavior\n\n${agentBehavior}`);
  }

  const skillsBlock = buildResourceSkillsBriefing(opts.workspacePath, opts.payload).trim();
  if (skillsBlock) {
    sections.push(skillsBlock);
  }

  const workingEnv = buildChatSystemPrompt({
    agentHome: opts.workspacePath,
    chatContext: opts.chatContext,
    sourceRepos: opts.sourceRepos,
  });
  if (workingEnv) sections.push(workingEnv);

  if (opts.contextTreePath) {
    const ctxSection = contextTreeSections(opts.contextTreePath);
    if (ctxSection) sections.push(ctxSection);
  }

  sections.push(generateToolsDoc().trim());

  return `${sections.join("\n\n")}\n`;
}

function identitySection(identity: AgentIdentity): string {
  const name = identity.displayName ?? identity.agentId;
  const kind = identity.visibility === "private" ? "a personal assistant agent" : "an autonomous agent";
  return `# Agent Identity\n\nYou are ${name}, ${kind}.`;
}

/**
 * Read AGENT.md / NODE.md directly from the bound Context Tree checkout. We
 * intentionally do not read the staged `.agent/context/` copies here because
 * the handler builds the briefing *before* `bootstrapWorkspace` runs (the
 * briefing then drives the AGENTS.md write that bootstrap performs). Reading
 * the live tree avoids a stale-copy window after upstream tree updates.
 */
function contextTreeSections(contextTreePath: string): string | null {
  const sections: string[] = [];

  const instructionsPath = join(contextTreePath, "AGENT.md");
  if (existsSync(instructionsPath)) {
    sections.push(`## Operating Instructions\n\n${readFileSync(instructionsPath, "utf-8").trim()}`);
  }

  const domainMapPath = join(contextTreePath, "NODE.md");
  if (existsSync(domainMapPath)) {
    sections.push(`## Organization Domain Map\n\n${readFileSync(domainMapPath, "utf-8").trim()}`);
  }

  sections.push(
    `## Context Tree Location\n\nThe full Context Tree is available at: \`${contextTreePath}\`\n\n` +
      "Read specific domain nodes as needed following the operating instructions above.",
  );

  return sections.length > 0 ? sections.join("\n\n") : null;
}
