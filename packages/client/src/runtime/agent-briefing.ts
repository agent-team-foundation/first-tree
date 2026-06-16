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

/**
 * Wrap an arbitrary string in POSIX-safe single quotes so it can be pasted
 * into a shell verbatim. Embedded single quotes are escaped by closing the
 * quoted block, inserting an escaped quote, and reopening — the canonical
 * shell-quoting form. Used everywhere a runtime-resolved value (path, URL,
 * branch) gets interpolated into a command the agent is told to run; without
 * this a branch name with a space or `$`, or a path with shell metacharacters,
 * would render a broken command (PR #1048 review — baixiaohang #4 / S5).
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type BuildAgentBriefingOptions = {
  identity: AgentIdentity;
  payload: AgentRuntimeConfigPayload | null;
  chatContext: ChatContext | undefined;
  workspacePath: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
  contextTreePath: string | null;
  /**
   * Upstream coordinates of the Context Tree the agent maintains at
   * `contextTreePath`. Required by the agent-managed clone protocol the
   * briefing injects (clone-if-missing needs the URL + branch). `null` /
   * omitted when the agent is tree-less.
   */
  contextTreeRepoUrl?: string | null;
  contextTreeBranch?: string | null;
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
  const requiredReading = requiredReadingSection(opts.contextTreePath, opts.workspacePath);
  if (requiredReading) sections.push(requiredReading);

  sections.push(
    contextTreeSection(opts.contextTreePath, opts.contextTreeRepoUrl ?? null, opts.contextTreeBranch ?? null),
  );

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
function requiredReadingSection(contextTreePath: string | null, workspacePath: string): string | null {
  if (contextTreePath === null) return null;
  const firstTreeSkillPath = `${workspacePath}/.agents/skills/first-tree/SKILL.md`;
  const contextSkillPath = `${workspacePath}/.agents/skills/first-tree-context/SKILL.md`;
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

If your runtime does not automatically inject the full skill body after
selecting a skill from the skill listing, read the local payload files
directly before acting:

- \`${firstTreeSkillPath}\`
- \`${contextSkillPath}\`

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
  const lines: string[] = ["## Source Repositories (agent-managed, bare)", ""];
  lines.push(
    "The following repositories are declared for this agent at the listed",
    "paths. **You manage these clones yourself** — First Tree never runs git",
    "on your behalf (no auto-clone, no auto-update):",
  );
  lines.push("");
  for (const repo of sourceRepos) {
    const coords: string[] = [`url=${repo.url}`];
    if (repo.ref) coords.push(`ref=${repo.ref}`);
    if (repo.branch) coords.push(`branch=${repo.branch}`);
    lines.push(`- \`${repo.absolutePath}\`  (${coords.join(", ")})`);
  }
  lines.push("");
  lines.push(
    "Each path is a **bare** clone — a git object store with no working",
    "tree. You never read or write files at the clone path directly;",
    "**every read AND write happens inside a worktree** you create off it",
    "(see `## Worktrees`). Bare is deliberate: with no checked-out files",
    "the clone can never go stale-mislead or dirty, and concurrent chats",
    "can't trip over a shared working tree.",
    "",
    "Management protocol (shared by every chat of this agent):",
    "",
    "1. **Ensure** — if a listed path is missing, create it as a bare clone.",
    "   Each listed path is an immediate child of your workspace's",
    "   `source-repos/` directory (`<workspace>/source-repos/<name>`). Create the",
    "   `source-repos/` parent first, then clone into it:",
    "",
    "   ```bash",
    '   mkdir -p "$(dirname <path>)"   # ensure the source-repos/ parent exists',
    "   git clone --bare <url> <path>",
    "   git -C <path> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'",
    "   git -C <path> fetch origin",
    "   ```",
    "",
    "   The refspec + fetch populate `refs/remotes/origin/*` so worktrees can",
    "   branch off `origin/<default>`.",
    "2. **Verify before reuse — fail closed on a repo mismatch.** If the path",
    "   **already exists**, do NOT blindly reuse it. The same `localPath` can be",
    "   repointed to a different `url` in config, so first confirm the existing",
    "   clone is the SAME repo as the declared `url` above:",
    "",
    "   ```bash",
    "   git -C <path> remote get-url origin",
    "   ```",
    "",
    "   Compare that to the declared `url` canonically (ignore a trailing",
    "   `.git` and the http/https/ssh form). **If it matches**, reuse the clone",
    "   as-is — never delete or re-clone it (sibling chats may hold worktrees",
    "   rooted in it). **If it does NOT match** — the directory was cloned from",
    "   a different repo — STOP: do not fetch, do not add a worktree, and do",
    "   NOT delete, re-clone, or re-point it (a sibling chat may have a worktree",
    "   on the old repo). Report the mismatch to a human in the chat (declared",
    "   `url` vs. the clone's actual `origin`) and stop using that source until",
    "   they resolve it. Silently serving worktrees off the wrong repo is the",
    "   exact failure this guard exists to prevent.",
    "3. **Refresh** — once the clone is confirmed to match (or you just created",
    "   it), before creating any worktree run `git -C <path> fetch origin` so",
    "   `origin/<default>` is current.",
    "4. **Read through a worktree, not the clone path.** A bare clone has no",
    "   files to read. To read source — `grep`, `cat`, `git log`, or a",
    "   shipped skill scan (`first-tree-seed`, `first-tree-sync`) — create a",
    "   read worktree off `origin/<default>` (or the pinned `ref`), read",
    "   inside it, and remove it when done. To write, create a task worktree",
    "   on a new branch. Both flows are in `## Worktrees`.",
    "5. **Credential failures are reportable events** — if clone/fetch fails",
    "   with an auth error, tell a human in the chat what failed and continue",
    "   with what you have locally; do not retry silently.",
  );
  lines.push(
    "",
    "**One-time legacy-layout migration — do this once, and only in your",
    "OWN workspace.** Some agents were first provisioned with a single",
    "**non-bare** checkout as an immediate child of the workspace root",
    "(`<workspace>/<source-name>`) instead of a bare clone under",
    "`source-repos/`, often with task worktrees hanging off it. If you find",
    "one, migrate it — never reach into a sibling agent's workspace. Create",
    "the bare clone per **Ensure** above (its new home is",
    "`<workspace>/source-repos/<source-name>`), then retire the legacy",
    "checkout.",
    "",
    "Retiring is irreversible, so clear **two** bars in order before",
    "touching anything. First a **path preflight** that proves the target is",
    "exactly the intended legacy checkout — derived from the manifest, not a",
    "hand-typed path. Only if that passes do the **git-state gates** prove",
    "the checkout holds no unmigrated work. The preflight matters because a",
    "mistaken target (the workspace root, `context-tree`, `source-repos`,",
    "`worktrees`, `.first-tree`, an unbound sibling, or another repo that is",
    "also clean + merged) would otherwise sail through the git-state gates",
    "and get the wrong data quarantined.",
    "",
    "Path preflight — resolve the workspace root from its manifest, derive",
    "`$legacy` from the declared source name, and validate it. The per-source",
    "calls at the end are baked from your manifest; act only on a `$legacy`",
    "that printed `ok:`:",
    "",
    "```bash",
    "# Resolve the workspace root from its manifest — never hand-type it.",
    "WS=; d=$PWD",
    'while [ "$d" != / ]; do',
    '  [ -f "$d/.first-tree/workspace.json" ] && { WS=$(realpath "$d"); break; }',
    '  d=$(dirname "$d")',
    "done",
    '[ -n "$WS" ] || echo "stop: no .first-tree/workspace.json at or above $PWD"',
    "",
    "# Canonicalize a GitHub remote URL to host/path so the `.git` suffix and",
    "# the https/http/ssh/git/scp transport forms all compare equal (the same",
    "# canonical match the reuse guard above requires, per #1086).",
    "canon_url() {",
    "  printf '%s' \"$1\" | sed -E 's#\\.git$##; s#^(ssh|git|https?)://##; s#^[^/@]*@##; s#^([^/:]+):#\\1/#'",
    "}",
    "",
    "# Validate ONE candidate. Args: <source-name> <declared-origin-url>.",
    "# Clears $legacy on entry and republishes it only after EVERY gate passes,",
    "# so a rejected/failed call cannot leave a stale target for the gates below.",
    "assert_legacy_target() {",
    "  name=$1 want=$2 legacy= candidate=$WS/$name",
    "  case $name in",
    "    ''|.|..|*/*) echo \"reject: bad source name '$name'\"; return 1;;",
    "    .first-tree|source-repos|worktrees|context-tree)",
    "      echo \"reject: reserved workspace dir '$name'\"; return 1;;",
    "  esac",
    '  [ -e "$candidate" ] || { echo "skip: nothing at $candidate"; return 1; }',
    '  [ -L "$candidate" ] && { echo "reject: $candidate is a symlink"; return 1; }',
    '  real=$(realpath "$candidate")',
    '  [ "$real" = "$WS" ] && { echo "reject: target is the workspace root"; return 1; }',
    '  [ "$(dirname "$real")" = "$WS" ] \\',
    '    || { echo "reject: $real is not an immediate child of $WS"; return 1; }',
    '  top=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null) \\',
    '    || { echo "reject: $candidate is not a git checkout"; return 1; }',
    '  [ "$top" = "$real" ] || { echo "reject: $candidate sits inside another repo ($top)"; return 1; }',
    '  [ "$(git -C "$candidate" rev-parse --is-bare-repository 2>/dev/null)" = false ] \\',
    '    || { echo "reject: $candidate is bare, not a flat checkout"; return 1; }',
    '  got=$(git -C "$candidate" remote get-url origin 2>/dev/null)',
    '  [ "$(canon_url "$got")" = "$(canon_url "$want")" ] \\',
    "    || { echo \"reject: origin '$got' != declared '$want'\"; return 1; }",
    "  legacy=$candidate",
    '  echo "ok: $legacy"',
    "}",
    "",
    "# One call per declared source — values baked from your manifest:",
  );
  for (const repo of sourceRepos) {
    const sourceName = repo.absolutePath.split("/").filter(Boolean).pop() ?? "";
    lines.push(`assert_legacy_target ${shellQuote(sourceName)} ${shellQuote(repo.url)}`);
  }
  lines.push(
    "```",
    "",
    "Git-state gates — run only for a `$legacy` the preflight passed (re-run",
    "`assert_legacy_target` to set `$legacy`). Clear the same zero-data-loss",
    "bar for **everything** the retire would destroy: its linked worktrees,",
    "its own working tree, AND any local-only history in its `.git` (branches",
    "checked out in no worktree, plus stashes). If any check below is",
    "non-empty, stop — push / migrate that work or ask a human:",
    "",
    "```bash",
    'git -C "$legacy" fetch origin        # refresh origin/<default> so the merge checks are real',
    'git -C "$legacy" worktree list       # the checkout + every worktree on it',
    "# each LINKED worktree — clean + already merged, then drop it:",
    "git -C <wt> status --porcelain       # empty ⇒ no uncommitted work",
    'git -C "$legacy" merge-base --is-ancestor <wt-HEAD> origin/<default>  # exit 0 ⇒ already merged',
    'git -C "$legacy" worktree remove <wt>  # repeat per worktree; refuses if dirty',
    "# the checkout ITSELF — `worktree remove` won't touch a main tree, and the",
    "# move below also carries local-only refs/stashes; clear the full bar by hand:",
    'git -C "$legacy" status --porcelain  # empty ⇒ no uncommitted work',
    'git -C "$legacy" merge-base --is-ancestor HEAD origin/<default>  # exit 0 ⇒ HEAD merged',
    'git -C "$legacy" branch --no-merged origin/<default>  # empty ⇒ no unmerged local branch',
    'git -C "$legacy" stash list          # empty ⇒ no stashed work',
    "# Quarantine, don't delete — keep the retire reversible:",
    'mv -- "$legacy" "$legacy.retired.$(date +%Y%m%d%H%M%S)"  # only after ALL of the above are clear',
    "```",
    "",
    "The quarantined `*.retired.*` directory is harmless to leave in place;",
    "the irreversible `rm -rf` of it is a separate step a human confirms once",
    "they are satisfied nothing was lost.",
    "",
    "The legacy `context-tree` **symlink** migrates the same one-time way —",
    "see `## Tree Location` (remove the symlink only, then clone).",
  );
  return lines.join("\n");
}

