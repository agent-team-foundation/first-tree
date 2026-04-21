---
name: first-tree
description: Entry point for the first-tree toolkit — Context Tree methodology, the `first-tree` CLI, and routing into the `tree`, `breeze`, and `gardener` product skills. Use whenever a task touches strategic choices, cross-domain relationships, workspace-wide context, Context Tree onboarding, or any `first-tree` CLI command.
---

# First Tree

This is the entry-point skill for the `first-tree` toolkit. It teaches:

1. **What a Context Tree is** — the methodology shared across the toolkit
2. **Which product skill to load** for the specific task in front of you
3. **How to get the `first-tree` CLI** installed and up to date
4. **How skills are managed** on the machine you are working on

If your task needs product-specific operational detail (running commands,
inspecting state, fixing things), follow the routing below to the right
product skill and load that in addition to this one.

## What Is Context Tree

A Context Tree is a git-native, file-based knowledge base that captures **why**
decisions were made and **how** domains relate, not how things are executed.
Each domain is a directory containing a `NODE.md`. Each leaf decision is a
markdown file with frontmatter declaring `title`, `owners`, and optional
`soft_links` to related nodes.

Read `references/whitepaper.md` for the product vision and methodology, and
`references/principles.md` for the four core principles you must follow when
reading or writing nodes.

## When To Use This Skill

Trigger this skill when you are asked to:

- Read or update any `NODE.md` or leaf node
- Make a decision that affects multiple domains or repos
- Check ownership before editing a node
- Onboard a new repo, shared tree, or workspace root
- Run any `first-tree` CLI command
- Investigate why a particular decision was made
- Install, update, or inspect the `first-tree` skills on this machine

Do **not** use this skill for routine code edits that do not touch decisions,
constraints, ownership, or cross-domain relationships.

## Three Products Under One CLI

`first-tree` is an umbrella CLI over three products. Each product has its own
operational skill — load the one that matches your task:

| Product | Skill to load | Use when you need to… |
|---|---|---|
| **tree** | `tree` | Onboard (`init`) / inspect / publish / verify / upgrade a Context Tree repo, or reach for the lower-level primitives (`bind`, `bootstrap`, `integrate`, `workspace sync`) |
| **breeze** | `breeze` | Run or inspect the breeze daemon: install, start/stop/status, watch, one-shot poll, diagnose |
| **gardener** | `gardener` | Install the push-mode workflow, run the pull-mode daemon, or invoke the agent primitives (`sync`, `comment`, `respond`) from CI or breeze |

Each product's `--help` splits its commands into **Primary** (start here) and
**Advanced / Agent** (primitives invoked by the daemon, breeze dispatch, or CI).
Humans should normally only need the primary set — load the product skill for
the full map.

If you do not know which product you need, start here, skim the table above,
and load whichever skill looks like the closest match. Loading more than one
is fine.

The CLI also exposes one maintenance namespace: `first-tree skill ...`. That
namespace is not a fourth product — it is the toolkit surface for inspecting
and repairing the four shipped skills.

## Before Every Task

1. Read the root `NODE.md`.
2. Read the `NODE.md` of every relevant domain.
3. Follow `soft_links`.
4. Read the leaf nodes that match your task.

Skipping this step produces decisions that conflict with existing ones.

## During The Task

- Decide in the tree, execute in source systems.
- Keep execution detail out of the tree.
- Respect ownership. See `references/ownership-and-naming.md`.

## After Every Task

Always ask: **does the tree need updating?**

- Did the task change decisions, constraints, ownership, or workspace-level relationships?
- Did you discover something the tree failed to capture?
- Did you find outdated tree content?

## Installing And Updating The CLI

Recommended invocation — no install step needed, always runs the latest
published version:

```bash
npx first-tree <namespace> <command>
```

For automation, hooks, and CI templates, prefer the more explicit form:

```bash
npx -p first-tree first-tree <namespace> <command>
```

The CLI auto-checks for updates on every invocation. Pass
`--skip-version-check` to suppress the check for latency-sensitive callers
like SessionStart hooks.

## Managing Skills On This Machine

The `first-tree` toolkit ships four skills: this one (`first-tree`) plus one
per product (`tree`, `breeze`, `gardener`). They live at:

```
.agents/skills/first-tree/
.agents/skills/tree/
.agents/skills/breeze/
.agents/skills/gardener/
```

Each is also mirrored at `.claude/skills/<name>/` via a symlink so both
Claude Code and other agent runtimes discover them.

To install or refresh the shipped skill payloads in the current repo:

```bash
npx first-tree skill install
npx first-tree skill upgrade
```

These commands rewrite the installed skill copies to match the skills bundled
inside the package. Safe to re-run; idempotent.

Use `npx first-tree tree upgrade` when you want the broader
source/workspace integration or tree metadata refreshed too.

To inspect or repair the installed skills directly:

```bash
npx first-tree skill list     # show all four skills + versions
npx first-tree skill doctor   # diagnose install health; exits non-zero on problems
npx first-tree skill link     # repair .claude/skills/* symlinks
```

## Ownership And Editing

- Every directory has a `NODE.md` declaring `owners` in its frontmatter.
- Empty `owners: []` inherits from the parent.
- `owners: [*]` means anyone may edit.
- Otherwise only the listed owners may approve changes.

See `references/ownership-and-naming.md`.

## Files In This Skill

- `SKILL.md` — this file
- `VERSION` — installed skill payload version
- `references/whitepaper.md` — First Tree white paper: Agent Team methodology, principles, and vision
- `references/principles.md` — four core principles with examples
- `references/ownership-and-naming.md` — node naming and ownership model
- `references/onboarding.md` — onboarding narrative for repos, shared trees, and workspaces
- `references/source-workspace-installation.md` — source/workspace binding contract
- `references/upgrade-contract.md` — installed layout and upgrade semantics
- `references/workflow-mode.md` — agent-driven install guide for the gardener push-mode sync workflow (replaces the gardener service with a `.github/workflows/first-tree-sync.yml` in the codebase)

Everything else lives in the `first-tree` npm package and is invoked via the
CLI.
