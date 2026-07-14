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
 *   5. `# Context Tree (First Tree Managed)`   — per binding, with subsections:
 *        Core Model · Context Tree Policy · Reading the Tree ·
 *        Writing the Tree · Tree Location
 *   6. `# Skills (First Tree Managed)`         — Team Skills (if any) + First Tree Family
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
    requiredReadingBlock: null,
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

- Incoming messages carry \`[From: <name> · type=<human|agent> · sent=<timestamp>]\`;
  use \`name\` as the chat recipient and \`type\` for the routing rules.
- Inside First Tree, the "user" your underlying agent addresses is the First
  Tree runtime. Non-command output is a visible live reasoning/activity trace,
  not a teammate reply. This is your **console**.
- Teammates are reached through the **outbox**: \`${bin} chat send\`,
  \`${bin} chat ask\`, and \`${bin} chat update\`.
- Human message: finish with one \`${bin} chat send <human>\` unless blocked
  on a human decision; then use \`${bin} chat ask <human>\`. Progress/status
  uses \`${bin} chat update --description\`.
- Agent handoff: \`${bin} chat send <agent>\`; no courtesy acknowledgements.
- Rich markdown bodies go through \`-F <file>\`, \`-F -\`, or
  \`--description -\`; never \`JSON.stringify\` a chat body.`);

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

Your fixed working directory is \`${agentHome}\`. It is shared persistent state
for this agent, so files, caches, and notes persist across tasks. Use
**absolute** paths so subdirectory changes do not break references.`;
}

