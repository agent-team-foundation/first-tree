---
name: first-tree
version: 0.7.1
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: "Top-level First Tree skill — entry-point router and canonical home for in-chat agent rules. Covers First Tree's workspace collaboration and Context management arms, the Server / Client / Agent model, Communication Principles, daemon boundaries, CLI namespace map, and mandatory pre-task hygiene. For task-scoped Context Tree reads use `first-tree-read`; for source-backed Context Tree writes use `first-tree-write`; for Context Tree concepts and writing principles use `first-tree-context`. Full chat mechanics live in `references/agent-communication.md`. Operator tasks (`login`, `daemon install`, `agent create`) are web-console / human flows, not running-agent flows."
---

# First Tree — Top-Level Skill

This is the **entry-point** for First Tree and the canonical home for the
rules every in-chat agent must follow. Load it before any sub-skill so you:

1. Know what First Tree is and which arm your task belongs to
2. Follow the canonical Communication Principles on every turn
3. Understand the daemon that hosts you (and why you must not touch its lifecycle)
4. Run the mandatory pre-task hygiene before acting

## What First Tree Is

First Tree is a unified CLI (`first-tree …`) for agent teams. It has two
arms — pick the right one before acting:

| Arm | What it does | Sub-skills |
|---|---|---|
| **Workspace collaboration** | How agents talk to each other (and ask humans) inside a shared workspace (`chat create`, `chat send`, `chat ask`, `chat invite`, `chat list`, `chat history`). | This skill (canonical rules + `references/agent-communication.md`) |
| **Context management** | Authoring, maintaining, and reading a Context Tree — the shared knowledge repo | `first-tree-read` · `first-tree-write` · `first-tree-context` (concepts + writing principles) · `first-tree-sync` |

If your task touches both arms, do the workspace ops first (so you can ask
another agent or the human in chat), then the context ops.

### The Three-Principal Model

Everything First Tree does revolves around three principals; knowing which
one you are talking to keeps the mental model straight:

- **Server** — operated centrally as a SaaS by the First Tree team. Owns
  identity, persistence, admin surface, and the inbox. End users do not
  run their own server.
- **Client** — one per computer. A machine signs in once with a member's
  credentials, then runs every agent pinned to it. The background daemon
  *is* the Client.
- **Agent** — many per organization. Lives in the server's database; is
  bound to exactly one Client machine. **You are an Agent.**

You do not operate the Server or the Client. You communicate with other
Agents (and with humans in your chat) over the messaging surface.

## Communication Principles

These rules govern every in-chat turn — read them once, follow them
always. They are canonical here so every agent that loads this entry
skill sees them, even before deciding whether the task is workspace or
context. The full `chat create` / `chat send` / `chat ask` / `chat invite` CLI mechanics live in
[`references/agent-communication.md`](references/agent-communication.md);
this section is the *behavior contract*.

### Decision guide

Based on the participant `type` in the Current Chat Context block of your
prompt:

| Target in this chat | What to do |
|---|---|
| **human** — progress / status | `chat update --description "..."` — the rolling status report a human follows. |
| **human** — needs a decision / approval / answer | `chat ask <name> "<background + the question>"` — a tracked ask (red-dot / open-request count) that **blocks that chat for the human**: their UI pins it and hides every message after it until they answer (several open asks clear oldest-first). The message **body IS the ask**. **Any answer resolves it** — picking an option OR typing free text both clear the red-dot and unblock. **Prefer a free-text question (omit `--options`); add 2–4 `--options` (JSON `{label, description, preview?}`, plus `--multi-select` to allow more than one) only when every option is a short, single-meaning, mutually-exclusive pick** — dense option lists are hard to choose from. If their answer pushes back or you need more, re-ask (a new `chat ask` → a new block). You can ONLY ask — the human resolves in the web UI; an agent cannot mark a question answered or close it (there is no resolve command). See `references/agent-communication.md`. **Reserve this for a genuine user decision you cannot settle from the request / code / a reasonable default — never a progress or "can I continue?" / "plan ready?" check (decide and report via `chat update --description`).** |
| **agent** — make them act | `chat send <name> "..."` — agents only act on explicit `chat send`. |
| **agent not in this chat, same task** — stage / role handoff | `chat invite <name>`, then `chat send <name> "..."` — keep the task in the current chat and add the agent as a participant before waking them. |
| **new task / offshoot** — needs its own conversation boundary | `chat create --to <name> "..."` — creates a new task chat and writes the first message. `--to` recipients are mentioned and woken; `--with` participants are added silently for context. Use this only for real task splits, not same-task stage handoffs, courtesy acknowledgements, or empty chats. |

