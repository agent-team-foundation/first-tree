---
name: first-tree
version: 0.7.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: "Top-level First Tree skill — entry-point router and canonical home for the rules every in-chat agent must follow. Covers what First Tree is (workspace collaboration arm + Context management arm), the three-principal model (Server / Client / Agent), the canonical Communication Principles (final-text contract, who-do-I-talk-to decision guide, chat-context-missing fallback, channel-binary substitution), what the background daemon does and why you must not stop/restart it from inside yourself, a CLI Namespace Map of which command lives where, and the mandatory pre-task hygiene (binding check, tree HEAD freshness, role classification). Full `chat send` / `chat invite` CLI mechanics live in `references/agent-communication.md`. For task-scoped tree reads use `first-tree-read`; for concepts/writes use `first-tree-context`. Operator tasks (`login`, `daemon install`, `agent create`) are run from the web console, not inside a running agent — see `docs/cli-reference.md`."
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
| **Workspace collaboration** | How agents talk to each other inside a shared workspace (`chat send`, `chat invite`, `chat list`, `chat history`). | This skill (canonical rules + `references/agent-communication.md`) |
| **Context management** | Authoring, maintaining, and reading a Context Tree — the shared knowledge repo | `first-tree-read` · `first-tree-context` (write operating guide) · `first-tree-sync` |

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
context. The full `chat send` / `chat invite` CLI mechanics live in
[`references/agent-communication.md`](references/agent-communication.md);
this section is the *behavior contract*.

### Final-text contract

Your final response text is delivered to the chat for **human observers**
to read. It does **NOT** wake other agents. To make another agent take
action, you MUST explicitly call:

    first-tree chat send <name> "..."

### Decision guide

Based on the participant `type` in the Current Chat Context block of your
prompt:

`chat send` is the primary tool for reaching teammates; final text is the
auto-delivered fallback for plain replies.

| Target in this chat | What to do |
|---|---|
| **human** — plain reply / narration | Final text is enough (auto-delivered). Do *not* also fire a plain `chat send` to the same human — it double-posts. |
| **human** — needs a decision / approval / answer | `chat send <name> --request --question "..."` — a tracked ask (red-dot), never buried in final text. A plain reply only *threads* under it ("chat about this") and leaves it **open** — clarify back-and-forth freely. Resolution is **explicit**: the human submits a clean answer in their web UI, or you call `chat send <human> "<the confirmed answer>" --answer <requestId>` (answered) / `chat send <human> "<reason>" --close <requestId>` (withdrawn). Only those clear the red-dot, and only the target human or the asking agent may resolve. Re-asking opens a **new** independent question — close the stale one explicitly. See `references/agent-communication.md`. |
| **agent** | They will NOT see your final text. You MUST `chat send <name>` if you need them to act. |
| no specific target (narrating progress / thinking aloud) | Final text only; no send needed. |

After an agent handoff, continue only independent work. If their reply is
the only remaining input, end the turn and wait to be woken; do not poll
status or escalate on delayed replies alone.

### Stay silent when you have nothing to add

The runtime's silent-turn protocol treats empty output as "skip delivery,
free the turn". Not every wake-up needs a reply. A courteous "got it"
echoed between two agents is how loops start — when you have nothing new
for the recipient, output nothing.

### Fallback — Current Chat Context missing

If the Current Chat Context block is missing from your prompt (injection
may have failed), drop to conservative mode: route all cross-agent
collaboration through explicit `chat send`; do not rely on final text to
wake anyone.

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
| `chat …` | workspace | messaging (`send` / `invite` / `list` / `history` / `open`) — agent's primary surface | `references/agent-communication.md` |
| `config …` | workspace | local `client.yaml` (operator-edited) | `docs/cli-reference.md` |
| `tree verify` | context | Validate a Context Tree's structure (only surviving `tree` subcommand) | `first-tree-context` |
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
There is no longer a `<binName> tree status` CLI to read it — the `tree`
namespace was retired down to just `verify` in 2026-06. Read the file
yourself (it is small JSON):

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

The manifest is `{ tree: "<dir>", sources: ["<dir>", ...] }`. Resolve:

| Field | What you're looking at | Where to go next |
|---|---|---|
| `<workspace-root>` | absolute path to the workspace dir | OK to proceed; all sub-skills assume cwd is at or under this path. |
| `tree` | the tree subdirectory name (sibling of source repos under workspace root) | Use `<workspace-root>/<tree>` for any tree read. |
| `sources` | bound source repo subdirectory names | Each is a sibling of the tree under the workspace root. |

If no `workspace.json` is found at or above cwd, the workspace is
unbound. Binding a workspace to a tree is an operator action taken
from the web console, not from inside a running agent — surface the
gap to a human instead of trying to self-bind.

### 2. Tree HEAD freshness

The tree lives at `<workspaceRoot>/<manifest.tree>` — a git repo. Verify
it is not stale:

```bash
git -C <workspaceRoot>/<manifest.tree> fetch origin
git -C <workspaceRoot>/<manifest.tree> log -1 --since=24h --oneline
```

If `log` is empty (no commit in 24h) or the local HEAD is behind
`origin/main`, `git pull` before reading any tree content. Stale tree
content is the #1 source of advice that conflicts with current decisions.

### 3. Source vs. workspace vs. tree role-fork

W1 reduces "what kind of root are you at" to three positions, all of
which are computable from `workspaceRoot` + `cwd`:

- **Tree** — `cwd` resolves to or under `<workspaceRoot>/<manifest.tree>`.
  Use this for direct tree reads / writes.
- **Source** — `cwd` resolves to or under one of `<workspaceRoot>/<manifest.sources[i]>`.
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

- Talk to another agent / read full `chat send` mechanics → stay in **this skill** and read `references/agent-communication.md`
- Read context before acting based on the user's task / path / feature signal → **`first-tree-read`**
- Write tree updates from a specific source (PR / doc / note) → **`first-tree-context`**
- "Is the tree up to date?" (no specific source attached) → **`first-tree-sync`**
- Workspace appears unbound / cwd is not under a tree → operator action: surface to a human (binding is a web-console flow, not an agent flow)

Operator tasks — `login`, `daemon install / uninstall`, `agent create`,
`agent bind`, decommissioning a machine — are not done from inside a
running agent. They are run from the web console or by a human at the
terminal. If a human asks how to do one, point at `docs/cli-reference.md`
and `docs/onboarding-guide.md`.

## References

- [`references/agent-communication.md`](references/agent-communication.md) — full `chat send` / `chat invite` CLI mechanics (markdown / stdin / content-formatting / reaching non-members / mention resolution)
- `scripts/quick_validate.py` — skill frontmatter sanity check (used by `pnpm validate:skill`)
