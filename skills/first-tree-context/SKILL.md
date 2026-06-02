---
name: first-tree-context
version: 0.5.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Context Tree concepts and routing sub-entry. Explains what a Context Tree is, the ownership model, what belongs in a node vs. a source system, and how to navigate domains and soft_links. Use whenever you need shared Context Tree concepts, are unsure whether your task is onboarding / sync / write, or need the structural primer before acting on the tree. For binding a repo, use `first-tree-onboarding`; for drift audit, `first-tree-sync`; for writing from a specific source, `first-tree-write`.
---

# First Tree — Context Management

This skill is the sub-entry for the Context-management arm of First Tree.
Load it whenever your task is about a Context Tree — its content, ownership,
or maintenance — and you need the shared concepts before acting.

For the workspace-collaboration arm (talking to other agents), see
`first-tree-cloud` instead. For the top-level "what is First Tree" picture,
see `first-tree`. (Asking humans via dedicated NHA was removed in PR #747
and is being rebuilt on top of messages; use plain `chat send` until the
new archetype lands.)

## Core Model

A Context Tree revolves around three objects:

1. `source/workspace root` — where the team or agent does implementation work
2. `tree repo` — the Git repo that stores durable decisions and ownership
3. `binding` — the metadata that connects the source/workspace root to the tree repo

Use the tree for decisions, constraints, ownership, and cross-repo
relationships. Keep execution detail in source systems.

## Sub-skill Map

Use the skill that matches the job:

- `first-tree-onboarding` — connect a repo or workspace to a Context Tree (one-shot)
- `first-tree-sync` — audit drift between merged code and tree content (no specific source material)
- `first-tree-write` — write tree updates from one specific source (PR / doc / note)

If you are unsure which one applies, stay here and read `references/cli-manual.md`.

## CLI Map (Context arm)

- `first-tree tree` — tree lifecycle, bindings, validation, publish, automation, and skill maintenance

Do not invent new top-level CLI groups when acting on the current repo. If a
workflow needs more automation than the CLI already offers, keep the
orchestration inside the skill until the shared logic is worth extracting.

## Working Rules

- Read the relevant tree nodes before making cross-repo decisions.
- Prefer `first-tree-onboarding` when the repo is not yet bound.
- Prefer `first-tree-sync` for broad drift audits and `first-tree-write` for
  tasks tied to one specific source artifact.

## References

- `references/structure.md` — tree objects, files, and binding shape
- `references/functions.md` — what the tree is for
- `references/anti-patterns.md` — what not to put in the tree
- `references/maintenance.md` — update discipline and review flow
- `references/cli-manual.md` — current CLI map and status
- `references/llms.txt` — short machine-facing overview
