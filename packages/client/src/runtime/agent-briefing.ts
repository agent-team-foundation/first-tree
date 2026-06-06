import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import type { PredeclaredSourceRepo } from "./bootstrap.js";
import type { ChatContext } from "./chat-context.js";
import { renderChatContextSection } from "./chat-context-section.js";
import { getCliBinding } from "./cli-binding.js";
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
 * `<workspacePath>/CLAUDE.md` is a symlink to it, so Codex (which walks up
 * for `AGENTS.md`) and Claude Code (which loads `CLAUDE.md` via
 * `settingSources: ["project"]`) read the same content.
 *
 * Section order — stable per-agent content first, per-chat content last —
 * so the prompt cache stays warm across sibling chats of the same agent.
 * Issue #808 tracks moving the last block (Current Chat Context) off the
 * per-agent file entirely; until that lands it stays here at the bottom
 * so the rest of the briefing remains cacheable.
 *
 *   1. `# Identity`                            — per-agent
 *   2. `## Agent-Specific Prompt`              — per-agent config (`payload.prompt.append`)
 *   3. `# Working in First Tree`               — mostly static, with subsections:
 *        intro · Working Directory · Source Repositories · Worktrees ·
 *        Communication · Workspace Collaboration · Asking Humans ·
 *        Chat Topic · CLI Overview
 *   4. `# Required Reading`                    — tree-bound only; unconditional load of `first-tree` + `first-tree-context`
 *   5. `# Context Tree`                        — per binding, with subsections:
 *        Core Model · Reading the Tree · Writing the Tree · Tree Location
 *   6. `# Skills`                              — Team Skills (if any) + First Tree Family
 *   7. `## Current Chat Context`               — per-chat (issue #808 will move it out)
 */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  const sections: string[] = [];

  sections.push(identitySection(opts.identity));

  const agentPrompt = opts.payload?.prompt.append?.trim() ?? "";
  if (agentPrompt) {
    sections.push(`## Agent-Specific Prompt\n\n${agentPrompt}`);
  }

  sections.push(workingInFirstTreeSection({ agentHome: opts.workspacePath, sourceRepos: opts.sourceRepos }));

  // `# Required Reading` — sits AFTER `# Working in First Tree` so the
  // agent first reads the inline workspace-collab basics (chat send,
  // working directory, communication contract) it needs to operate at
  // all, then hits the hard mandate to load `first-tree` and
  // `first-tree-context` before doing any real work. Placing it
  // immediately before `# Context Tree` also keeps the mandate adjacent
  // to the content domains the two skills cover. Gated on
  // `contextTreePath !== null` for the same reason `skillsSection`
  // gates `firstTreeFamilyMap`: a tree-less agent has no First Tree
  // skill payloads installed on disk (`installFirstTreeIntegration`
  // is short-circuited in `agent-bootstrap.ts`), so mandating a load
  // would point at files that don't exist.
  const requiredReading = requiredReadingSection(opts.contextTreePath);
  if (requiredReading) sections.push(requiredReading);

  sections.push(contextTreeSection(opts.contextTreePath));

  const skillsBlock = skillsSection(opts.workspacePath, opts.payload, opts.contextTreePath);
  if (skillsBlock) sections.push(skillsBlock);

  // Per-chat block — last, until issue #808 moves it off the per-agent
  // file. `renderChatContextSection` returns null when the fetch degraded;
  // we omit the section entirely in that case.
  const chatBlock = renderChatContextSection(opts.chatContext);
  if (chatBlock) sections.push(chatBlock.trimEnd());

  return `${sections.join("\n\n")}\n`;
}

function identitySection(identity: AgentIdentity): string {
  const name = identity.displayName ?? identity.agentId;
  const kind = identity.visibility === "private" ? "a personal assistant agent" : "an autonomous agent";
  return `# Identity\n\nYou are ${name}, ${kind}.`;
}

// --- # Required Reading -----------------------------------------------------