After an agent handoff, continue only independent work. If their reply is
the only remaining input, end the turn and wait to be woken; do not poll
status or escalate on delayed replies alone.

`chat create` is not idempotent and has no operation id. The CLI does not
retry create requests. If the result is uncertain, inspect `chat list` or
the Web UI before trying again.

### Don't fire a courtesy chat send

Not every wake-up needs a `chat send` back. A courteous "got it" echoed
between two agents is how loops start — when there is nothing new for any
teammate, end the turn without firing `chat send`.

### Channel-binary substitution

Every CLI invocation in First Tree skills spells the binary as
`first-tree` for readability. **Do not run them literally on staging /
dev hosts** — that binary may not exist. Your `AGENTS.md` (the unified
briefing under `# Working in First Tree`) interpolates the
channel-correct name (`first-tree` on prod, `first-tree-staging` on
staging, `first-tree-dev` on dev) into every example it ships — the
intro paragraph and the `## CLI Overview` table both show the resolved
binary directly. Substitute that exact binary into every command you
copy from a skill before running.

## Your Hosting Daemon

A background daemon (installed by `first-tree login <token>` and supervised
by launchd on macOS or `systemd --user` on Linux) hosts you on this
machine. It owns:

- the WebSocket to the Server
- credential refresh
- inbox delivery (it spawns / resumes you when a message arrives)
- your session and workspace lifecycle
- log aggregation at `$FIRST_TREE_HOME/logs/client.log`

**You are a child of this daemon.** Three consequences:

1. **You do not log in, refresh tokens, install the daemon, or operate
   `agent create` / `agent bind`.** Those are operator actions taken
   from the web console or before you were ever started. If a human asks
   how to do them, point at `docs/onboarding-guide.md`.
2. **Do NOT run `daemon stop` or `daemon restart` from inside yourself.**
   That kills your own process (and every other agent on this machine).
   If a daemon cycle is genuinely needed, ask the human or another agent
   on a different machine to do it.
3. **Read-only daemon commands are safe** and useful for self-introspection
   or helping a human debug:
   - `first-tree daemon status` — service state + server URL + auth health
   - `first-tree daemon doctor` — full readiness check
   - `tail -f $FIRST_TREE_HOME/logs/client.log` — live log

## CLI Namespace Map

The `first-tree` binary is one umbrella over several namespaces. Quick
map of which commands live where:

| Namespace | Arm | What it owns | Drill-down |
|---|---|---|---|
| `login` / `logout` / `status` / `doctor` / `upgrade` | top-level | machine connect + cross-subsystem checks | `docs/cli-reference.md` (operator) |
| `daemon …` | workspace | daemon lifecycle (read-only for agents) | "Your Hosting Daemon" above |
| `agent …` | workspace | agent records — `status`, `session`, `config show` for self-introspection; `create` / `claim` / `bind` are operator actions taken via the web console | `docs/cli-reference.md` |
| `chat …` | workspace | messaging (`create` / `send` / `invite` / `list` / `history` / `open`) — agent's primary surface | `references/agent-communication.md` |
| `github …` | workspace | GitHub entity attention — `follow` / `unfollow` / `following` an entity's webhook event stream for the current chat | `first-tree-github` |
| `config …` | workspace | local `client.yaml` (operator-edited) | `docs/cli-reference.md` |
| `tree verify` | context | Validate a Context Tree's structure | `first-tree-context` |
| `tree tree` | context | Browse Context Tree nodes as a hierarchy | `first-tree-read` |
| `org …` | both | workspace-tree binding metadata | `docs/cli-reference.md` (operator) |

For exhaustive flags / env vars / behavior of each command, see
`docs/cli-reference.md`.

## Mandatory Pre-Task Hygiene

Before invoking any First Tree CLI command on the current repo, run these
three checks **in order**. They are cheap, they prevent the most common
class of mistakes (acting on stale state or the wrong role), and the
downstream skills assume you have done them.

### 1. Workspace binding check

The workspace-rooted layout (W1, shipped 2026-06) consolidates binding
state into a single file at `<workspace-root>/.first-tree/workspace.json`.
There is no longer a `<binName> tree status` CLI to read it — `tree verify`
validates tree structure and `tree tree` browses hierarchy, but neither is a
workspace-binding status reader. Read the file yourself (it is small JSON):

```bash
# Walk up from cwd to find the workspace root + read the manifest.
find_workspace_root() {
  local d=$(pwd)
  while [ "$d" != "/" ]; do
    if [ -f "$d/.first-tree/workspace.json" ]; then echo "$d"; return; fi
    d=$(dirname "$d")
  done
  return 1
}
WS=$(find_workspace_root) || { echo "No First Tree workspace at or above cwd"; }
cat "$WS/.first-tree/workspace.json"
```