function sourceRepositoriesBlock(sourceRepos: ReadonlyArray<PredeclaredSourceRepo>): string {
  const lines: string[] = ["## Source Repositories (agent-managed, bare)", ""];
  lines.push(
    "The following source repos are declared for this agent. **You manage these clones yourself**",
    "— First Tree does not auto-clone, auto-fetch, or update worktrees:",
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
    "Each path is a **bare** clone under `source-repos/`. Never read or write files there;",
    "every source read/write goes through a worktree (see `## Worktrees`).",
    "",
    "**Protocol:**",
    "1. **Ensure missing clones** under the declared path:",
    "   ```bash",
    '   mkdir -p "$(dirname <path>)"',
    "   git clone --bare <url> <path>",
    "   git -C <path> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'",
    "   git -C <path> fetch origin",
    "   ```",
    "2. **Verify before reuse — fail closed on mismatch.** If `<path>` exists, run `git -C <path> remote get-url origin` and compare it canonically with the declared URL (ignore trailing `.git` and https/http/ssh/git/scp transport differences). If it does **not** match, stop: do not fetch, add a worktree, delete, re-clone, or re-point. Report both URLs.",
    "3. **Refresh before worktrees** with `git -C <path> fetch origin`.",
    "4. **Credential failures are reportable.** Tell a human what failed; continue only with safe local state.",
    "",
    "**Legacy non-bare workspace checkout.** If you find `<workspace>/<source-name>`, stay inside **your own workspace** and retire it only after: path preflight from `.first-tree/workspace.json` rejects symlinks, reserved workspace dirs (`.first-tree`, `source-repos`, `worktrees`, `context-tree`), non-immediate children, nested/bare repos, and origin mismatches; git-state gates show clean worktrees/checkout (`status --porcelain`), merged history (`merge-base --is-ancestor ... origin/<default>`), no local-only branches (`branch --no-merged origin/<default>`), and no stashes (`stash list`).",
    'When every gate is clear, quarantine rather than delete: `mv -- "$legacy" "$legacy.retired.$(date +%Y%m%d%H%M%S)"`. If unsure, stop and ask/report; never use `rm -rf`. A legacy `context-tree` symlink follows Tree Location: remove only the symlink, then clone.',
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

Source clones are **bare**. Every source read/write happens in a worktree you create off the clone. **No worktrees are pre-created.**

**Read worktree** — for grep, browsing, logs, or a skill scan:

\`\`\`bash
# <source> is one of the bare clone paths listed under Source Repositories, e.g. ${exampleSource}
git -C <source> fetch origin
git -C <source> worktree add ${readWorktreePath} origin/main
# read inside the worktree, then remove it:
git -C <source> worktree remove ${readWorktreePath}
\`\`\`

**Task worktree** — one per task branch, frozen for the PR's life:

\`\`\`bash
git -C <source> fetch origin
git -C <source> worktree add ${taskWorktreePath} -b <new-branch> origin/main
\`\`\`

Replace placeholders to fit. If a repo declares a pinned \`ref\`, branch
from that ref instead of \`origin/main\`. Do not rebase/merge mid-task
unless a human asks. Remove read worktrees after use and task worktrees
when the PR closes.`;
}

function communicationBlock(bin: string): string {
  return `## Communication

\`chat send\`, \`chat ask\`, and \`chat update\` are real CLI commands that
deliver words/status to teammates. A business action changes the workspace
or outside world; "hold off" scopes business actions, not the required
reply transport for a human-directed turn.

| Situation | Use | Rule |
|---|---|---|
| Human asks / reports something and no answer is needed from them | \`${bin} chat send <human> -f markdown -F <file>\` | Send exactly one self-contained reply before ending the turn. |
| Your next step depends on a human decision, approval, or answer | \`${bin} chat ask <human> -F <file>\` | Blocking questions never ride inside plain \`chat send\`; route by dependency, not importance. |
| Progress/status during longer work | \`${bin} chat update --description -\` | Update status instead of streaming repeated plain sends. |
| Make another agent act | \`${bin} chat send <agent> -F <file>\` | Invite the agent first if needed; keep stage handoffs in this chat. |
| Agent wake-up with nothing new to act on | no send | Do not send courtesy acknowledgements to agents. |

Replying to a human is required, not optional. The \`no send\` case applies
only to agent no-op wake-ups or duplicate/system no-op turns, never to a
fresh human-directed message.
Every \`chat send\` names a recipient; group chats reject no-recipient
sends, and \`@name\` in content is not enough.
Start separate work with \`${bin} chat create --to <name>\` only when the
work needs its own task boundary. After an agent handoff, continue only
independent work; do not poll solely because that agent has not replied.

**Rich bodies use files or stdin.** Inline \`"..."\` is parsed by the shell:
backticks and \`$(...)\` execute, \`$VAR\` expands, quotes can end the string,
and broken heredocs leave \`@EOF\`. A file/stdin preserves Markdown, code,
quotes, dollars, and newlines. Pass raw strings, never \`JSON.stringify\`;
escaped \`\\n\` rows caused the Issue #389 double-encode failure. Use
\`-f markdown\` when you want Markdown rendering.`;
}

function workspaceCollaborationBlock(bin: string): string {
  return `## Workspace Collaboration

The Communication matrix is the in-agent contract for teammate delivery:
\`chat send\` reaches humans or agents, \`chat ask\` raises tracked human
decisions, \`chat update --description\` reports progress, and agent no-op
wake-ups do not get courtesy sends. For flags, stdin forms, history, invite,
and related details, use \`${bin} chat --help\` and subcommand help.

Substitute this agent's CLI binary, \`${bin}\`, anywhere docs show the
literal \`first-tree\`.`;
}

function githubWorkingPostureBlock(): string {
  return `## GitHub Working Posture

For GitHub URLs, PRs, Issues, Actions runs, repo metadata, comments, and ordinary PR / Issue creation, try the host \`gh\` CLI first. A GitHub URL is not by itself a reason to ask for First Tree GitHub App installation or repo authorization.

When you create an issue or PR for the user, target the repo the work is about with an explicit \`--repo\`, and confirm that target before creating — for work in a bound source repo, that repo (see **Source Repositories**). Don't default to First Tree's own repository unless the work is genuinely about First Tree itself; a First Tree platform defect specifically goes through the \`first-tree-file-bug\` skill.

If \`gh\` is missing, unauthenticated, or lacks access, report that gap and choose the narrowest recovery: local clone path, GitHub CLI install, or \`gh\` auth/access. Ask for First Tree GitHub access only for platform capabilities such as webhook following, team repo resources, Context Tree provisioning, installation-token access, or cross-session/team access. If the current member is not an org admin, do not ask them to install the GitHub App or bind repos/trees; continue with local path / host \`gh\`.

Do not use local files or tree snapshots as a hidden server sync path.`;
}

// Inline on purpose: the follow-after-create default has to fire at
// PR/issue-creation time. Without this always-present rule, agents create
// entities and never wire their event streams (the session-event auto-binder
// was deliberately removed in #979 — explicit declaration is the only
// entrance).
function githubAttentionBlock(bin: string, _treeBound: boolean): string {
  return `## GitHub Entity Attention

Creating a PR or issue **never** follows it; \`gh pr create\`, curl, GitHub MCP, and the web UI do not auto-bind the entity to this chat.

- **Default: follow what you create.** After creating a PR or issue for this task, wire it into the current chat:

      ${bin} github follow <url>

  Skip the follow only when the entity is clearly unrelated to this chat's task.
- **If the follow fails because the org has not installed the First Tree
  GitHub App**, explain the optional value upgrade in product language: live
  PR/issue activity (CI, reviews, merge) can flow back into this chat after an
  org admin enables **Settings → GitHub** in the First Tree web app. Do not
  expose raw error codes or \`github follow\` mechanics; say the PR/issue still
  works either way.
- **Unfollow only when the human explicitly asks to stop tracking** the
  entity (\`${bin} github unfollow <entity>\`). Do not proactively unfollow merely because a PR or Issue completed, merged, or closed.

For upstream-dependency follows, \`409\` / \`--rebind\`, and full flags, see
\`${bin} github follow --help\` and \`${bin} github unfollow --help\`.`;
}

function askingHumansBlock(bin: string): string {
  return `## Asking Humans

Use **\`chat ask\`** only when your next step depends on a human decision,
sign-off, or answer. It raises a tracked open question and blocks that chat
for the human. Do not put a blocking question inside plain \`chat send\`; use
\`${bin} chat ask <human> -F <file>\`.

The routing test is **dependency, not importance**. Ask only when the
decision is genuinely the user's to make and cannot be settled from the
request, code, durable records, or a reasonable default. Do NOT manufacture
progress or permission checks ("is the plan ready?", "can I continue?", "does this look right?"). Earlier answers settle a case only when you can cite them; inferred preference is not evidence. Ask volume should fall as you learn. \`chat ask\` is human-directed; reach agents with \`chat send\`.

The message **body IS the ask** and must be decision-self-sufficient: the
human may see it alone, so unpack compressed references and cover these inputs:

1. **Why this question exists** — what forced the fork and why you cannot settle it.
2. **Recent context** — a short recap of the last relevant rounds.
3. **The question** — one question plus your recommendation, phrased by user
   consequence rather than implementation label.

These are required content dimensions, not mandatory headings. Use this
three-part shape only when no more specific agent/task/workflow template
applies; otherwise preserve that template while covering the same inputs.

Prefer a free-text answer; omit \`--options\` by default. Add \`--options\`
(2-4 short \`{label, description, preview?}\` entries) only when each choice
is mutually exclusive and easy to pick; add \`--multi-select\` only when more
than one option can be chosen. Use a file or stdin for the multi-line body.

The human resolves the question in the web UI; an agent cannot mark a
question answered or close it. If you need a new answer after pushback,
open a fresh \`chat ask\` with a full self-sufficient body.`;
}

function chatTopicBlock(bin: string): string {
  return `## Chat Topic & Description

Each chat has two self-describing metadata fields, both maintained with
\`chat update\` and both visible in the provider-injected "Current Chat Context":

- **topic** — short (<= 30 chars), stable label for the chat list, e.g.
  "调研 chat rename 方案" or "本周 ship 计划".
- **description** — Markdown work summary and status report: background,
  plan, progress, and current blockers that are not human decisions.
Use \`${bin} chat update --topic "<short label>"\` and
\`${bin} chat update --description "<task background + plan + progress>"\`;
\`chat set-topic\` is a deprecated alias.

Maintain these only when you own the chat: you created it, or no agent owner
is present because a human created it or the creator left. If another agent
owns the chat and is still present, leave metadata to that agent; a 403 means
stop, not retry. If topic is unset, set one before ending the turn; once set,
leave it stable. Keep description current only on substantive progress,
within 1500 characters, in the session language. Rewrite it in place (history
is the log), not as busywork; if nothing substantive changed, keep working.
Markdown is supported. Do not put human decisions in the description; use
\`${bin} chat ask <human>\`. Self-locate with \`${bin} chat list\` and
\`${bin} chat history <chat>\`.

Leave GitHub-sourced topics such as \`PR repo#307: title\`, \`Issue repo#42\`,
and \`Commit repo@sha\` unchanged; the owner still maintains the description.`;
}

function cliOverviewBlock(bin: string): string {
  // Subcommand lists are the actually-registered ones, not aspirational —
  // every command named here must exist or the agent burns a turn on
  // `unknown command`. The `tree` namespace was retired in 2026-06 down
  // to validation (`verify`) and hierarchy browsing (`tree`). The `org`
  // namespace is operator-only and not surfaced to in-agent use.
  return `## CLI Overview

Use \`${bin} chat …\` for messaging, \`${bin} agent …\` for self-introspection, \`${bin} daemon …\` for read-only daemon status/doctor, \`${bin} github …\` for follow/unfollow/following, \`${bin} tree verify\` for Context Tree validation, and \`${bin} tree tree\` for hierarchy browsing.
Operator-only commands (\`login\`, \`daemon install\`, \`agent create / bind\`) run from the web console or a human terminal — **never from inside a running agent**. Context Tree binding is operator-owned too, with one sanctioned in-agent exception: on a **build / set up the Context Tree** task, load \`first-tree-seed\` and run its \`tree init\` path directly. The command validates admin/auth and fails closed; do not pre-confirm admin or ask who will bind. Surface the exact gap only if the command actually fails. Full surface: \`docs/cli-reference.md\`.`;
}

// --- # Context Tree ---------------------------------------------------------

function contextTreeSection(
  contextTreePath: string | null,
  contextTreeRepoUrl: string | null,
  contextTreeBranch: string | null,
): string {
  const blocks: string[] = [];

  const skillRouting =
    contextTreePath === null
      ? "The policy below is the always-present baseline for judging what belongs in a Context Tree. This briefing was generated without a bound tree; before any tree read/write, re-check the workspace binding. If a tree is now bound, load `first-tree-read` or `first-tree-write`; otherwise surface the gap or load `first-tree-seed` for initial bootstrap."
      : "The policy below is the always-present baseline. For task-scoped file selection and operational read workflow, load `first-tree-read`. For source-backed tree edits, load `first-tree-write`.";

  blocks.push(`# Context Tree (First Tree Managed)

## Core Model

The Context Tree is the team's source of truth for **decisions,
constraints, ownership, and cross-domain relationships**. Execution
detail stays in source systems; the tree carries the durable *what* and
*why* a future agent must respect. Each domain is a directory; each node
is Markdown with frontmatter such as \`owners\` and \`soft_links\`.

${skillRouting}

## Context Tree Policy

### What A Context Tree Is

The Context Tree is durable context, not a source-code mirror, wiki dump, or
task log. It records current decisions, constraints, ownership, and
cross-domain relationships with enough rationale that a future reader does
not have to reconstruct them from PRs, chat logs, or tribal knowledge.

### Source-System Boundary

The tree records **what was decided and why**; source repos record **how it is
implemented**. If information would rot when the next refactor lands, it does
not belong in the tree.

| Belongs in the tree | Stays in the source repo |
| --- | --- |
| A choice between alternatives and why the alternatives lost | Function signatures, types, class hierarchies |
| A constraint that shapes future implementation across repos | Step-by-step implementation walkthroughs |
| An ownership change or clarified review path | API request / response shapes |
| A current constraint that resulted from a deprecation | Test fixtures, snapshot data, build / CI config |
| A new relationship between two domains | Bug fixes that do not change a public contract |
| Rationale that would not be obvious from the diff alone | Refactors that preserve behaviour |
| A decision as it stands today: current state + present-tense rationale | Historical narrative of how we got here |

### Content Classes And Authority

- **Normal content** — root/domain \`NODE.md\` and regular domain leaves. It states current durable truth; when a decision changes, rewrite or remove old claims.
- **Archive/supporting content** — proposals, meetings, explorations, and raw material such as \`raw-context/\`. It is evidence, not canonical truth: read it only when asked, when the source is archive/proposal material, or when the task needs archive context. Normal content must not require this class.
- **Member content** — responsibility, ownership, and review scope such as \`members/<id>/NODE.md\`. Use it to route or validate *Who*, not as a substitute for normal decision/constraint nodes.

### Code vs Tree Drift Authority

Normal tree content is authoritative for durable context, but not a blind
override for observed source reality. By default, **code is the ground truth**
when the tree and code disagree: treat the tree as drifted and update the tree
from source-backed evidence. \`decisionLocksCode: true\` reverses that default
for one node: the tree wins, and code drift escalates to a human owner instead
of being silently fixed or ignored. Set or rely on that flag only on explicit
human instruction.

### The Double Test

Before writing, apply both questions to every candidate fact:

1. **Decision test.** Does this source establish or change something a future
   agent must respect when making cross-domain choices?
2. **Durability test.** If the triggering commit or PR were rewritten, would
   the decision still stand?

The candidate belongs in the tree only when both answers are yes. Failing the
decision test means the source is implementation detail; failing the
durability test means the source captures how something was done this time,
not what was decided.

### Content Model: What / Why / Who

- **What** — the decision, design choice, or constraint as it stands today.
  Write the durable claim, not implementation detail or a timeline of prior
  states.
- **Why** — the surviving rationale: constraints that won, alternatives that
  lost, and design course-corrections translated into present-tense reasoning.
  Capture **why**, not only what. Design-phase chat, review, and meeting
  threads are where this rationale is produced: somebody flags a constraint,
  a first proposal is corrected, or an option conflicts with another domain.
  The node records the surviving constraint and reasoning from those moments,
  not the chronology. A node without rationale is a fact, not a decision record.
- **Who** — ownership, carried by \`owners\` frontmatter and
  member content. Do not put ownership in the body, and do not unilaterally
  edit \`owners\`.

### Add vs Edit

Default to editing an existing node. A node earns its existence by being
independently findable, ownable, or linkable; otherwise edit the existing
node. Add a leaf only when all three hold:

1. **Distinct identity** — a noun-phrase title that does not overlap any
   sibling.
2. **Distinct anchor** — at least one of: different \`owners\`; another domain
   would \`soft_links\` to this specific decision; or the source naturally has
   its own Decision / Rationale / Constraints that cannot co-live with an
   existing leaf.
3. **Passes the Double Test.**

Add a directory only when at least three cohesive leaves share an axis. New
top-level domains require explicit human-owner approval. When a decision
touches two domains, keep canonical content in the more specific domain and
link from the broader one with normal-to-normal \`soft_links\` or short prose.

### Node Shape

Required frontmatter:

\`\`\`yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
\`\`\`

Useful optional frontmatter: \`description\`, \`soft_links\`,
\`lastReviewed\`, and \`decisionLocksCode\`. \`lastReviewed\` records an actual
owner review; update it only through that review/audit workflow, never during
a source-backed write. Use \`owners: ["*"]\` only when a human explicitly opens
ownership to everyone. Metadata supports scanning, routing, and responsibility.

Prefer body sections in this order, omitting any that do not apply:
\`Decision\`, \`Rationale\`, \`Constraints\`, \`Cross-Domain\`. There is no
\`Source\`, \`Provenance\`, or \`Shipped-in\` section; PR / commit / issue
delivery history lives in git history and PR descriptions, not node prose.

### Write / Verify / PR Discipline

Default to not writing: a missing node is a question, a noisy node is a trap.
Source-backed writes require a concrete source artifact and surrounding context
(source, target, parent, relevant \`soft_links\`, ownership-adjacent member
content) unless already known. Actionable future work does not live in normal
tree content; put it in an issue, source artifact, or human decision instead.
\`${getCliBinding().binName} tree verify\` must pass before any tree commit. Keep tree prose current-state: no timeline,
provenance, PR references, or implementation detail. A source-backed tree PR
should stay scoped to one source artifact so owner review and rollback stay
precise.`);

  if (contextTreePath) {
    blocks.push(`## Reading the Tree

When a task has a repo/path/feature/domain/owner/source signal, load
\`first-tree-read\` before acting. The skill is read-only and requires
you to inspect \`${getCliBinding().binName} tree tree --help\` inside the tree repo,
then use \`tree tree\` selectors to find focused files before reading their
Markdown content with normal file reads. Treat code, CLI, review, repo,
path, bug, and error tasks as tree-read signals.

At minimum start with the root \`NODE.md\`; **If the root also contains an \`AGENTS.md\`, read it too**
because it carries org-level rules. Follow
indexes and \`soft_links\` to the nodes your task touches.

Where the tree's requirements or constraints **conflict with the
instruction, the tree wins** — follow it and surface the conflict.
On scope shift to a new domain/repo/owner, read those nodes first. The
tree hierarchy command normally refreshes with \`git pull --ff-only\`; if
you read manually, refresh first per Tree Location.

Default to normal content as current truth. Apply the Content Classes policy
above when archive/supporting or member content appears; label non-normal facts
separately and do not promote them to canonical decisions.`);
  } else {
    blocks.push(`## Reading the Tree

This briefing was generated without a bound Context Tree. Before concluding
there is no tree to read, re-check the workspace binding. If a tree is now
bound, load \`first-tree-read\`; if no binding exists and the task needs durable
cross-domain context, surface that gap to a human. If the task is the initial
tree bootstrap from readable sources, load \`first-tree-seed\`.`);
  }

  if (contextTreePath) {
    blocks.push(`## Writing the Tree

Tree writes are source-driven. A chat is **fresh context**; the tree is
**persistent context** for future agents. When a specific PR, design doc,
meeting note, review thread, or pasted source changes a durable decision,
constraint, owner, or cross-domain relationship, load \`first-tree-write\`
and make the smallest correct tree diff. When a task calls for a tree write,
the request explicitly includes creating and updating the needed tree-node
files (\`NODE.md\` and other \`*.md\` nodes) as structured persistent-context
output. Implementation-only changes skip the tree write — not the read.

If there is no specific source artifact, there is no write task yet:
ask for the PR, design doc, meeting note, or pasted source before
editing the tree. Before editing, read the target/parent/soft-linked
nodes the skill identifies; after editing, run \`${getCliBinding().binName} tree verify\`.

When a code PR and tree PR are both needed, open them together, cross-link
the PR descriptions, open the tree PR as a draft, merge the code PR first,
then reconcile the tree PR against the final merged code and mark it ready.
Do not put PR numbers, commit history, diffs, or implementation details in
tree node prose.`);
  } else {
    blocks.push(`## Writing the Tree

This briefing was generated without a bound Context Tree. Before a
source-backed tree edit, re-check the workspace binding. If a tree is now
bound, load \`first-tree-write\`; if no binding exists, do not attempt the edit.
For the team's first tree from readable sources, load \`first-tree-seed\`;
otherwise surface the missing binding/setup gap to a human.`);
  }

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

**You maintain this clone yourself** — the runtime never runs git on it.

- **Missing** → clone it:

      ${cloneCmd}

- **A symlink at this path** (legacy shared-pool layout) → remove the
  symlink itself (\`rm ${quotedPath}\` — this deletes only the link,
  never its target), then clone as above.
- **Refresh** → \`git -C ${quotedPath} pull --ff-only\` before manual
  reads. On network/credential failure, use the local copy and report it.
- **Read-only**: never edit this clone in place. Tree writes branch a
  worktree off it (\`git -C ${quotedPath} worktree add …\`) and go through
  a PR.`);
  } else {
    // Tree-less stub. For ordinary tasks, binding stays operator-owned —
    // surface the gap rather than self-serving a bind. The ONE sanctioned
    // in-agent path is the seed skill's `tree init` create + bind. The command
    // validates admin/auth itself; pre-confirmation would block the chat-first
    // setup path before its fail-closed gate can run.
    blocks.push(`## Tree Location

At briefing generation time this agent had no Context Tree bound. Re-check the
binding if the user says a tree was created or bound during the session. For an
ordinary task that needs persistent cross-domain context and no tree exists,
surface that gap to a human — binding is normally an operator action from the
web console. The one exception is a **build / set up the Context Tree** task:
there the seed skill's own create + bind is the sanctioned path — run its
\`tree init\` directly without pre-confirming admin or asking "who runs the
bind?". The command validates admin/auth and fails closed; surface the exact
gap only after an actual command failure.`);
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

  // The First Tree family map is emitted in both modes. All First Tree skills
  // are installed in every workspace; the surrounding Context Tree section
  // carries the current binding/location state.
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
  // Listed skills MUST match what the inline installer deploys. Installation
  // is broad; routing remains binding-aware. Tests lock this against the
  // installer constants and the repo's `skills/` directory.
  if (contextTreePath === null) {
    // Tree-less: every payload is on disk, but read/write are binding-gated.
    // This map is the routing surface a welcome-spawned tree-build chat relies
    // on to reach `first-tree-seed`: that chat's opening brief names no skill
    // by design, so without this the agent would fall back to provider
    // auto-discovery instead of First Tree's own routing.
    return `## First Tree Family

These First Tree skills are installed in every workspace. Each row's
\`description\` drives progressive disclosure. If the task is to build the
team's Context Tree from readable sources, load \`first-tree-seed\`. If a
read/write task needs a tree that is not bound yet, use the Tree Location
guidance above to surface/setup/seed first.

| Skill | Load when |
|---|---|
| \`first-tree-welcome\` | the onboarding first chat — a natural welcome / "help me get started" message from the user; value-first intro, not a repo scan or tree setup chat |
| \`first-tree-read\`    | read relevant Context Tree files before acting from task / path / feature signals |
| \`first-tree-write\`   | reflect a concrete source artifact (PR, design doc, meeting note, review thread, or pasted source) into the Context Tree |
| \`first-tree-seed\` | set up the team's Context Tree from readable sources — declared workspace repos or a local Git repo / GitHub URL supplied in chat; creates + binds the tree if none exists, fills a bound-but-empty tree, and opens a single PR with the initial structure and leaves |
| \`first-tree-file-bug\` | the user hit a bug in First Tree itself (CLI, runtime, chat, web, GitHub, or tree tooling) and wants it reported — gathers repro + version + chat/user IDs and opens an issue on First Tree's own repo (not the user's own/bound repo) via the user's \`gh\` CLI |`;
  }
  return `## First Tree Family

The generated Context Tree Policy above is the always-present baseline. The
skills below load on demand: each skill's \`description\` field drives
progressive disclosure when a task mentions its domain. For general /
harness skills (\`tdoc\`, \`review\`, \`simplify\`, \`update-config\`,
…) trust the auto-injected list.

| Skill | Load when |
|---|---|
| \`first-tree-welcome\` | the onboarding first chat — a natural welcome / "help me get started" message from the user; value-first intro, not a repo scan or tree setup chat |
| \`first-tree-read\`    | read relevant Context Tree files before acting from task / path / feature signals |
| \`first-tree-write\`   | reflect a concrete source artifact (PR, design doc, meeting note, review thread, or pasted source) into the Context Tree |
| \`first-tree-seed\`    | bootstrap the team's Context Tree from readable sources (declared repos or a local Git repo / GitHub URL supplied in chat); create + bind if none exists, fill a bound-but-empty tree, delivered as a single reviewable PR |
| \`first-tree-file-bug\` | you hit a bug in First Tree itself (CLI, runtime, chat, web, GitHub, or tree tooling) and want it reported — gathers repro + version + chat/user IDs and opens an issue on First Tree's own repo (not the user's own/bound repo) via the user's \`gh\` CLI |`;
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
