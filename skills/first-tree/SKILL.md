---
name: first-tree
description: Read and update the Context Tree — the living source of truth for cross-domain decisions, constraints, and ownership in this organization. Use whenever a task touches strategic choices, cross-domain relationships, workspace-wide context, or Context Tree onboarding.
---

# First Tree

This skill teaches you how to work with a repo's Context Tree and how to use
the `first-tree` CLI for inspect, bind, init, verify, publish, and upgrade
flows.

## What Is Context Tree

A Context Tree is a git-native, file-based knowledge base that captures **why**
decisions were made and **how** domains relate, not how things are executed.
Each domain is a directory containing a `NODE.md`. Each leaf decision is a
markdown file with frontmatter declaring `title`, `owners`, and optional
`soft_links` to related nodes.

Read `references/about.md` for the product framing and
`references/principles.md` for the four core principles you must follow when
reading or writing nodes.

## When To Use This Skill

Trigger this skill when you are asked to:

- Read or update any `NODE.md` or leaf node in the tree
- Make a decision that affects multiple domains or repos
- Check ownership before editing a node
- Onboard a new repo, shared tree, or workspace root
- Run `first-tree` CLI commands
- Investigate why a particular decision was made

Do **not** use this skill for routine code edits that do not touch decisions,
constraints, ownership, or cross-domain relationships.

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

## CLI Workflow

The CLI now centers on three concepts:

- `source/workspace root`
- `tree repo`
- `binding`

Default onboarding workflow:

1. Run `first-tree inspect --json`.
2. Ask whether the user already has a Context Tree.
3. If they do, use `first-tree bind`.
4. If they do not, use `first-tree init`.
5. If the current root is a workspace, run `first-tree workspace sync` so all
   child repos bind to the same shared tree.

During `bind` / `init`, the CLI also ensures the tree repo has the bundled
`first-tree` skill installed and mirrors each git-backed bound codebase under
`.first-tree/submodules/` in the tree repo.

## CLI Commands

| Command | Purpose |
|---|---|
| `first-tree inspect` | Classify the current folder and report bindings / child repos |
| `first-tree init` | High-level onboarding wrapper for single repos, shared trees, and workspace roots |
| `first-tree init tree` | Low-level tree bootstrap for an explicit tree checkout |
| `first-tree bind` | Bind the current repo/workspace root to an existing tree repo |
| `first-tree workspace sync` | Bind child repos to the same shared tree |
| `first-tree verify` | Validate a tree repo: frontmatter, owners, soft_links, members, progress |
| `first-tree upgrade` | Refresh the installed skill or tree metadata from the bundled package |
| `first-tree publish` | Publish a tree repo to GitHub and refresh locally bound source/workspace repos |
| `first-tree review` | CI helper: run Claude Code PR review against tree changes |
| `first-tree generate-codeowners` | Regenerate `.github/CODEOWNERS` from tree ownership |
| `first-tree inject-context` | Output a Claude Code SessionStart hook payload from `NODE.md` |
| `first-tree help onboarding` | Show the onboarding narrative |

For full options, run `first-tree <command> --help`.

## Installing And Updating The CLI

Recommended invocation:

```bash
npx -p first-tree first-tree <command>
```

This always runs the latest published version. The CLI auto-checks for
updates on every invocation; pass `--skip-version-check` to suppress the
check for latency-sensitive callers like SessionStart hooks.

To refresh the bundled skill payload when a new minor version is released:

```bash
npx -p first-tree first-tree upgrade
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
- `references/about.md` — what Context Tree is, who it is for, why it exists
- `references/principles.md` — four core principles with examples
- `references/ownership-and-naming.md` — node naming and ownership model
- `references/onboarding.md` — onboarding narrative for repos, shared trees, and workspaces
- `references/source-workspace-installation.md` — source/workspace binding contract
- `references/upgrade-contract.md` — installed layout and upgrade semantics

Everything else lives in the `first-tree` npm package and is invoked via the
CLI.
