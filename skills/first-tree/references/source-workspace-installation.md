---
title: "Source/Workspace Installation Contract"
owners: []
---

# Source/Workspace Installation Contract

This reference defines what it means to "install and use first-tree" in an
existing source or workspace repository.

## Core Boundary

- The current source/workspace repo is **not** the Context Tree.
- The current source/workspace repo should carry only the installed
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/` skill roots
  plus `FIRST_TREE.md` and a managed `FIRST-TREE-SOURCE-INTEGRATION:` section
  in root `AGENTS.md` and `CLAUDE.md`.
- `NODE.md`, `members/`, and tree-scoped `AGENTS.md` / `CLAUDE.md` content
  belong only in a dedicated `*-context` repo.
- The dedicated tree repo keeps its local CLI metadata under `.first-tree/`
  instead of installing another copy of the `first-tree` skill.
- If a task changes decisions, rationale, ownership, or constraints, update
  the dedicated tree repo rather than copying that material into the source
  repo.

## Agent Decision Rule

- Treat "install and use first-tree" in a source/workspace repo as a two-repo
  workflow: local integration in the current repo plus tree bootstrap in a
  sibling `*-context` repo.
- Do not run `first-tree init --here` in the source/workspace repo unless the
  user explicitly says that repo itself should become the Context Tree.
- If you cannot create the sibling repo locally, cannot push it to GitHub, or
  cannot add the submodule yet, pause and report the blocker. Do not fall back
  to creating `NODE.md`, `members/`, or tree-scoped `AGENTS.md` / `CLAUDE.md`
  in the source/workspace repo.

## Default Agent Workflow

When an agent is asked to install first-tree for a source/workspace repo, the
default workflow is:

1. Run `first-tree init` from the current source/workspace repo.
   You may add `--seed-members contributors` to draft initial
   `members/*/NODE.md` files from repository contributor history during the
   bootstrap.
2. Switch into the sibling dedicated tree repo named `<repo>-context`.
3. Draft the first tree version from the real codebase, docs, and ownership
   signals.
4. Read `.first-tree/progress.md` as the source of truth for the
   onboarding checkpoint, report setup/integration progress separately from
   tree-content baseline coverage, and ask whether to continue the first-pass
   full-tree expansion.
5. If the user confirms, expand the tree with wave-based parallel sub-tasks or
   subagents, usually one per top-level domain, while the main agent keeps
   ownership of the root `NODE.md`, cross-domain `soft_links`, and the final
   `first-tree verify` pass.
6. Run `first-tree publish --open-pr` from the dedicated tree repo. It will:
   create or reuse the GitHub `*-context` repo in the same owner/org as the
   source repo, push the tree, add it back to the source/workspace repo as a
   `git submodule`, and open the source-repo PR.
7. After publish succeeds, treat the source repo's submodule checkout as the
   canonical local working copy for the tree. The temporary sibling bootstrap
   checkout can be deleted when you no longer need it.

If the dedicated tree repo was initialized manually with `first-tree init --here`
and publish cannot infer the source repo, pass `--source-repo PATH`.

## Routine Work After Publish

- Start routine work from the current source/workspace repo's tracked Context
  Tree submodule checkout.
- Before you read the tree, sync submodules to the commits recorded by the
  current superproject.
- If the tree submodule directory exists but is not initialized locally,
  initialize only that submodule. Do not update every submodule in the
  workspace by default.
- Fall back to the sibling `*-context` bootstrap checkout only before the tree
  has been published back to the source/workspace repo as a tracked submodule.
- At task close-out, always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, or ownership, send
  the tree PR first, then update the source repo's submodule pointer and send
  the source/workspace code PR.
- If the task changed only implementation detail, skip the tree PR and send
  only the source/workspace code PR.

## Verification And Upgrade

- Do not run `first-tree verify` in the source/workspace repo. Verify the
  dedicated tree repo instead, for example
  `first-tree verify --tree-path ../my-repo-context`.
- Running `first-tree upgrade` in the source/workspace repo refreshes only
  the local installed skill, `FIRST_TREE.md`, and the
  `FIRST-TREE-SOURCE-INTEGRATION:` section.
- Run `first-tree upgrade --tree-path ../my-repo-context` to upgrade the
  dedicated tree repo itself. That repo keeps its progress and version markers
  under `.first-tree/`.
