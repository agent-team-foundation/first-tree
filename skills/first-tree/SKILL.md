---
name: first-tree
version: 0.4.0-alpha.1
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: Canonical whitepaper and routing skill for First Tree. Explains what belongs in a Context Tree, how source or workspace roots, tree repos, and bindings relate, and how the current `first-tree tree`, `first-tree hub`, and `first-tree github scan` surfaces fit together. Use when you need shared First Tree concepts, need to choose between onboarding, sync, write, or GitHub notification workflows, or need the high-level CLI map before acting.
---

# First Tree

This is the single source of truth for First Tree methodology and routing.
Load it before any of the task-specific skills.

## Core Model

First Tree revolves around three objects:

1. `source/workspace root` — where the team or agent does implementation work
2. `tree repo` — the Git repo that stores durable decisions and ownership
3. `binding` — the metadata that connects the source/workspace root to the tree repo

Use the tree for decisions, constraints, ownership, and cross-repo
relationships. Keep execution detail in source systems.

## Skill Map

Use the skill that matches the job:

- `first-tree-onboarding` for connecting a repo or workspace to First Tree
- `first-tree-sync` for auditing drift between merged code and tree content
- `first-tree-write` for writing tree updates from explicit source material
- `first-tree-github-scan` for handling a single GitHub notification inside the daemon path
- `github-scan` for human/operator work on the GitHub scan daemon itself

If you are unsure which one applies, stay here and read `references/cli-manual.md`.

## CLI Map

The current public CLI surface is:

- `first-tree tree` — tree lifecycle, bindings, validation, publish, and skill maintenance
- `first-tree github scan` — GitHub inbox runtime and daemon operations
- `first-tree hub` — reserved namespace for future Hub integration

Do not invent new top-level CLI groups when acting on the current repo. If a
workflow needs more automation than the CLI already offers, keep the orchestration
inside the skill until the shared logic is worth extracting.

## Working Rules

- Read the relevant tree nodes before making cross-repo decisions.
- Prefer `first-tree-onboarding` when the repo is not yet bound.
- Prefer `first-tree-sync` for broad drift audits and `first-tree-write` for explicit sources.
- Treat `first-tree-github-scan` as an agent behavior spec, and use `github-scan`
  for human/operator daemon work.

## References

- `references/structure.md` — tree objects, files, and binding shape
- `references/functions.md` — what the tree is for
- `references/anti-patterns.md` — what not to put in the tree
- `references/maintenance.md` — update discipline and review flow
- `references/cli-manual.md` — current CLI map and status
- `references/llms.txt` — short machine-facing overview