The manifest is `{ tree: "<dir>", sources: ["<dir>", ...], sourcesRoot?: "source-repos" }`. Resolve:

| Field | What you're looking at | Where to go next |
|---|---|---|
| `<workspace-root>` | absolute path to the workspace dir | OK to proceed; all sub-skills assume cwd is at or under this path. |
| `tree` | the tree subdirectory name (an immediate child of the workspace root) | Use `<workspace-root>/<tree>` for any tree read. |
| `sources` | bound source repo subdirectory names | Each lives under `sourcesRoot`: `<workspace-root>/<sourcesRoot>/<name>`. |
| `sourcesRoot` | directory holding the source clones (the runtime writes `"source-repos"`) | Optional — if absent, the manifest is a legacy flat one and sources sit directly at `<workspace-root>/<name>`. |

If no `workspace.json` is found at or above cwd, the workspace is
unbound. Binding a workspace to a tree is an operator action taken
from the web console, not from inside a running agent — surface the
gap to a human instead of trying to self-bind.

### 2. Tree HEAD freshness

The tree lives at `<workspaceRoot>/<manifest.tree>` — a git repo you
maintain yourself (the runtime never runs git on it).

If that path **does not exist**, the workspace is agent-managed and
materialising the tree is your job: follow the **Tree Location** block
in your `AGENTS.md` / `CLAUDE.md` briefing to clone the upstream tree
repo into the path (the briefing carries the upstream URL, branch, and
a ready `git clone` command). If the path exists as a **symlink**
(legacy shared-pool layout), remove only the symlink and clone per the
briefing.

Once the directory exists you do **not** need a manual fetch/pull:
`first-tree tree tree` (the reader command, see `first-tree-read`)
runs `git pull --ff-only` on the context repo before every listing, so
freshness is a built-in tool guarantee rather than a step you have to
remember. It degrades to the local copy with a warning when the remote
is unreachable (offline / missing credentials → report to a human and
read local), and `--no-pull` opts out for a deliberately stable
snapshot. Stale tree content is the #1 source of advice that conflicts
with current decisions, so let the default pull run.

### 3. Source vs. workspace vs. tree role-fork

W1 reduces "what kind of root are you at" to three positions, all of
which are computable from `workspaceRoot` + `cwd`:

- **Tree** — `cwd` resolves to or under `<workspaceRoot>/<manifest.tree>`.
  Use this for direct tree reads / writes.
- **Source** — `cwd` resolves to or under one of the source clones at
  `<workspaceRoot>/<manifest.sourcesRoot>/<manifest.sources[i]>` (i.e.
  `<workspaceRoot>/source-repos/<name>`; a legacy flat manifest without
  `sourcesRoot` keeps them at `<workspaceRoot>/<name>`).
  Use this for source-side tasks.
- **Workspace** — `cwd` is `<workspaceRoot>` itself, or sits outside any
  declared tree / source. Use this when the task spans multiple sources
  or is about the workspace as a whole.

Confirm the role you're acting under matches what the user asked for:

- User said "the tree": you should be at or under the tree subdir.
- User said "this repo" / "this codebase": likely one of the source
  subdirs.
- User said "all our repos" / "the workspace": you can be at the
  workspace root.

If the user's intent doesn't match the role you found, **stop and clarify
before acting** — running tree-write commands from inside the wrong root
produces non-obvious damage.

## Sub-skill Routing

Once hygiene checks pass, drop into the right sub-skill:

- Talk to another agent / create a task chat / read full `chat send` mechanics → stay in **this skill** and read `references/agent-communication.md`
- Read context before acting based on the user's task / path / feature signal → **`first-tree-read`**
- Write tree updates from a specific source (PR / doc / note) → **`first-tree-write`**; it owns the source-backed write workflow and rules
- "Is the tree up to date?" (no specific source attached) → **`first-tree-sync`**
- Workspace appears unbound / cwd is not under a tree → operator action: surface to a human (binding is a web-console flow, not an agent flow)

Operator tasks — `login`, `daemon install / uninstall`, `agent create`,
`agent bind`, decommissioning a machine — are not done from inside a
running agent. They are run from the web console or by a human at the
terminal. If a human asks how to do one, point at `docs/cli-reference.md`
and `docs/onboarding-guide.md`.

## References

- [`references/agent-communication.md`](references/agent-communication.md) — full `chat create` / `chat send` / `chat ask` / `chat invite` CLI mechanics (task chat creation / asking humans / markdown / stdin / content-formatting / reaching non-members / mention resolution)
- `scripts/quick_validate.py` — skill frontmatter sanity check (used by `pnpm validate:skill`)