/**
 * Hard mandate that the agent load `first-tree` and `first-tree-context`
 * before doing any non-trivial work, regardless of whether the user
 * mentioned chat / context keywords that would otherwise trigger
 * progressive disclosure.
 *
 * Rationale: the inline briefing is a routing index, not a substitute. The
 * skill payloads carry rules that are NOT duplicated here:
 *
 *  - `first-tree` ships the three-principal model, the Communication
 *    Principles in full (final-text contract / decision guide / silent
 *    turn / chat-context-missing fallback / channel-binary substitution),
 *    the Hosting-Daemon mental model and its do-not-stop-yourself
 *    invariant, the CLI Namespace Map, and the mandatory pre-task
 *    hygiene (workspace binding check / tree HEAD freshness / role-fork).
 *  - `first-tree-context` ships the Source-System Boundary, the Hard
 *    Rules 1-7 (default to not writing / read before write / smallest
 *    correct edit / no diffs / verify gate / ownership through humans /
 *    `decisionLocksCode`), the Double Test, Node Shape, and the
 *    Worked Examples.
 *
 * Both are gated on `contextTreePath !== null` because the runtime only
 * installs the SKILL.md payloads to disk when a Context Tree is bound
 * (see `runtime/first-tree-skills/installer.ts` and the short-circuit in
 * `agent-bootstrap.ts`). Telling a tree-less agent to load them would
 * point at files that aren't there.
 */
function requiredReadingSection(contextTreePath: string | null): string | null {
  if (contextTreePath === null) return null;
  return `# Required Reading

Before responding to any non-trivial instruction in this chat, you MUST
load both skills below — loading them **is** the first step of the
pre-task hygiene the \`first-tree\` skill itself describes. The
\`# Working in First Tree\` section above carries the minimum
mechanics you need to operate at all (final-text contract, chat send,
working directory, CLI surface); the skills below carry the durable
rules in full, with the inline briefing only summarising the slices
needed for those workspace-collab basics.

1. **\`first-tree\`** — what First Tree is, the three-principal model
   (Server / Client / Agent), the Communication Principles in full,
   the Hosting-Daemon mental model (and its do-not-stop-yourself
   invariant), the CLI Namespace Map, and the mandatory pre-task
   hygiene (workspace binding check / tree HEAD freshness / role-fork).
2. **\`first-tree-context\`** — what a Context Tree is, the
   source-system boundary, how to read the tree before acting, and
   the Hard Rules + Double Test that govern every tree write.

These two are unconditional. The remaining First Tree skill
(\`first-tree-sync\`) loads on demand based on the task signal as
listed in the First Tree Family map below.

Skipping either skill costs you the daemon-lifecycle invariants, the
full Communication Principles, the source-system boundary, and the
write-side Hard Rules + Double Test — content the inline briefing
either omits or only summarises. Acting without them is the #1
source of advice that conflicts with reality.`;
}

// --- # Working in First Tree -------------------------------------------------

type WorkingInFirstTreeOpts = {
  agentHome: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
};

function workingInFirstTreeSection(opts: WorkingInFirstTreeOpts): string {
  const bin = getCliBinding().binName;
  const blocks: string[] = [];

  blocks.push(`# Working in First Tree

You are running inside **First Tree**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input. Each message
  has a \`[From: <agent-name>]\` header — that name is what you pass back to
  \`chat send\`.
- **Your final response text is delivered to the chat for human observers to
  read. It does NOT wake other agents.** To make another agent take action,
  run \`${bin} chat send <name>\` explicitly.
- **Stay silent when you have nothing to add.** Not every message needs a
  reply. If you have nothing new for the recipient, output nothing and the
  runtime ends the turn.
- **Content rules (Issue #389):** pass content as a **raw string** — never
  \`JSON.stringify\` it first. Wrapping in outer quotes + \`\\n\` escapes
  produces a literal \`"@x ...\\n..."\` row that the UI cannot render as
  markdown.`);

  blocks.push(workingDirectoryBlock(opts.agentHome));

  if (opts.sourceRepos.length > 0) {
    blocks.push(sourceRepositoriesBlock(opts.sourceRepos));
  }

  blocks.push(worktreesBlock(opts.agentHome, opts.sourceRepos));
  blocks.push(communicationBlock(bin));
  blocks.push(workspaceCollaborationBlock(bin));
  blocks.push(askingHumansBlock());
  blocks.push(chatTopicBlock(bin));
  blocks.push(cliOverviewBlock(bin));

  return blocks.join("\n\n");
}

function workingDirectoryBlock(agentHome: string): string {
  return `## Working Directory

Your fixed working directory is \`${agentHome}\`. This directory is shared
by every chat you participate in for this agent — files you create in one
chat are visible from another. Operate accordingly:

- Refer to paths by their **absolute** form (the values listed below) so
  switching into a subdirectory does not break references.
- Treat the agent home as persistent state. Memory, caches, and notes
  accumulate across chats by design.`;
}

