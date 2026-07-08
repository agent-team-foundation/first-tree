import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AGENT_BRIEFING_GENERATED_MARKER,
  type AgentRuntimeConfigPayload,
  type PromptSection,
} from "@first-tree/shared";
import type * as ejs from "ejs";
import type { PredeclaredSourceRepo } from "./bootstrap.js";
import { getCliBinding } from "./cli-binding.js";
import type { AgentIdentity } from "./handler.js";
import { buildResourceSkillsBriefing } from "./resource-skills.js";

const require = createRequire(import.meta.url);
// EJS is published as CommonJS at runtime even though its types expose named
// exports, so native ESM cannot import `render` directly.
const ejsRuntime: typeof ejs = require("ejs");
const AGENT_BRIEFING_TEMPLATE_FILENAME = "agent-briefing.ejs";
const TEMPLATE_CANDIDATE_URLS = [
  // Source execution: packages/client/src/runtime/agent-briefing.ts
  new URL(`./templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
  // Bundled execution: packages/client/dist/index.mjs or apps/cli/dist/<chunk>.mjs
  new URL(`../templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
] as const;

type CachedTemplate = {
  filename: string;
  source: string;
};

let templateCache: CachedTemplate | null = null;

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

type AgentBriefingRenderModel = {
  generatedBannerBlock: string;
  identityBlock: string;
  teamPromptBlock: string | null;
  agentPromptBlock: string | null;
  agentPromptOverridesBlock: string | null;
  legacyPromptBlock: string | null;
  workingInFirstTreeBlock: string;
  requiredReadingBlock: string | null;
  contextTreeBlock: string;
  skillsBlock: string | null;
};

/**
 * Build the unified agent briefing materialised at `<workspacePath>/AGENTS.md`.
 * `<workspacePath>/CLAUDE.md` is a symlink to it, so Codex (which walks up
 * for `AGENTS.md`) and Claude Code (which loads `CLAUDE.md` via
 * `settingSources: ["project"]`) read the same content.
 *
 * This file is shared by every chat for the same agent home, so it must only
 * carry stable agent-level / org-level content. Per-chat material such as
 * Current Chat Context is injected by each provider/session path instead of
 * being written here.
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
 *   5. `# Required Reading (First Tree Managed)` — tree-bound only; unconditional load of `first-tree-write`
 *   6. `# Context Tree (First Tree Managed)`   — per binding, with subsections:
 *        Core Model · Reading the Tree · Writing the Tree · Tree Location
 *   7. `# Skills (First Tree Managed)`         — Team Skills (if any) + First Tree Family
 */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  return renderAgentBriefingTemplate(buildAgentBriefingRenderModel(opts));
}

function buildAgentBriefingRenderModel(opts: BuildAgentBriefingOptions): AgentBriefingRenderModel {
  const bin = getCliBinding().binName;

  const promptSections = opts.payload?.prompt.sections ?? [];
  const teamPromptBlock = teamPromptSection(promptSections);
  const agentPromptBlock = agentPromptSection(promptSections, opts.identity, bin);
  const overridesBlock = agentPromptOverridesSection(promptSections);
  let legacyPromptBlock: string | null = null;
  if (!teamPromptBlock && !agentPromptBlock && !overridesBlock) {
    // Legacy server without structured sections — keep the old single-blob
    // rendering. The blob may mix team and agent content, so it must NOT be
    // presented under the editable `# Agent Prompt` heading.
    const legacyPrompt = opts.payload?.prompt.append?.trim() ?? "";
    if (legacyPrompt) legacyPromptBlock = `## Agent-Specific Prompt\n\n${legacyPrompt}`;
  }

  const workingInFirstTreeBlock = workingInFirstTreeSection(
    {
      agentHome: opts.workspacePath,
      sourceRepos: opts.sourceRepos,
      contextTreePath: opts.contextTreePath,
    },
    bin,
  );

  // `# Required Reading` — sits AFTER `# Working in First Tree` so the
  // agent first reads the inline workspace-collab basics (chat send,
  // working directory, communication contract) it needs to operate at
  // all, then hits the hard mandate to load `first-tree-write`
  // before doing any real work. Placing it
  // immediately before `# Context Tree` also keeps the mandate adjacent
  // to the content domains the two skills cover. Gated on
  // `contextTreePath !== null` because the UNCONDITIONAL mandate to load
  // `first-tree-write` on every task is a tree-ops discipline (reflecting
  // sources into an existing tree). A tree-less agent DOES carry write on disk
  // now — it ships core as `first-tree-seed`'s dependency — but should load it
  // only when seed pulls it in, not on every task; its installed core skills
  // are still surfaced by the tree-less family map in `skillsSection`.
  const requiredReading = requiredReadingSection(opts.contextTreePath, opts.workspacePath);
  const contextTreeBlock = contextTreeSection(
    opts.contextTreePath,
    opts.contextTreeRepoUrl ?? null,
    opts.contextTreeBranch ?? null,
  );

  const skillsBlock = skillsSection(opts.workspacePath, opts.payload, opts.contextTreePath);

  return {
    generatedBannerBlock: generatedBannerSection(bin),
    identityBlock: identitySection(opts.identity),
    teamPromptBlock,
    agentPromptBlock,
    agentPromptOverridesBlock: overridesBlock,
    legacyPromptBlock,
    workingInFirstTreeBlock,
    requiredReadingBlock: requiredReading,
    contextTreeBlock,
    skillsBlock,
  };
}

