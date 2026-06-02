---
name: first-tree
version: 0.5.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Top-level routing skill for First Tree. Explains what First Tree is — a unified CLI with two arms: (1) workspace collaboration (agent-to-agent today; agent-to-human is being rebuilt on top of the messages table by the group-chat-unified-send redesign), and (2) Context management. Use when you need a high-level "what is First Tree" map, are unsure whether the task is workspace or context, or need to enforce per-task hygiene before acting (binding check, tree HEAD freshness, source vs. workspace classification). For workspace tasks go to `first-tree-cloud`; for context tasks go to `first-tree-context`.
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

### 1. Binding check

```bash
first-tree tree inspect --json
```

The `role` field tells you what kind of root this is:

The `role` enum is defined in `apps/cli/src/commands/tree/inspect.ts` —
six possible values:

| `role` | What you're looking at | Where to go next |
|---|---|---|
| `tree-repo` | The Context Tree repo itself | Use `first-tree-context` to read/write tree content directly. Do not run `first-tree-onboarding` here. |
| `source-repo-bound` | A source repo bound to a tree | OK to proceed with any source-side task. |
| `workspace-root-bound` | A workspace root (multi-repo container) bound to a tree | OK to proceed; workspace-member sub-repos inherit the binding. |
| `unbound-source-repo` | A git repo with no `FIRST-TREE-SOURCE-INTEGRATION` block | Run `first-tree-onboarding` first. Do not skip — downstream skills depend on the binding. |
| `unbound-workspace-root` | A multi-repo workspace root with no binding | Run `first-tree-onboarding --scope workspace` first. |
| `unknown` | Cannot classify (folder without git, or unexpected state) | Re-check `cwd`; if intentional, run `first-tree tree inspect` (without `--json`) and read the human-readable summary before deciding. |

### 2. Tree HEAD freshness

If the binding points at a tree checkout that exists locally, verify it is
not stale:

```bash
git -C <tree.localPath> fetch origin
git -C <tree.localPath> log -1 --since=24h --oneline
```

If `log` is empty (no commit in 24h) or the local HEAD is behind
`origin/main`, `git pull` before reading any tree content. Stale tree
content is the #1 source of advice that conflicts with current decisions.

### 3. Source vs. workspace vs. tree role-fork

Many skills branch on the three roles in §1. Confirm the role you're acting
under matches what the user asked for:

- User said "the tree": you should be in `tree-repo`.
- User said "this repo" / "this codebase": likely `source-repo-bound` (or
  the source half of a `workspace-root-bound` parent).
- User said "all our repos" / "the workspace": likely `workspace-root-bound`.

If the user's intent doesn't match the role you found, **stop and clarify
before acting** — running tree-write commands from inside the wrong root
produces non-obvious damage.

## Sub-skill Routing

Once hygiene checks pass, drop into the right sub-skill:

- Talk to another agent / send a chat / install daemon / change agent config → **`first-tree-cloud`**
- Ask a human a question / notify a human of an event → **for now, use `chat send` via `first-tree-cloud`**. The dedicated NHA primitive was removed in PR #747; a message-archetype rebuild is in flight via the `group-chat-unified-send` proposal. A `first-tree-attention` skill will return once that rebuild lands.
- Don't know what a Context Tree is / need ownership / node concepts → **`first-tree-context`**
- Bind an unbound repo to a tree → **`first-tree-onboarding`**
- "Is the tree up to date?" (no specific source attached) → **`first-tree-sync`**
- "Reflect this PR / doc / note into the tree" (specific source given) → **`first-tree-write`**
- Daemon spawned an agent for a GitHub notification → **`first-tree-github-scan`**

Do not invent new top-level CLI groups when acting on the current repo. If a
workflow needs more automation than the CLI already offers, keep the
orchestration inside the relevant sub-skill until the shared logic is worth
extracting.