function sourceRepositoriesBlock(sourceRepos: ReadonlyArray<PredeclaredSourceRepo>): string {
  const lines: string[] = ["## Source Repositories", ""];
  lines.push(
    "The following repositories are pre-checked-out at the top level of your",
    "working directory as standalone clones. First Tree keeps each one current:",
    "at the start of every chat it fetches and — when the checkout is clean and",
    "not in use by another live session — brings it to the latest default branch.",
    "So unless it was left dirty or busy, the code here already reflects current",
    "`origin/<default>`. Use them for read-only orientation (grep, file layout,",
    "`git log`) and as the base for new worktrees (see below). Do **not** edit",
    "them in place or switch their branches — local changes block the auto-update,",
    "and the `worktrees/` flow is the place for any code work. Shared across",
    "every chat of this agent.",
  );
  lines.push("");
  for (const repo of sourceRepos) {
    const coords: string[] = [`url=${repo.url}`];
    if (repo.ref) coords.push(`ref=${repo.ref}`);
    if (repo.branch) coords.push(`branch=${repo.branch}`);
    lines.push(`- \`${repo.absolutePath}\`  (${coords.join(", ")})`);
  }
  return lines.join("\n");
}

function worktreesBlock(agentHome: string, sourceRepos: ReadonlyArray<PredeclaredSourceRepo>): string {
  // Per proposal §⑧ R3: use absolute paths in the snippet. LLMs sometimes
  // literal-copy `<placeholder>` strings, so only `<task-name>` and
  // `<new-branch>` are placeholders here — the home prefix is interpolated.
  return `## Worktrees

**No worktrees are pre-created.** Every new task starts by branching a
fresh worktree under \`${agentHome}/worktrees/<task-name>/\` off a freshly-
fetched \`origin/<base>\` — do not reuse the pre-checked-out path above.

\`\`\`bash
# from a source repo, e.g. ${sourceRepos[0]?.absolutePath ?? `${agentHome}/<source-repo>`}
git fetch origin
git worktree add ${agentHome}/worktrees/<task-name> -b <new-branch> origin/main
\`\`\`

Replace \`<task-name>\`, \`<new-branch>\`, and \`origin/main\` to fit. When
finished, the operator cleans up with \`git worktree remove\`.`;
}

function communicationBlock(bin: string): string {
  return `## Communication

Decision guide (based on participant \`type\` in the Current Chat Context block):

- Target is a **human** in this chat → your final text is enough; do not
  redundantly \`chat send\` (it just adds noise).
- Target is an **agent** in this chat → they will NOT see your final text
  as a wake signal. You MUST \`${bin} chat send <name>\` if you need them
  to act.
- No specific target (just narrating progress / thinking aloud) → final
  text only; no send needed.

**Fallback** (if the Current Chat Context block is missing — context
injection may have failed): use conservative mode — all cross-agent
collaboration goes through explicit \`chat send\`; do not rely on final
text to wake anyone.`;
}

function workspaceCollaborationBlock(bin: string): string {
  return `## Workspace Collaboration

For the full \`chat send\` / \`chat invite\` CLI usage — syntax, markdown /
stdin, reaching non-members, mention resolution — load the top-level
**\`first-tree\` skill** (and its \`references/agent-communication.md\`).
The skill's \`description\` triggers progressive disclosure whenever the
user mentions chat, daemon, agent config, or anything related to First
Tree.

Substitute \`${bin}\` for the literal \`first-tree\` in any examples you
read there — this agent's CLI binary on PATH is \`${bin}\`. **Tree-less
agents** (no Context Tree binding) won't have \`first-tree\` installed on
disk; the Communication block above is inline here for exactly that
reason — the sunk content is the long CLI mechanics, not the routing
rules.`;
}

function askingHumansBlock(): string {
  return `## Asking Humans

Asking a human is [pending redesign, 自行判断].`;
}

