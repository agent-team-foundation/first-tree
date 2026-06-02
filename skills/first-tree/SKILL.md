---
name: first-tree
version: 0.6.0
cliCompat:
  first-tree: ">=0.6.0 <0.7.0"
description: Top-level routing skill for First Tree. Explains what First Tree is — a unified CLI with two arms: (1) workspace collaboration (agent-to-agent today; agent-to-human is being rebuilt on top of the messages table by the group-chat-unified-send redesign), and (2) Context management. Use when you need a high-level "what is First Tree" map, are unsure whether the task is workspace or context, or need to enforce per-task hygiene before acting (workspace binding check, tree HEAD freshness, source vs. workspace classification). For workspace tasks go to `first-tree-cloud`; for context tasks go to `first-tree-context`.
---

# First Tree — Top-Level Routing

This is the **dispatcher** for everything First Tree does. Load it before
any other first-tree skill so you (a) know what First Tree is, (b) run the
mandatory pre-task hygiene checks, and (c) pick the right sub-skill.

## What First Tree Is

First Tree is a unified CLI (`first-tree …`) for agent teams. It has two
arms — pick the right one before acting:

| Arm | What it does | Sub-skills |
|---|---|---|
| **Workspace collaboration** | How agents talk to each other inside a shared workspace (chat send / invite, daemon, agent config). Asking humans was previously NHA / `first-tree attention`; that primitive was removed in PR #747 and is being rebuilt on top of the messages table by `group-chat-unified-send` (see proposal); for now, do agent-to-human via plain `chat send`. | `first-tree-cloud` (agent ↔ agent + machine ops) |
| **Context management** | Authoring, maintaining, and reading a Context Tree — the shared knowledge repo | `first-tree-context` (concepts) · `first-tree-onboarding` · `first-tree-sync` · `first-tree-write` · `first-tree-github-scan` |

If your task touches both arms, do the workspace ops first (so you can ask
another agent or the human in chat), then the context ops.

## Mandatory Pre-Task Hygiene

Before invoking any first-tree CLI command on the current repo, run these
three checks **in order**. They are cheap, they prevent the most common
class of mistakes (acting on stale state or the wrong role), and the
downstream skills assume you have done them.

### 1. Workspace binding check

```bash
first-tree tree status --json
```

The workspace-rooted layout (W1, shipped 2026-06) consolidates all
binding state into a single file at
`<workspace-root>/.first-tree/workspace.json`. `tree status` walks up
from `cwd` looking for that file, then reports:

| Field | What you're looking at | Where to go next |
|---|---|---|
| `workspaceRoot` | absolute path to the workspace dir | OK to proceed; all sub-skills assume cwd is at or under this path. |
| `manifest.tree` | the tree subdirectory name (sibling of source repos under `workspaceRoot`) | Use `<workspaceRoot>/<manifest.tree>` for any tree read or write. |
| `manifest.sources` | bound source repo subdirectory names | Each is a sibling of the tree under `workspaceRoot`. |
| `boundSources[].present === false` | a bound source is listed but not cloned locally | `git clone` it as a sibling of the tree, or remove from `sources` if it should not be tracked. |
| `unboundGitSiblings[]` | a git repo under `workspaceRoot` that is not in `sources` | If it should be part of the team's context, add its name to `workspace.json.sources`. |

If `status` exits with "not inside a First Tree workspace", the current
cwd is unbound. Run `first-tree-onboarding` before doing context work.

For workspaces that have not yet been migrated from the legacy
multi-mode binding (`.first-tree-workspace` marker + tree/`.first-tree/bindings/`),
`status` falls back to the legacy `inspect` reporter — that's a signal to
run `first-tree tree migrate-to-w1` next.

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

- Talk to another agent / send a chat / install daemon / change agent config → **`first-tree-cloud`**
- Ask a human a question / notify a human of an event → **for now, use `chat send` via `first-tree-cloud`**. The dedicated NHA primitive was removed in PR #747; a message-archetype rebuild is in flight via the `group-chat-unified-send` proposal. A `first-tree-attention` skill will return once that rebuild lands.
- Don't know what a Context Tree is / need ownership / node concepts → **`first-tree-context`**
- Bind an unbound repo to a tree, or migrate a legacy multi-mode workspace to W1 → **`first-tree-onboarding`**
- "Is the tree up to date?" (no specific source attached) → **`first-tree-sync`**
- "Reflect this PR / doc / note into the tree" (specific source given) → **`first-tree-write`**
- Daemon spawned an agent for a GitHub notification → **`first-tree-github-scan`**

Do not invent new top-level CLI groups when acting on the current repo. If a
workflow needs more automation than the CLI already offers, keep the
orchestration inside the relevant sub-skill until the shared logic is worth
extracting.