function worktreesBlock(agentHome: string, sourceRepos: ReadonlyArray<PredeclaredSourceRepo>): string {
  // LLMs sometimes literal-copy `<placeholder>` strings, so the source path
  // and worktree paths are shell-quoted real values; only `<name>`,
  // `<task-name>`, `<new-branch>`, `origin/main` stay as placeholders.
  const quotedHome = shellQuote(agentHome);
  const exampleSource = sourceRepos[0]
    ? shellQuote(sourceRepos[0].absolutePath)
    : `${quotedHome}/source-repos/<source-repo>`;
  const readWorktreePath = shellQuote(`${agentHome}/worktrees/<name>-read`);
  const taskWorktreePath = shellQuote(`${agentHome}/worktrees/<task-name>`);
  return `## Worktrees (how you read AND write a bare source repo)

The source clones are **bare**, so every read and every write goes
through a worktree you create off the bare clone and remove when done.
**No worktrees are pre-created.**

**Read worktree** — grep / browse / a skill scan, off the latest default
branch:

\`\`\`bash
# <source> is one of the bare clone paths listed under Source Repositories, e.g. ${exampleSource}
git -C <source> fetch origin
git -C <source> worktree add ${readWorktreePath} origin/main
# read inside the worktree, then remove it:
git -C <source> worktree remove ${readWorktreePath}
\`\`\`

**Task (write) worktree** — one per task, frozen for the PR's life:

\`\`\`bash
git -C <source> fetch origin
git -C <source> worktree add ${taskWorktreePath} -b <new-branch> origin/main
\`\`\`

Replace \`<source>\`, \`<name>\`, \`<task-name>\`, \`<new-branch>\`, and
\`origin/main\` to fit. A pinned \`ref\` (when listed in Source Repositories)
is the base to branch from instead of \`origin/main\`.

- **Frozen for the task's life**: a task worktree stays on its branch
  point for the whole PR — do not rebase/merge \`origin/main\` into it
  mid-task unless a human asks.
- **Cleanup is yours**: remove a read worktree as soon as the read is
  done; remove a task worktree when the task closes (PR merged or
  abandoned) with \`git -C <source> worktree remove <path>\`. Sweep stale
  worktrees of finished tasks when you notice them.`;
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
- **Unfollow only when the human explicitly asks to stop tracking** the
  entity (\`${bin} github unfollow <entity>\`). Do not proactively unfollow
  merely because a PR or Issue completed, merged, or closed; terminal
  entities may still carry aftermath this chat should hear.

${fullGuide}`;
}

function askingHumansBlock(): string {
  const bin = getCliBinding().binName;
  return `## Asking Humans

When you need something only a human can give — a decision, sign-off, or an
answer — ask with a **structured request** instead of folding the question
into a plain \`chat send\`. A request raises a tracked open question on the
human's side (red-dot / open-question count) AND **blocks that chat for the
human**: their UI pins the question and hides every message after it until
they answer, so the ask cannot be scrolled past. When several questions are
open for them, they clear them oldest-first.

\`\`\`bash
${bin} chat send <human> --request \\
  "<background/context the human needs to decide>" \\
  --question "<the single ask>"
\`\`\`

The body carries the context; \`--question\` is **only** the ask. A request is
**human-directed only** — the server rejects \`--request\` unless the recipient
is a human member, so you cannot open a tracked question against another agent
(reach agents with a plain \`chat send <name>\`).

### Prefer a free-text answer; add options only when each is a clean pick

By DEFAULT ask a free-text question — **omit \`--option\`**. Dense option lists
are hard to choose from: when the choices carry a lot of information or overlap
in meaning, the human cannot weigh them at a glance, so a free-text answer is
the better ask.

\`\`\`bash
${bin} chat send <human> --request "<context>" \\
  --question "<ask>" --option "<A>" --option "<B>"
\`\`\`

Add \`--option\` (repeatable) **only** when every option is semantically single
— a short, unambiguous, mutually-exclusive pick (e.g. Approve / Hold, Friday /
Monday). If an option needs a clause to be understood, or two options could
both be "right", drop the options and let them answer in free text.

### How it resolves

The human answers in their web UI, and **any answer resolves the question**:
picking an option OR typing free text both clear the red dot and unblock the
chat. Their answer comes back to you as the resolving reply — the question does
not linger in a separate "discuss" state. If their answer pushes back or you
need more, **re-ask**: a new \`--request\` opens a fresh question (and a fresh
block).

You can also resolve from the CLI:

\`\`\`bash
# Resolve on their behalf when answered out-of-band (body = the answer):
${bin} chat send <human> "<the confirmed answer>" --answer <requestId>

# Withdraw a question that became moot (body = the reason). Re-asking opens a
# NEW question; it never auto-supersedes the old one:
${bin} chat send <human> "<reason>" --close <requestId>
\`\`\`

\`<requestId>\` is the id of your original \`--request\` message. Only you (the
asker) or the human you asked may resolve it.

Reach for a request on any real fork: needs approval, ambiguous requirements, a
safety-sensitive action, or any change to core data structures or the database.`;
}

function chatTopicBlock(bin: string): string {
  return `## Chat Topic & Description

Each chat carries two pieces of self-describing metadata, both set
through the **\`chat update\`** command — topic and description update
independently:

- **topic** — a short (≤ 30 chars) label the workspace chat list shows,
  e.g. "调研 chat rename 方案" or "本周 ship 计划".
- **description** — the chat's work summary **and** status report. It
  serves two readers at once: you (or a teammate) reconstructing what the
  task is and where it stands, **and** the human reading the current task
  status. It carries the task's **background + plan + progress**, renders
  as **Markdown**, and shows by default at the top of the chat's right
  sidebar.

Both current values appear in the "Current Chat Context" block at the
bottom of this briefing as explicit \`Topic: <value>\` / \`Description:
<value>\` or the sentinel \`(unset ...)\`.

    ${bin} chat update --topic "<short label>"
    ${bin} chat update --description "<task background + plan + progress>"
    ${bin} chat update --topic "<label>" --description "<state>"

(\`chat set-topic\` is a retained deprecated alias — prefer \`chat update\`.)

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

2. **(Owner) Description → keep it current as a status report.** The
   description is **meant to move with the work**, but refresh it only on
   **substantive progress** — rewrite it in place (the message history is
   the log), not as busywork. **If nothing substantive changed this turn,
   keep working rather than re-touching the description.** Keep it within
   **1500 characters** and cover the task's **background + plan +
   progress**, leading with the concrete current task ("reviewing PR #X")
   so anyone scanning \`${bin} chat list\` — and the human reading it as a
   status report — knows what this is and where it stands. **Keep blockers
   and decisions OUT of the description**: when you need a human decision,
   sign-off, or answer, raise a \`${bin} chat send <human> --request\`
   instead. Markdown is supported (bullets, bold, links).

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
| \`${bin} chat …\`   | messaging — \`send\`, \`invite\`, \`list\`, \`history\`, \`update\` |
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

function contextTreeSection(
  contextTreePath: string | null,
  contextTreeRepoUrl: string | null,
  contextTreeBranch: string | null,
): string {
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

**Refresh before you read**: the tree clone is yours to keep fresh —
run \`git pull --ff-only\` in it before every tree read (see
\`## Tree Location\` for the full protocol). A stale tree is the #1
source of designs that conflict with current decisions.

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
    const branch = contextTreeBranch ?? "main";
    const upstream = contextTreeRepoUrl ? `\n\nUpstream: \`${contextTreeRepoUrl}\` (branch \`${branch}\`).` : "";
    // Shell-quote every interpolated value: branch / URL / path may legitimately
    // contain spaces, `$`, backticks, or other shell metacharacters that would
    // break a literal copy-paste into a shell. Single-quote each value and
    // escape any embedded single quotes by closing the quote, inserting an
    // escaped quote, and reopening — the canonical POSIX-safe form.
    const quotedBranch = shellQuote(branch);
    const quotedPath = shellQuote(contextTreePath);
    const cloneCmd = contextTreeRepoUrl
      ? `git clone --branch ${quotedBranch} --single-branch ${shellQuote(contextTreeRepoUrl)} ${quotedPath}`
      : `git clone --branch <branch> --single-branch <tree-repo-url> ${quotedPath}`;
    blocks.push(`## Tree Location (agent-managed clone)

The Context Tree for this workspace lives at:

    ${contextTreePath}${upstream}

**You maintain this clone yourself** — the runtime never runs git on it:

- **Missing** → clone it:

      ${cloneCmd}

- **A symlink at this path** (legacy shared-pool layout) → remove the
  symlink itself (\`rm ${quotedPath}\` — this deletes only the link,
  never its target), then clone as above.
- **Before every tree read** → \`git -C ${quotedPath} pull --ff-only\`.
  On network/credential failure: use the local copy, and report the
  failure to a human in the chat. On a dirty-tree failure: the read-only
  rule below was violated — stash or re-clone, then report.
- **Read-only**: never edit this clone in place. Tree writes branch a
  worktree off it (\`git -C ${quotedPath} worktree add …\`) and go
  through a PR, per the Writing the Tree rules above.

Read the root \`NODE.md\` first to map the domains before you act.`);
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