function chatTopicBlock(bin: string): string {
  return `## Chat Topic

The workspace chat list uses each chat's \`topic\` as its label. A good
topic is a short (≤ 30 chars) phrase that tells a teammate at a glance
what this chat is about — e.g. "调研 chat rename 方案" or "本周 ship 计划".

The current value is shown in the "Current Chat Context" block at the
bottom of this briefing as either an explicit \`Topic: <value>\` or the
sentinel \`Topic: (unset ...)\`.

**Two hard rules:**

1. **Topic is unset → set one before ending this turn.**
   When the context block shows \`Topic: (unset ...)\`, run:

       ${bin} chat set-topic "<short phrase>"

   The fallback label the workspace would otherwise show ("first 50 chars
   of the first message" / "alice, bob-bot") is rarely distinctive across
   many chats — naming the chat is a cheap win.

2. **Topic is set but no longer matches what this chat is about → update it.**
   Use judgment: don't churn the topic for minor digressions. Only run
   \`${bin} chat set-topic "<new phrase>"\` when a teammate scanning the
   workspace list would be misled by the current value.

**Exception: GitHub-sourced topics — leave them alone.**

Topics that look like \`PR repo#307: title\`, \`Issue repo#42\`, \`PR
Review repo#X: ...\`, \`Discussion repo#X\`, or \`Commit repo@sha\` were
auto-set by First Tree when the chat was minted from a GitHub event, and
First Tree keeps them in sync with the upstream PR/issue title.
Overriding them with your own label loses the repo / entity-id anchor
that makes the chat list useful. **Do not run \`set-topic\` on a chat
whose topic already has that shape.**`;
}

function cliOverviewBlock(bin: string): string {
  // Subcommand lists are the actually-registered ones, not aspirational —
  // every command named here must exist or the agent burns a turn on
  // `unknown command`. The `tree` namespace was retired in 2026-06 down
  // to just `verify` (cloud now owns workspace + tree provisioning; the
  // client runtime inlines its own skill payload install). The `org`
  // namespace is operator-only and not surfaced to in-agent use.
  return `## CLI Overview

The \`${bin}\` CLI spans two arms — **workspace collaboration** (talking
to people and other agents) and **context management** (the Context Tree):

| Namespace | What it owns |
|---|---|
| \`${bin} chat …\`   | messaging — \`send\`, \`invite\`, \`list\`, \`history\`, \`set-topic\` |
| \`${bin} agent …\`  | self-introspection — \`status\`, \`session\`, \`config show\` |
| \`${bin} daemon …\` | daemon (read-only from inside an agent) — \`status\`, \`doctor\` |
| \`${bin} tree verify\` | validate a Context Tree's structure (the only surviving \`tree\` subcommand) |

Operator-only (\`login\`, \`daemon install\`, \`agent create / bind\`,
workspace ↔ tree binding) runs from the web console or a human terminal
— **never from inside a running agent**. Full surface:
\`docs/cli-reference.md\`.`;
}

// --- # Context Tree ---------------------------------------------------------

function contextTreeSection(contextTreePath: string | null): string {
  const blocks: string[] = [];

  blocks.push(`# Context Tree

## Core Model

The Context Tree is the team's source of truth for **decisions,
constraints, ownership, and cross-domain relationships**. Execution
detail stays in source systems; the tree carries the *what* and *why*
you need to act correctly across repos and teams. Each domain is a
directory; each node is a markdown file with frontmatter (\`owners\`,
\`soft_links\`) plus the actual content.

For node anatomy, ownership tiers, and soft_link navigation, load
\`first-tree-context\`.`);

  blocks.push(`## Reading the Tree

**Read the tree before you act on any instruction — every task, even
ones that look like pure code, CLI, or review work.** An instruction is
underspecified on its own; in this org the tree supplies the background,
requirements, and constraints that make acting on it correct.

Always start at the tree's **root \`NODE.md\`** — the team's domain
directory. **If the root also contains an \`AGENT.md\`, read it too** —
it carries mandatory rules the org expects every agent to follow before
acting. From there, follow the index / \`soft_links\` down to the nodes
your task touches; Read, Grep, or list folders to get there.

Where the tree's requirements or constraints **conflict with the
instruction, the tree wins** — follow it and surface the conflict.
(Local memory is the opposite: it yields to the instruction.)

Read eagerly, not lazily — acting before reading is the #1 source of
advice that conflicts with reality. On scope shift to a new
domain/repo/owner, read those nodes first; in doubt, re-read.`);

  blocks.push(`## Writing the Tree

A chat is **fresh context** — the in-the-moment understanding you and
your teammates build while doing the work. The tree is **persistent
context** — the durable record the next agent will read in six months.
The moment your code PR is ready to land, the job is to translate fresh
context + the code change back into tree context, so the next agent
picks up where you left off.

The write trigger is **task completion** — the moment you're ready to
open the code PR. If the task touched decisions, constraints, ownership,
or cross-domain relationships, the **tree PR opens first, then the code
PR** — otherwise other agents keep acting on the old tree.
Implementation-only changes skip the tree write — not the read.

Before writing, you MUST load the relevant skill first and follow its
guidance:

| Task | Skill |
|---|---|
| Reflect one specific PR / doc / note into the tree | \`first-tree-context\` (Writing the Tree) |
| Broad drift audit (no specific source attached)    | \`first-tree-sync\`  |

Do not invent ad-hoc tree edits without loading the skill — the
operating guide covers staging, review routing, and ownership rules
you will not remember by default.`);

  if (contextTreePath) {
    blocks.push(`## Tree Location

The Context Tree for this workspace is at:

    ${contextTreePath}

Read its root \`NODE.md\` first to map the domains before you act.`);
  } else {
    // Tree-less stub. Binding a workspace to a tree is an operator
    // action (web console / human at the terminal), not something an
    // agent can self-serve — so surface the gap to a human instead of
    // suggesting any in-agent action. (The retired `first-tree-onboarding`
    // skill used to live here; PR following #844 deleted the skill +
    // the entire `first-tree tree` CLI namespace it depended on.)
    blocks.push(`## Tree Location

This agent has no Context Tree bound. If a task needs cross-domain
context that should be persistent (decisions, ownership), surface that
gap to a human — binding a workspace to a tree is an operator action
taken from the web console, not from inside a running agent.`);
  }

  return blocks.join("\n\n");
}

