import {
  AGENT_BRIEFING_GENERATED_MARKER,
  type AgentRuntimeConfigPayload,
  type PromptSection,
} from "@first-tree/shared";
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
 * Every heading carries a provenance tag so a reader (human or agent) can
 * tell which source owns each section and where to edit it — this is the
 * defense against the "copied the assembled file back into the per-agent
 * prompt" failure mode, together with the generated-file banner at the top.
 *
 *   0. generated-file banner                   — `first-tree:generated` marker + edit map
 *   1. `# Identity`                            — per-agent
 *   2. `# Team Prompt (team-shared — read-only for agents)`
 *                                              — team prompt resources (`prompt.sections`, scope `team`)
 *   3. `# Agent Prompt (this agent only — editable)`
 *                                              — per-agent fragment (`prompt.sections`, scope `agent`,
 *                                                `editable: true`); legacy servers without sections
 *                                                fall back to `## Agent-Specific Prompt` carrying
 *                                                `prompt.append`
 *   3b. `# Agent Prompt Overrides (this agent only — managed via resource bindings)`
 *                                              — agent-scope rows `prompt set` does NOT own
 *                                                (inline replacements of team prompts)
 *   4. `# Working in First Tree (First Tree Managed)` — mostly static, with subsections:
 *        intro · Working Directory · Source Repositories · Worktrees ·
 *        Communication · Workspace Collaboration · GitHub Entity Attention ·
 *        Asking Humans · Chat Topic & Description · CLI Overview
 *   5. `# Required Reading (First Tree Managed)` — tree-bound only; unconditional load of `first-tree` + `first-tree-context`
 *   6. `# Context Tree (First Tree Managed)`   — per binding, with subsections:
 *        Core Model · Reading the Tree · Writing the Tree · Tree Location
 *   7. `# Skills (First Tree Managed)`         — Team Skills (if any) + First Tree Family
 *   8. `## Current Chat Context (First Tree Managed, per-chat)` — per-chat (issue #808 will move it out)
 */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  const sections: string[] = [];

  sections.push(generatedBannerSection(getCliBinding().binName));
  sections.push(identitySection(opts.identity));

  const promptSections = opts.payload?.prompt.sections ?? [];
  const teamPromptBlock = teamPromptSection(promptSections);
  if (teamPromptBlock) sections.push(teamPromptBlock);
  const agentPromptBlock = agentPromptSection(promptSections, opts.identity, getCliBinding().binName);
  if (agentPromptBlock) sections.push(agentPromptBlock);
  const overridesBlock = agentPromptOverridesSection(promptSections);
  if (overridesBlock) sections.push(overridesBlock);
  if (!teamPromptBlock && !agentPromptBlock && !overridesBlock) {
    // Legacy server without structured sections — keep the old single-blob
    // rendering. The blob may mix team and agent content, so it must NOT be
    // presented under the editable `# Agent Prompt` heading.
    const legacyPrompt = opts.payload?.prompt.append?.trim() ?? "";
    if (legacyPrompt) sections.push(`## Agent-Specific Prompt\n\n${legacyPrompt}`);
  }

  sections.push(
    workingInFirstTreeSection({
      agentHome: opts.workspacePath,
      sourceRepos: opts.sourceRepos,
      contextTreePath: opts.contextTreePath,
    }),
  );

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

// --- generated-file banner ---------------------------------------------------

/**
 * Fixed banner at the very top of the briefing. Serves two audiences at
 * once: a reader (human or agent) opening the file learns it is a generated
 * artifact and where each editable section actually lives, and the literal
 * `first-tree:generated` marker (AGENT_BRIEFING_GENERATED_MARKER) lets the
 * server and CLI reject prompt writes that paste this file back into
 * config. Content is fully static per channel so the prompt cache stays
 * warm.
 */
function generatedBannerSection(bin: string): string {
  return `<!-- ======================================================================
  ${AGENT_BRIEFING_GENERATED_MARKER} — this file is rebuilt by the First Tree runtime at
  every session start. NEVER copy this file, in whole or in part, back into
  any prompt configuration.

  Where each section comes from, and where to edit it:
    # Team Prompt   → team prompt resources (Cloud → Org Settings →
                      Resources); managed by team admins; read-only here
    # Agent Prompt  → this agent's own prompt fragment;
                      read:  ${bin} agent config prompt show <agent> --raw
                      write: ${bin} agent config prompt set <agent> -f <file>
    # Agent Prompt Overrides → agent-specific resource bindings that
                      replace team prompts; managed in Cloud, NOT via
                      prompt set
  Every other section is First Tree Managed — injected by the runtime and
  not editable through any prompt configuration.
====================================================================== -->`;
}

// --- # Team Prompt / # Agent Prompt -------------------------------------------

/**
 * Team-shared prompt resources, rendered under their own provenance-labelled
 * heading. Before this split, team prompt bodies were nested under
 * `## Agent-Specific Prompt` — which is exactly what trained agents to copy
 * team content into their per-agent fragment when asked to edit their own
 * prompt.
 */
function teamPromptSection(promptSections: ReadonlyArray<PromptSection>): string | null {
  const team = promptSections.filter((section) => section.scope === "team" && section.body.trim().length > 0);
  if (team.length === 0) return null;
  const blocks: string[] = [
    "# Team Prompt (team-shared — read-only for agents)",
    `*Source: team prompt resources, managed by team admins in Cloud → Org
Settings → Resources. Shared across agents — do NOT copy any of this into
your per-agent prompt.*`,
  ];
  for (const section of team) {
    blocks.push(`## ${section.name.trim() || "Team prompt"}\n\n${section.body.trim()}`);
  }
  return blocks.join("\n\n");
}

/** The agent's own editable prompt fragment — the ONLY section a prompt edit should produce. */
function agentPromptSection(
  promptSections: ReadonlyArray<PromptSection>,
  identity: AgentIdentity,
  bin: string,
): string | null {
  // Only rows the `prompt show --raw` / `prompt set` round-trip actually owns
  // may appear under an "editable" heading — agent-scope rows without
  // `editable: true` (inline replacements of team prompts) go to
  // `agentPromptOverridesSection` instead.
  const own = promptSections.filter(
    (section) => section.scope === "agent" && section.editable === true && section.body.trim().length > 0,
  );
  if (own.length === 0) return null;
  // agentId is the CLI-addressable name (display names may contain spaces,
  // which would break the copy-pasteable command examples below).
  const name = identity.agentId;
  const blocks: string[] = [
    "# Agent Prompt (this agent only — editable)",
    `*Source: this agent's own prompt fragment. Read it raw with
\`${bin} agent config prompt show ${name} --raw\`; replace it with
\`${bin} agent config prompt set ${name}\`. This is the ONLY section a
prompt edit should ever produce.*`,
  ];
  for (const section of own) {
    blocks.push(section.body.trim());
  }
  return blocks.join("\n\n");
}

/**
 * Agent-specific prompt rows that `prompt set` does NOT own — inline
 * replacements of team prompt resources (and any future agent-scoped prompt
 * resources). They get their own heading so the editable `# Agent Prompt`
 * section never claims content the `prompt show --raw` / `prompt set`
 * round-trip cannot touch.
 */
function agentPromptOverridesSection(promptSections: ReadonlyArray<PromptSection>): string | null {
  const overrides = promptSections.filter(
    (section) => section.scope === "agent" && section.editable !== true && section.body.trim().length > 0,
  );
  if (overrides.length === 0) return null;
  const blocks: string[] = [
    "# Agent Prompt Overrides (this agent only — managed via resource bindings)",
    `*Source: agent-specific resource bindings that replace team prompt
resources. NOT editable with \`prompt set\` — managed in Cloud → Org
Settings → Resources. Do NOT copy any of this into your per-agent
prompt.*`,
  ];
  for (const section of overrides) {
    blocks.push(`## ${section.name.trim() || "Agent prompt override"}\n\n${section.body.trim()}`);
  }
  return blocks.join("\n\n");
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
 *    Principles in full (decision guide / courtesy-send guard /
 *    channel-binary substitution), the Hosting-Daemon mental model
 *    and its do-not-stop-yourself invariant, the CLI Namespace Map,
 *    and the mandatory pre-task hygiene (workspace binding check /
 *    tree HEAD freshness / role-fork).
 *  - `first-tree-context` ships the Context Tree concept model, the
 *    Source-System Boundary, the authorship read-discipline, the Hard
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
  return `# Required Reading (First Tree Managed)

Before responding to any non-trivial instruction in this chat, you MUST
load both skills below — loading them **is** the first step of the
pre-task hygiene the \`first-tree\` skill itself describes. The
\`# Working in First Tree\` section above carries the minimum
mechanics you need to operate at all (chat send, working directory,
CLI surface); the skills below carry the durable rules in full, with
the inline briefing only summarising the slices needed for those
workspace-collab basics.

1. **\`first-tree\`** — what First Tree is, the three-principal model
   (Server / Client / Agent), the Communication Principles in full,
   the Hosting-Daemon mental model (and its do-not-stop-yourself
   invariant), the CLI Namespace Map, and the mandatory pre-task
   hygiene (workspace binding check / tree HEAD freshness / role-fork).
2. **\`first-tree-context\`** — what a Context Tree is, the
   source-system boundary, authorship read-discipline, and the Hard
   Rules + Double Test that govern every tree write.

These two are unconditional. The remaining First Tree skills
(\`first-tree-read\`, \`first-tree-sync\`) load on demand based on the
task signal as listed in the First Tree Family map below.

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
  contextTreePath: string | null;
};

function workingInFirstTreeSection(opts: WorkingInFirstTreeOpts): string {
  const bin = getCliBinding().binName;
  const blocks: string[] = [];

  blocks.push(`# Working in First Tree (First Tree Managed)

You are running inside **First Tree**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input. Each message
  has a \`[From: <agent-name>]\` header — that name is what you pass back to
  \`chat send\`.
- **Your output stream is your reasoning trace** — think, plan, and narrate
  there freely as you work. It runs on a separate channel from \`chat send\`.
  (Transitional system behavior: a non-empty final output is currently
  mirrored into chat history as a silent \`agent-final-text\` row that does
  NOT wake other agents. The mirror is on the runtime-retirement track
  (first-tree#941); the future direction is two fully decoupled channels
  with no mirror at all. Today the mirror is not a reach path — \`chat
  send\` is.)
- **To reach a teammate (human or agent), use \`${bin} chat send <name>\`** —
  this is the only delivery path you should rely on. Every message you want
  a teammate to see goes through it.
- **Don't fire a courtesy \`chat send\`.** Not every wake-up needs one back.
  If after reasoning there's nothing new for any teammate, end the turn
  without sending — a courteous "got it" between two agents is how loops
  start.
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
  blocks.push(githubAttentionBlock(bin, opts.contextTreePath !== null));
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

\`chat send\` is how you reach every teammate — human or agent. Decision
guide (based on participant \`type\` in the Current Chat Context block):

- **Reaching a human in this chat** — plain reply / status → \`${bin} chat
  send <name> "..."\`. Every reply directed at a human in this chat goes
  through \`chat send\`.
- **Asking a human** for a decision, approval, or answer → \`${bin} chat send
  <name> --request --question "..."\` (see \`## Asking Humans\`). This raises
  a tracked open question (red-dot / open-request count) the plain send
  does not.
- **Reaching an agent to make them act** → \`${bin} chat send <name> "..."\`.
  Agents only act on explicit \`chat send\`. If the agent is not already in
  this chat, first run \`${bin} chat invite <name>\`, then send normally. A
  stage or role handoff inside the same task stays in this chat; do not create
  a new chat just to move the task from one agent to another.
- **Starting separate work** → \`${bin} chat create --to <name> "..."\` only
  when the work should have its own task-conversation boundary.
- After an agent handoff, continue only independent work. If their reply is the
  only remaining input, end the turn and wait to be woken; do not poll status
  or escalate on delayed replies alone.
- **Don't fire a courtesy \`chat send\`.** If after reasoning there is nothing
  new for any teammate, end the turn without sending. Your output stream
  outside \`chat send\` is your reasoning trace — use it freely; the list
  above is exhaustive for the *send* side.

Every \`chat send\` names a recipient — there is no no-mention send. A group
chat rejects a message that addresses no one; pass \`<name>\` to @mention the
recipient.`;
}

function workspaceCollaborationBlock(bin: string): string {
  return `## Workspace Collaboration

For the full \`chat send\` / \`chat invite\` CLI usage — every mode
(\`--request\` / \`--question\`), syntax,
markdown / stdin, reaching non-members, mention resolution — load the top-level
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

// Inline (not skill-only) on purpose: the follow-after-create default has to
// fire at PR/issue-creation time, and progressive disclosure of the
// `first-tree-github` skill only triggers when the agent already *thinks*
// about following. Without this always-present rule, agents create entities
// and never wire their event streams (the session-event auto-binder was
// deliberately removed in #979 — explicit declaration is the only entrance).
function githubAttentionBlock(bin: string, treeBound: boolean): string {
  // Tree-less agents have no First Tree skill payloads on disk
  // (`installFirstTreeIntegration` is gated on the tree binding), so the
  // full-guide pointer must not name the skill for them — the same
  // discipline `requiredReadingSection` and `firstTreeFamilyMap` follow.
  const fullGuide = treeBound
    ? `For the full decision guide — upstream-dependency follows, the \`409\` /
\`--rebind\` conflict flow, and the error contract — load the
\`first-tree-github\` skill.`
    : `For the full flag surface and conflict handling, see
\`${bin} github follow --help\` / \`${bin} github unfollow --help\`.`;

  return `## GitHub Entity Attention

Creating a PR or issue **never** follows it — no creation path
(\`gh pr create\`, curl, GitHub MCP, the web UI) wires anything for you,
and there is no auto-binding. Declaring the dependency is your job:

- **Default: follow what you create.** Immediately after creating a PR or
  issue — in the same breath as creation — wire it into the current chat:

      ${bin} github follow <url>

  Skip the follow only when the entity is clearly unrelated to this
  chat's task.
- **Unfollow when the human explicitly asks to stop tracking** the entity
  (\`${bin} github unfollow <entity>\`), or when the task's attention span
  on it has genuinely closed.

${fullGuide}`;
}

function askingHumansBlock(): string {
  const bin = getCliBinding().binName;
  return `## Asking Humans

When you need something only a human can give — a decision, sign-off, or an
answer — ask with a **structured request** instead of folding the question
into a plain \`chat send\`. A request raises a tracked open question on the
human's side (red-dot / open-question count) that stays until they answer;
a plain send does not.

\`\`\`bash
${bin} chat send <human> --request \\
  "<background/context the human needs to decide>" \\
  --question "<the single ask>" \\
  --option "<choice A>" --option "<choice B>"
\`\`\`

The body carries the context; \`--question\` is **only** the ask; \`--option\`
(repeatable) offers explicit choices. A request is **human-directed only** — the
server rejects \`--request\` unless the recipient is a human member, so you cannot
open a tracked question against another agent (reach agents with a plain \`chat
send <name>\`).

### When the human replies — discuss, then resolve

The human's reply comes back as an ordinary message. It does **not** clear the
red dot on its own, and neither does any plain reply you send back: replying
threads onto the question (a focused "chat about this" exchange) but leaves it
**open** so you can clarify back-and-forth without prematurely marking it
answered. The open question stays tracked until you **explicitly resolve** it.

Once you've got what you need, judge the reply and close the loop with one of:

\`\`\`bash
# You have the answer — resolve it and clear their red dot (body = the answer):
${bin} chat send <human> "<the confirmed answer>" --answer <requestId>

# The question no longer applies — withdraw it (body = the reason). Re-asking
# opens a NEW question; it never auto-supersedes the old one:
${bin} chat send <human> "<reason>" --close <requestId>
\`\`\`

\`<requestId>\` is the id of your original \`--request\` message. Only you (the
asker) or the human you asked may resolve it; if they answer cleanly in the web
UI, it's already cleared — no action needed.

Reach for a request on any real fork: needs approval, ambiguous requirements, a
safety-sensitive action, or any change to core data structures or the database.`;
}

function chatTopicBlock(bin: string): string {
  return `## Chat Topic & Description

Each chat carries two pieces of self-describing metadata, both set
through the **same** \`chat set-topic\` command:

- **topic** — a short (≤ 30 chars) label the workspace chat list shows,
  e.g. "调研 chat rename 方案" or "本周 ship 计划".
- **description** — a longer running summary of **what this piece of
  work is and where it currently stands**: the paragraph you (after a
  context reset) or a teammate reads to reconstruct the thread.

Both current values appear in the "Current Chat Context" block at the
bottom of this briefing as explicit \`Topic: <value>\` / \`Description:
<value>\` or the sentinel \`(unset ...)\`.

    ${bin} chat set-topic "<short label>"
    ${bin} chat set-topic --description "<current state>"
    ${bin} chat set-topic "<label>" --description "<state>"

**Only the chat's owner maintains these — and you count as the owner in
two cases:** (a) you created the chat, or (b) no agent owner is present —
a **human** created it (Web-created and GitHub-minted chats both work
this way) or the creating agent has since left. There every worker agent
in the chat counts as the owner and maintains these fields on the
owner's behalf. Only when **another agent** created the chat and is
still in it are you not the owner: you are **not** asked to set or
refresh them, and the command refuses you with a 403 — leave them to
that agent. Rules 1–2 below are the owner's duty; rules 3–4 apply to
everyone (reading a description to self-locate needs no ownership).

**Hard rules:**

1. **(Owner) Topic unset → set one before ending this turn.** The auto-derived
   fallback ("first 50 chars of the first message" / "alice, bob-bot")
   is rarely distinctive — naming the chat is a cheap win.

   **Once set, treat the topic as a stable anchor — do not rename it
   casually.** Users and agents locate a specific chat by its topic, so a
   chat that keeps changing names becomes hard to find again. Rename only
   when the topic is genuinely wrong or misleading because the chat's
   subject itself changed — never to track progress or reflect a passing
   focus. Progress belongs in the description, not the topic.

2. **(Owner) Description unset or stale → write or refresh it before ending
   this turn.** Unlike the topic, the description is **meant to move with
   the work** — refresh it freely as the state changes. It is the
   **present** state, not a log — rewrite it in
   place (the message history is the log), keep it within ~500
   characters. It must **name the current task** so anyone scanning
   \`${bin} chat list\` can tell from the description alone whether this
   chat is the one their task belongs to — lead with the concrete work
   ("reviewing PR #X"), not a vague restatement of the topic.

3. **Language follows the session's working language** — Chinese
   session, Chinese description; English session, English.

4. **Self-locate by reading descriptions.** When you wake unsure where
   a thread stands, or hold several chats and must choose what to
   advance, run \`${bin} chat list\` and read each description to
   reconstruct what you've done / what's in flight, then drill in with
   \`${bin} chat history <chat>\`. If you own the chat, refresh any
   description that no longer matches what the thread has actually done.

**Exception: GitHub-sourced topics — leave them alone.** Topics like
\`PR repo#307: title\`, \`Issue repo#42\`, \`Commit repo@sha\` are
auto-set and kept in sync by First Tree from the upstream entity;
overriding the topic loses the repo / entity-id anchor. This applies to
the **topic only** — the owner still maintains the description.`;
}

function cliOverviewBlock(bin: string): string {
  // Subcommand lists are the actually-registered ones, not aspirational —
  // every command named here must exist or the agent burns a turn on
  // `unknown command`. The `tree` namespace was retired in 2026-06 down
  // to validation (`verify`) and hierarchy browsing (`tree`). The `org`
  // namespace is operator-only and not surfaced to in-agent use.
  return `## CLI Overview

The \`${bin}\` CLI spans two arms — **workspace collaboration** (talking
to people and other agents) and **context management** (the Context Tree):

| Namespace | What it owns |
|---|---|
| \`${bin} chat …\`   | messaging — \`send\`, \`invite\`, \`list\`, \`history\`, \`set-topic\` |
| \`${bin} agent …\`  | self-introspection — \`status\`, \`session\`, \`config show\` |
| \`${bin} daemon …\` | daemon (read-only from inside an agent) — \`status\`, \`doctor\` |
| \`${bin} github …\` | GitHub entity attention — \`follow\` / \`unfollow\` / \`following\` an entity's event stream for the current chat |
| \`${bin} tree verify\` | validate a Context Tree's structure |
| \`${bin} tree tree\` | browse Context Tree nodes as a hierarchy |

Operator-only (\`login\`, \`daemon install\`, \`agent create / bind\`,
workspace ↔ tree binding) runs from the web console or a human terminal
— **never from inside a running agent**. Full surface:
\`docs/cli-reference.md\`.`;
}

// --- # Context Tree ---------------------------------------------------------

function contextTreeSection(contextTreePath: string | null): string {
  const blocks: string[] = [];

  blocks.push(`# Context Tree (First Tree Managed)

## Core Model

The Context Tree is the team's source of truth for **decisions,
constraints, ownership, and cross-domain relationships**. Execution
detail stays in source systems; the tree carries the *what* and *why*
you need to act correctly across repos and teams. Each domain is a
directory; each node is a markdown file with frontmatter (\`owners\`,
\`soft_links\`) plus the actual content.

For node anatomy, ownership tiers, and soft_link navigation, load
\`first-tree-context\`. For task-scoped file selection and operational
read workflow, load \`first-tree-read\`.`);

  blocks.push(`## Reading the Tree

**Read the tree before you act on any instruction — every task, even
ones that look like pure code, CLI, or review work.** An instruction is
underspecified on its own; in this org the tree supplies the background,
requirements, and constraints that make acting on it correct.

For the operational reader workflow, load \`first-tree-read\` and use
the hierarchy command it describes to select focused files. At minimum,
start at the tree's **root \`NODE.md\`** — the team's domain directory.
**If the root also contains an \`AGENTS.md\`, read it too** — it carries
mandatory rules the org expects every agent to follow before acting.
From there, follow the index / \`soft_links\` down to the nodes your
task touches.

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
or cross-domain relationships, **open the tree PR and the code PR
together and cross-link them in the PR descriptions**, so a reviewer on
the code PR can reach the decision and its rationale from the linked
tree PR; when review
reshapes the design, update both PRs together. The tree PR lands **with
the code PR or shortly after** — it need not merge first, but keep it
close so the tree never trails the merged code for long.
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
    // skill used to live here; PR following #844 deleted that provisioning
    // flow and the broad tree-management commands it depended on.)
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

  const blocks: string[] = ["# Skills (First Tree Managed)"];
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
rows load on demand: each skill's \`description\` field drives
progressive disclosure when you mention its domain. For general /
harness skills (\`tdoc\`, \`review\`, \`simplify\`, \`update-config\`,
…) trust the auto-injected list.

| Skill | Load when |
|---|---|
| \`first-tree\`         | unconditional (see \`# Required Reading\`) — communication principles, pre-task hygiene, CLI namespace map |
| \`first-tree-context\` | unconditional (see \`# Required Reading\`) — concept model, source-system boundary, and source-driven tree writes |
| \`first-tree-read\`    | read relevant Context Tree files before acting from task / path / feature signals |
| \`first-tree-sync\`    | "is the tree up to date?" — broad drift audit, no source |
| \`first-tree-seed\`    | empty tree only — one-shot bootstrap right after Cloud onboarding provisions the workspace; refuses on a populated tree |
| \`first-tree-github\`  | follow / unfollow a GitHub entity's event stream for the current chat — the follow-after-create DEFAULT is inline in \`## GitHub Entity Attention\` above; load for the full decision guide (upstream-dependency follows, \`409\` / \`--rebind\`, error contract) |`;
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
export const FIRST_TREE_FAMILY_SKILL_NAMES = [
  "first-tree",
  "first-tree-context",
  "first-tree-read",
  "first-tree-sync",
  "first-tree-seed",
  "first-tree-github",
] as const;