function renderAgentBriefingTemplate(model: AgentBriefingRenderModel): string {
  const template = readAgentBriefingTemplate();
  return ejsRuntime.render(template.source, model, { filename: template.filename });
}

function readAgentBriefingTemplate(): CachedTemplate {
  if (templateCache) return templateCache;
  const filename = resolveAgentBriefingTemplatePath();
  templateCache = {
    filename,
    source: readFileSync(filename, "utf8"),
  };
  return templateCache;
}

export function resolveAgentBriefingTemplatePath(): string {
  for (const url of TEMPLATE_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error(
    `Agent briefing EJS template is missing. Expected ${AGENT_BRIEFING_TEMPLATE_FILENAME} in the client runtime templates assets.`,
  );
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
 * Hard mandate that the agent load `first-tree-write`
 * before doing any non-trivial work, regardless of whether the user
 * mentioned chat / context keywords that would otherwise trigger
 * progressive disclosure.
 *
 * Rationale: the inline briefing is a routing index, not a substitute. The
 * skill payloads carry rules that are NOT duplicated here:
 *
 *  - `first-tree-write` ships the Context Tree concept model, the
 *    Source-System Boundary, the authorship read-discipline, the Hard
 *    Rules 1-7 (default to not writing / read before write / smallest
 *    correct edit / no diffs / verify gate / ownership through humans /
 *    `decisionLocksCode`), the Double Test, Node Shape, and the
 *    Worked Examples.
 *
 * This section is gated on `contextTreePath !== null` because the
 * UNCONDITIONAL mandate to load `first-tree-write` on every task is a
 * tree-ops discipline (reflecting sources into an existing tree). Since the
 * seed/write→core move, a tree-less agent DOES carry `first-tree-write` on
 * disk (it ships core as `first-tree-seed`'s dependency), but should load it
 * only when seed pulls it in — not on every task — so the mandate stays
 * tree-bound. A tree-less agent's installed core skills are surfaced by the
 * tree-less First Tree Family map in `skillsSection` instead.
 */
function requiredReadingSection(contextTreePath: string | null, workspacePath: string): string | null {
  if (contextTreePath === null) return null;
  const writeSkillPath = `${workspacePath}/.agents/skills/first-tree-write/SKILL.md`;
  return `# Required Reading (First Tree Managed)

Before responding to any non-trivial instruction in this chat, you MUST
load **\`first-tree-write\`** before acting. The \`# Working in First Tree\`
section above carries the minimum mechanics you need to operate at all
(chat send, working directory, CLI surface); the skill carries the
durable Context Tree concept model, source-system boundary, authorship
read-discipline, and the Hard Rules + Double Test that govern every
tree write.

If your runtime does not automatically inject the full skill body after
selecting a skill from the skill listing, read the local payload file
directly before acting:

- \`${writeSkillPath}\`

This skill is unconditional. The remaining First Tree skills
(\`first-tree-read\`, \`first-tree-seed\`) load on demand based on the
task signal as listed in the First Tree Family map below.

Skipping it costs you the source-system boundary and the write-side
Hard Rules + Double Test — content the inline briefing only summarises.
Acting without it is the #1 source of advice that conflicts with
reality.`;
}

// --- # Working in First Tree -------------------------------------------------

type WorkingInFirstTreeOpts = {
  agentHome: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
  contextTreePath: string | null;
};

function workingInFirstTreeSection(opts: WorkingInFirstTreeOpts, bin: string): string {
  const blocks: string[] = [];

  blocks.push(`# Working in First Tree (First Tree Managed)

You are running inside **First Tree**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input. Each message
  has a \`[From: <name> · type=<human|agent> · sent=<timestamp>]\` header — the
  name is what you pass back to \`chat send\`, \`type\` tells you which reply
  discipline applies (see below), and \`sent\` is when it was sent. (The
  annotations are omitted when unknown.)
- **\`${bin} chat send <name>\` reaches any teammate — agent or human.** Use it
  to make an agent act, or to send a human a free reply / conversational answer.
  For a human you can also raise a tracked decision with \`${bin} chat ask
  <human>\`, or push progress with \`${bin} chat update --description\`.
- **Inside First Tree, the "user" your underlying agent addresses is the First
  Tree runtime.** Everything you produce apart from an explicit chat command —
  your reasoning, your progress, and the message that closes your turn alike —
  is addressed to that runtime and recorded as a live reasoning/activity trace.
  Think, plan, and narrate there freely, treating it as visible: a one-line
  preview can surface as live session activity. This is your **console**.
- **A teammate is reached through the outbox: the explicit commands
  \`chat send\`, \`chat ask\`, and \`chat update\`.** The console addresses the
  runtime; the outbox places your message in front of a teammate. A human-directed
  turn is complete once you deliver your reply through the outbox; an agent
  wake-up with nothing new to act on can end without a send.
- **Reply to a human; don't fire a courtesy \`chat send\` to an agent.** A
  message a human directs at you gets a \`chat send\` reply before you end the
  turn — a human never auto-wakes from your reply, so there is no loop risk and
  silence just reads as no reply. Between agents it is the opposite: if a
  wake-up leaves nothing new to act on, end the turn without sending — a
  courteous "got it" between two agents is how loops start.
- **Form a rich body as a file or stdin, so the markdown reaches the chat
  verbatim.** Write a \`chat send\`/\`chat ask\` body — or a \`chat update
  --description\` — to a file and send it with \`-F\`, or pipe it via stdin
  (\`chat update\` reads \`--description -\`): \`${bin} chat send <name> -f markdown -F <file>\`.
  Reserve inline \`"..."\` for a short, plain, single-line string. Markdown needs
  \`-f markdown\` (the default \`text\` shows \`**bold**\`, lists, and \`\`code\`\`
  as literal characters), and the body is a raw string — never \`JSON.stringify\`
  it. Why a file/stdin is the verbatim-safe path — and the Issue #389
  double-encode trap — is in \`## Communication\`.`);

  blocks.push(workingDirectoryBlock(opts.agentHome));

  if (opts.sourceRepos.length > 0) {
    blocks.push(sourceRepositoriesBlock(opts.sourceRepos));
  }

  blocks.push(worktreesBlock(opts.agentHome, opts.sourceRepos));
  blocks.push(communicationBlock(bin));
  blocks.push(workspaceCollaborationBlock(bin));
  blocks.push(githubWorkingPostureBlock());
  blocks.push(githubAttentionBlock(bin, opts.contextTreePath !== null));
  blocks.push(askingHumansBlock(bin));
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
    "   shipped skill scan (`first-tree-seed`) — create a",
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

\`chat send\` reaches any teammate — agent or human. A human also has two
intent-specific channels: \`chat ask\` (decisions) and \`chat update
--description\` (progress). Decision guide (based on participant \`type\` in
the Current Chat Context block):

A reply-transport command — \`chat send\`, \`chat ask\`, or \`chat update\` — is
a real command you run with the chat CLI, the same execution path you use for
any other tool; running it delivers your words to a teammate. A business action
is anything that changes the workspace or the world beyond that delivery. When a
teammate asks you to hold off from acting, that scope governs changes to things,
while running the chat CLI to deliver your reply stays the way you finish a
human-directed turn, because that delivery changes nothing beyond placing your
message in the chat.

- **Replying to a human is required, not optional** → when a human directs a
  message at you, end the turn with one \`${bin} chat send <name> "..."\`
  carrying the result — what you did, decisions made, non-human blockers you
  are waiting out (CI, another agent), and the next step —
  gathered into ONE concise message. A turn that ends without it is, to the
  human, no reply at all. A plain send is informational, raises no red dot,
  and never auto-wakes the human, so there is no loop risk in always answering.
  A send must be self-sufficient: the human can read it and move on — nothing
  in it waits for their answer. If the turn instead ends blocked on the human,
  the turn-ending message is a \`chat ask\` whose body carries the report as
  background (see \`## Asking Humans\`), never a send with a blocking question
  folded in.
- **Don't stream a human through repeated \`chat send\`.** Within a turn, send
  at most one plain human reply; merge related updates into that single
  message, and use \`${bin} chat update --description\` for ongoing
  progress/status. The one case where you skip a human reply entirely is a turn
  with genuinely nothing to answer — a re-delivery of a message you already
  handled, or a system / no-op wake-up — not merely because you judge a fresh
  human message already covered.
- **Asking a human** for a decision, approval, or answer → \`${bin} chat ask
  <human>\` (see \`## Asking Humans\` for the required body structure). The
  message body IS the ask. This raises a tracked open question (red-dot /
  open-request count) and blocks the chat for them until they answer. Route by
  dependency, not importance: use this — not a plain send — whenever the human
  must decide, approve, or answer before you proceed, no matter how small the
  question feels.
- **Reporting progress to a human** → \`${bin} chat update --description
  "..."\` (see \`## Chat Topic & Description\`).
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
- **Don't fire a courtesy \`chat send\` between agents.** If an agent wake-up
  leaves nothing new to act on, end the turn without sending — agent↔agent "got
  it" replies are how loops start. This brake is for agents: a human who
  directed a message at you still gets a reply (first bullet). The list above is
  exhaustive for the *send* side.

Every \`chat send\` names a recipient — there is no no-mention send. A group
chat rejects a message that addresses no one; pass \`<name>\` to @mention the
recipient.

**Why a rich body goes through a file or stdin.** An inline \`"..."\` body is
parsed by the shell before the CLI runs: it executes backticks and \`$(...)\`,
expands \`$VAR\`, ends the string early on a quote, and collapses a botched
heredoc into residue like a bare \`@EOF\` — silent corruption the CLI cannot see
or repair. A file (\`-F <path>\`) or a pipe (stdin) hands the bytes to the CLI
untouched, so backticks, quotes, \`$\`, and newlines arrive verbatim; \`chat
update\` takes its description the same way via \`--description -\`. For the same
reason pass the body as a raw string and never \`JSON.stringify\` it — outer
quotes plus \`\\n\` escapes persist as a literal \`"@x ...\\n..."\` row the UI
cannot render as markdown (Issue #389).`;
}

function workspaceCollaborationBlock(bin: string): string {
  return `## Workspace Collaboration

The Communication block above is the in-agent contract for \`chat send\`,
\`chat ask\`, and \`chat update\`: sends reach any teammate, asks put a
tracked question to a human, no courtesy sends, and raw markdown bodies.
For flags, stdin
forms, history, invite, and related command details, use
\`${bin} chat --help\` and the relevant subcommand help.

Substitute this agent's CLI binary, \`${bin}\`, anywhere external docs
show the literal \`first-tree\`.`;
}

function githubWorkingPostureBlock(): string {
  return `## GitHub Working Posture

For GitHub URLs, PRs, Issues, Actions runs, repo metadata, comments, and
ordinary PR / Issue creation, try the host \`gh\` CLI first when available.
GitHub URLs are not, by themselves, a reason to ask for First Tree GitHub App
installation or repo authorization.

If \`gh\` is missing, unauthenticated, or lacks access, explain that specific
capability gap and choose the narrowest non-platform recovery first: local
clone path, GitHub CLI install, or \`gh\` auth/access.

Ask for First Tree GitHub access only when the desired outcome needs platform
capabilities beyond this local session: follow, webhook events, team repo
resources, Context Tree provisioning, installation-token repo access, or
cross-session/team access.

If the current member is not an org admin, do not ask them to install the
GitHub App, change repo authorization, or create/bind a Context Tree. Explain
that those are admin-owned team setup actions and continue with local path /
host \`gh\` when possible.

Do not use agent-accessible local files or tree snapshots as a hidden server
sync path. User-visible task output is fine; background bulk upload is not.`;
}

// Inline (not skill-only) on purpose: the follow-after-create default has to
// fire at PR/issue-creation time, and progressive disclosure of the
// Inline on purpose: the follow-after-create default has to fire at
// PR/issue-creation time. Without this always-present rule, agents create
// entities and never wire their event streams (the session-event auto-binder
// was deliberately removed in #979 — explicit declaration is the only
// entrance).
function githubAttentionBlock(bin: string, _treeBound: boolean): string {
  return `## GitHub Entity Attention

Creating a PR or issue **never** follows it — no creation path
(\`gh pr create\`, curl, GitHub MCP, the web UI) wires anything for you,
and there is no auto-binding. Declaring the dependency is your job:

- **Default: follow what you create.** Immediately after creating a PR or
  issue — in the same breath as creation — wire it into the current chat:

      ${bin} github follow <url>

  Skip the follow only when the entity is clearly unrelated to this
  chat's task.
- **If the follow fails because the org has not installed the First Tree
  GitHub App**, do not dismiss it as "no action needed." You just delivered
  something the user cares about (the PR/issue) — treat installing the App as
  an optional value upgrade, in plain product language: it makes this entity's
  live activity (CI results, review comments, merge) flow back into this chat,
  and lets future PRs or issues you follow flow back here too (the App is
  required for that; you still follow each one). Installing is an org-admin
  action, so route by who you are talking to: if the human can set up the team
  (an org admin — e.g. from the onboarding greeting), point them to
  **Settings → GitHub** in the First Tree web app (you cannot mint the install
  link yourself); if they are not an admin or you are unsure, say an
  organization admin can enable it and offer to hand over the exact steps. Be
  honest — it is optional and the PR/issue works either way — and never surface
  the raw error code or \`github follow\` mechanics to the user. Say it in a
  tight line or two, not a wall of text; users skim.
- **Unfollow only when the human explicitly asks to stop tracking** the
  entity (\`${bin} github unfollow <entity>\`). Do not proactively unfollow
  merely because a PR or Issue completed, merged, or closed; terminal
  entities may still carry aftermath this chat should hear.

For the full flag surface, upstream-dependency follows, \`409\` /
\`--rebind\` conflict handling, and the error contract, see
\`${bin} github follow --help\` / \`${bin} github unfollow --help\`.`;
}

function askingHumansBlock(bin: string): string {
  return `## Asking Humans

When you need something only a human can give — a decision, sign-off, or an
answer — use **\`chat ask\`**, never a question folded into a plain send.
\`chat ask\` raises a tracked open question on the
human's side (red-dot / open-question count) AND **blocks that chat for the
human**: their UI pins the question and hides every message after it until
they answer, so the ask cannot be scrolled past. When several questions are
open for them, they clear them oldest-first.

The routing test is **dependency, not importance**: the moment your next step
depends on the human's answer, the question goes through \`chat ask\` — always,
even when it feels too small to "deserve" a tracked question. A blocking
question inside a \`chat send\` is a mis-routed ask: nothing tracks it, the
human can scroll past it, and the work silently stalls. Importance governs a
different call — whether a question should exist at all. Raise only a decision
that is **genuinely the user's to make** AND **cannot be settled from the
request, the code, or a reasonable default** — a product/scope fork, a
safety-sensitive or irreversible action, or ambiguous requirements whose
branches differ materially. Do NOT manufacture progress or permission checks
("is the plan ready?", "can I continue?", "does this look right?"): decide,
proceed, and report status via \`chat update --description\`. The human's
earlier answers are a source you settle from too — but only when you can
actually cite them: an answer in the visible transcript, a durable record (a
Context Tree node, a memory note), or something the human just provided. An
inferred preference you cannot point to is not evidence; without such a
source the question is not settled — ask. When a citable pattern shows how
they decide cases like this one, apply it and report the call instead of
re-asking. Ask volume should fall as
you learn how the human decides; interruption that never decreases means you
are not learning. But once a
genuine blocking question exists, it is an ask — in no case does it ride in a
plain send.

\`chat ask\` is **human-directed** — the server rejects it
unless the recipient is a human member, so you cannot open a tracked question
against another agent (reach agents with \`chat send\`).

### The body must be decision-self-sufficient

The human you are asking runs many chats in parallel and may answer hours or
days later — possibly on a review surface that shows the ask alone, outside
the chat. Assume no familiarity with the underlying context, no memory of
this chat, and no recall of what any shorthand refers to; deciding must not
require re-living the work. The message **body IS the ask**, and it must
carry everything needed to decide on its own, structured in three markdown
sections (written in the session's working language). Unpack every compressed
reference: a term of art, an internal shorthand, or an option label is
undecidable not because it is technical but because its meaning lives in
context the reader does not hold — state what it concretely means and changes
here. A question the reader can only guess at cannot produce a good
decision:

1. **Why this question exists** — what you were doing, what forced the fork,
   and why you cannot settle it yourself.
2. **Recent context** — a few-line recap of the last rounds between you and
   the human (what they asked, what you did, what changed), written for a
   reader who remembers none of it — not even their own last message.
3. **The question** — ONE question, plus your recommendation (the option you
   would pick and why), so a bare "approved" is a complete answer. Phrase
   each choice by its consequence for the user, not an implementation label.

A one-line ask ("which option?", "ok to proceed?") defeats the channel: it
forces the human to reconstruct your context by scrolling. A well-formed ask
body is inherently multi-line — pipe it via stdin or \`--message-file\`:

\`\`\`bash
cat <<'EOF' | ${bin} chat ask <human>
## Why this question exists
...
## Recent context
...
## The question
... (+ the option you would pick, and why)
EOF
\`\`\`

### Prefer a free-text answer; add options only when each is a clean pick

By DEFAULT ask a free-text question — **omit \`--options\`**. Dense option lists
are hard to choose from: when the choices carry a lot of information or overlap
in meaning, the human cannot weigh them at a glance, so a free-text answer is
the better ask.

\`\`\`bash
${bin} chat ask <human> -F ask-body.md \\
  --options '[{"label":"Ship","description":"Roll to 20% now"},{"label":"Hold","description":"Wait 24h"}]'
\`\`\`

Add \`--options\` (a JSON array of 2–4 \`{label, description, preview?}\`) **only**
when every option is semantically single — a short, unambiguous,
mutually-exclusive pick (e.g. Approve / Hold, Friday / Monday). Add
\`--multi-select\` (requires \`--options\`) to let them pick more than one. If an
option needs a clause to be understood, or two options could both be "right",
drop the options and let them answer in free text.

### How it resolves

**You only ask — the human resolves.** The human answers in their web UI, and
**any answer resolves the question**: picking an option OR typing free text both
clear the red dot and unblock the chat. Their answer comes back to you as the
resolving reply — the question does not linger in a separate "discuss" state. An
agent **cannot** mark a question answered or close it (there is no resolve
command); resolution is entirely the human's web answer. If their answer pushes
back or you need more, **re-ask**: a new \`chat ask\` opens a fresh question (and a
fresh block). Re-asking never auto-supersedes the old one; if a prior ask is now
moot, just leave it and re-ask (the human works open questions oldest-first).
A re-ask is a fresh ask: it carries the full self-sufficient body again (the
pushback becomes part of its Recent context), never a bare follow-up line.`;
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

Both current values appear in the provider-injected "Current Chat Context"
JSON payload as \`topic\` / \`description\` properties, with \`null\` meaning
unset.

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

   **Once set, leave the topic unchanged.** Users and agents locate a
   specific chat by its topic, so a stable topic helps humans find the chat
   again quickly. Do not rename an existing topic to track progress, reflect
   a passing focus, or restate a changed subject. Progress and current scope
   belong in the description, not the topic.

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
   sign-off, or answer, raise a \`${bin} chat ask <human>\` instead. Markdown
   is supported (bullets, bold, links).

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

Operator-only (\`login\`, \`daemon install\`, \`agent create / bind\`) runs from
the web console or a human terminal — **never from inside a running agent**.
Binding a workspace to a Context Tree is operator-owned too, with **one
sanctioned in-agent exception**: the seed skill's own create + bind, which a
**confirmed org admin** (with authenticated \`gh\`) runs directly on a
build-the-tree task — no human hand-off, and never a "who runs the bind?"
question. Stop and ask a human only if the caller is not an admin or \`gh\` is
unauthenticated. Full surface: \`docs/cli-reference.md\`.`;
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
\`first-tree-write\`. For task-scoped file selection and operational
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
tree PR; when review reshapes the design, update both PRs together so
they never describe different things. **Merge the code PR first, then
the tree PR.** To hold that order, **open the tree PR as a draft**: a
draft stays cross-linked and fully readable — a code reviewer still
reaches the decision and rationale from it — but cannot merge, so it
can't land ahead of the code PR or auto-merge on green. The code PR is
the source of truth for what was decided, so let it settle first. Once
the code PR merges, reconcile the tree PR against the **final merged**
code PR — fold in any last-round review changes so it reflects the
code's final conclusion, not an earlier draft — then mark the tree PR
**ready**. Its own review and merge happen at that point, against the
final code; keep it prompt so the tree does not trail the merged code
for long.
Implementation-only changes skip the tree write — not the read.

Before writing, you MUST load the relevant skill first and follow its
guidance:

| Task | Skill |
|---|---|
| Reflect one specific PR / doc / note into the tree | \`first-tree-write\` |

If there is no specific source artifact, there is no write task yet:
ask for the PR, design doc, meeting note, or pasted source before
editing the tree. Do not invent ad-hoc tree edits without loading the
skill — the operating guide covers staging, review routing, and
ownership rules you will not remember by default.`);

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
    // Tree-less stub. For ordinary tasks, binding stays operator-owned —
    // surface the gap rather than self-serving a bind. The ONE sanctioned
    // in-agent path is the seed skill's `tree init` create + bind, for a
    // confirmed org admin on a build/set-up-the-tree task (#844 removed the
    // retired `first-tree-onboarding` provisioning flow; #1379 added
    // `tree init` as the admin create+bind path this carve-out points to).
    blocks.push(`## Tree Location

This agent has no Context Tree bound. For an ordinary task that needs
persistent cross-domain context (decisions, ownership) and no tree exists,
surface that gap to a human — binding is normally an operator action, from the
web console. The one exception is a **build / set up the Context Tree** task:
there the seed skill's own create + bind is the sanctioned path for a
**confirmed org admin** with authenticated \`gh\` — run it directly and proceed,
never a "who runs the bind?" question; stop and ask a human only if the caller
is not an admin or \`gh\` is unauthenticated.`);
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

  // The First Tree family map is emitted in both modes, but its rows are scoped
  // to what is actually installed: tree-bound agents get the full four, while
  // tree-less agents get only the core skills on disk (welcome + the from-zero
  // build pair seed/write). A tree-less map matters because a welcome-spawned
  // tree-build chat needs a routing surface to reach `first-tree-seed`.
  const familyBlock = firstTreeFamilyMap(contextTreePath);

  // Skip the `# Skills` umbrella entirely when both inner blocks are
  // empty — a bare header without rows is just visual noise.
  if (!teamBlock && !familyBlock) return "";

  const blocks: string[] = ["# Skills (First Tree Managed)"];
  if (teamBlock) blocks.push(teamBlock);
  if (familyBlock) blocks.push(familyBlock);
  return blocks.join("\n\n");
}

function firstTreeFamilyMap(contextTreePath: string | null): string {
  // Listed skills MUST match what the inline installer actually deploys for
  // THIS agent: `CORE_SKILL_NAMES` always, plus `TREE_SKILL_NAMES` only when
  // tree-bound. Listing a skill the runtime never puts on disk would tell the
  // agent to load a payload that isn't there; omitting an installed one leaves
  // it with no First Tree routing surface. Tests lock this against the
  // installer constants and the repo's `skills/` directory.
  if (contextTreePath === null) {
    // Tree-less: only the core skills are on disk — `first-tree-welcome` plus
    // the from-zero build pair (`first-tree-seed` and its `first-tree-write`
    // dependency). `first-tree-read` is tree-bound and NOT installed here, so
    // it is omitted. This map is the routing surface a welcome-spawned
    // tree-build chat relies on to reach `first-tree-seed`: that chat's opening
    // brief names no skill by design, so without this the agent would fall back
    // to provider auto-discovery instead of First Tree's own routing.
    return `## First Tree Family

These First Tree skills are installed even before your team has a Context
Tree; each row's \`description\` drives progressive disclosure. If the task is
to build the team's Context Tree from the connected code, load
\`first-tree-seed\`.

| Skill | Load when |
|---|---|
| \`first-tree-welcome\` | the onboarding first chat — a natural welcome / "help me get started" message from the user; value-first intro, not a repo scan or tree setup chat |
| \`first-tree-seed\` | set up the team's Context Tree from the connected sources when it has no domain structure yet — creates + binds the repo if none exists, else fills a bound-but-empty tree; refuses once the tree has domain structure |
| \`first-tree-write\` | pulled in by \`first-tree-seed\` as its authoring dependency (source-driven tree writes) |
| \`first-tree-file-bug\` | the user hit a bug in First Tree itself (CLI, runtime, chat, web, GitHub, or tree tooling) and wants it reported — gathers repro + version + chat/user IDs and opens an issue on the first-tree repo via the user's \`gh\` CLI |`;
  }
  return `## First Tree Family

\`first-tree-write\` is **unconditional** — load it on every task per
\`# Required Reading\` above. The remaining rows load on demand: each
skill's \`description\` field drives
progressive disclosure when you mention its domain. For general /
harness skills (\`tdoc\`, \`review\`, \`simplify\`, \`update-config\`,
…) trust the auto-injected list.

| Skill | Load when |
|---|---|
| \`first-tree-welcome\` | the onboarding first chat — a natural welcome / "help me get started" message from the user; value-first intro, not a repo scan or tree setup chat |
| \`first-tree-write\`   | unconditional (see \`# Required Reading\`) — concept model, source-system boundary, and source-driven tree writes |
| \`first-tree-read\`    | read relevant Context Tree files before acting from task / path / feature signals |
| \`first-tree-seed\`    | no domain structure yet — bootstrap the team's Context Tree from its sources (create + bind if none exists, else fill a bound-but-empty tree); refuses once the tree has domain structure |
| \`first-tree-file-bug\` | you hit a bug in First Tree itself (CLI, runtime, chat, web, GitHub, or tree tooling) and want it reported — gathers repro + version + chat/user IDs and opens an issue on the first-tree repo via the user's \`gh\` CLI |`;
}

/**
 * Names of the First Tree skill payloads listed in the Skill Map. Exported
 * so the unit test can cross-check against the on-disk `skills/` directory
 * AND against `CORE_SKILL_NAMES` / `TREE_SKILL_NAMES` in
 * `runtime/first-tree-skills/installer.ts` (the single source of truth for
 * what the inline installer actually copies into the workspace). Drift
 * between these two lists would tell agents to load a skill that isn't
 * on disk; the cross-check test in `agent-briefing.test.ts` blocks that.
 */
export const FIRST_TREE_FAMILY_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
] as const;