// --- # Skills (Skill Map) ---------------------------------------------------

function skillsSection(
  workspacePath: string,
  payload: AgentRuntimeConfigPayload | null,
  contextTreePath: string | null,
): string {
  // Per-agent resource skills (from agent_configs.payload.resourceSkills),
  // when present. The resource-skills helper emits its own `## Team Skills`
  // header so we can splice it under the new `# Skills` umbrella.
  const teamBlock = buildResourceSkillsBriefing(workspacePath, payload).trim();

  // First Tree family skills are gated on `contextTreePath` — they ship
  // via `installFirstTreeIntegration`, which `agent-bootstrap.ts` only
  // runs when a Context Tree is bound. Listing them for a tree-less
  // agent would tell it to load files that the runtime never put on disk
  // (`CORE_SKILL_NAMES` is empty, so no fallback install path either).
  const familyBlock = contextTreePath !== null ? firstTreeFamilyMap() : null;

  // Skip the `# Skills` umbrella entirely when both inner blocks are
  // empty — a bare header without rows is just visual noise.
  if (!teamBlock && !familyBlock) return "";

  const blocks: string[] = ["# Skills"];
  if (teamBlock) blocks.push(teamBlock);
  if (familyBlock) blocks.push(familyBlock);
  return blocks.join("\n\n");
}

function firstTreeFamilyMap(): string {
  // Listed skills MUST match what `installFirstTreeIntegration` actually
  // deploys (`runtime/first-tree-skills/installer.ts` →
  // `TREE_SKILL_NAMES`). Adding an aspirational row here would tell every
  // tree-bound agent to load a skill the runtime never puts on disk. A
  // unit test in `agent-briefing.test.ts` walks the repo's `skills/`
  // directory and asserts the names listed below match the shipped set;
  // `bundled-skill-list-sync.test.ts` additionally locks the installer
  // list against the prebuild copy script.
  return `## First Tree Family

\`first-tree\` and \`first-tree-context\` are **unconditional** — load
them on every task per \`# Required Reading\` above. The remaining
row loads on demand: each skill's \`description\` field drives
progressive disclosure when you mention its domain. For general /
harness skills (\`tdoc\`, \`review\`, \`simplify\`, \`update-config\`,
…) trust the auto-injected list.

| Skill | Load when |
|---|---|
| \`first-tree\`         | unconditional (see \`# Required Reading\`) — communication principles, pre-task hygiene, CLI namespace map |
| \`first-tree-context\` | unconditional (see \`# Required Reading\`) — read context before acting OR write tree updates from a specific PR / doc / note |
| \`first-tree-sync\`    | "is the tree up to date?" — broad drift audit, no source |`;
}

/**
 * Names of the First Tree skill payloads listed in the Skill Map. Exported
 * so the unit test can cross-check against the on-disk `skills/` directory
 * AND against `TREE_SKILL_NAMES` in
 * `runtime/first-tree-skills/installer.ts` (the single source of truth for
 * what the inline installer actually copies into the workspace). Drift
 * between these two lists would tell agents to load a skill that isn't
 * on disk; the cross-check test in `agent-briefing.test.ts` blocks that.
 */
export const FIRST_TREE_FAMILY_SKILL_NAMES = ["first-tree", "first-tree-context", "first-tree-sync"] as const;
