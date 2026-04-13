---
title: "Source/Workspace Installation Contract"
owners: []
---

# Source/Workspace Installation Contract

This reference defines what it means to install `first-tree` in a source repo,
workspace repo, or non-git workspace folder.

## Core Boundary

- The current source/workspace root is **not** the Context Tree.
- The current source/workspace root carries only:
  - `.agents/skills/first-tree/` and `.claude/skills/first-tree/`
  - `FIRST_TREE.md`
  - a managed `FIRST-TREE-SOURCE-INTEGRATION:` block in `AGENTS.md` and `CLAUDE.md`
  - `.first-tree/local-tree.json`
  - `.first-tree/source.json`
  - `.first-tree/workspace.json` when the root is a workspace
- `NODE.md`, `members/`, and tree-scoped `AGENTS.md` / `CLAUDE.md` belong only
  in the tree repo.
- The tree repo keeps its own installed skill under `.agents/skills/first-tree/`
  and `.claude/skills/first-tree`, plus tree metadata under `.first-tree/tree.json`
  and `.first-tree/bindings/`.

## Binding Modes

`first-tree` currently writes one of four binding modes:

- `standalone-source` — a single repo bound to its own dedicated `<repo>-tree`
- `shared-source` — a single repo bound to an existing shared tree
- `workspace-root` — the current root is a whole workspace
- `workspace-member` — a child repo bound to the workspace's shared tree

## What Lives Where

```text
<source-or-workspace-root>/
  .agents/skills/first-tree/
  .claude/skills/first-tree
  FIRST_TREE.md
  AGENTS.md
  CLAUDE.md
  .first-tree/
    local-tree.json
    source.json
    workspace.json          # workspace roots only

<tree-repo>/
  .agents/skills/first-tree/
  .claude/skills/first-tree
  .first-tree/
    VERSION
    progress.md
    tree.json
    bindings/
      <source-id>.json
    bootstrap.json          # legacy compatibility
  NODE.md
  AGENTS.md
  CLAUDE.md
  members/
    NODE.md
```

## Agent Decision Rule

When an agent is asked to install `first-tree`:

1. Run `first-tree inspect --json`.
2. Ask whether an existing Context Tree already exists.
3. If yes, prefer `first-tree bind`.
4. If no, use `first-tree init`.
5. If the current root is a workspace, follow with `first-tree workspace sync`.

Do not recreate a new sibling tree repo when the user already has a shared tree
they want to keep using.

Whenever a git-backed source/workspace root is bound, keep the binding metadata
pointing at the tree checkout and published tree URL. Do not create hidden
codebase mirrors in the tree repo by default.

## Workspace Rule

If the current root contains many child repos or submodules:

- the workspace root should get local first-tree integration
- all child repos should bind to the same shared tree
- child repos should not each create their own separate tree repos

Only real child git repos / submodules should be synced automatically. Plain
package folders that are not repos do not get repo-level binding metadata.

## Verification And Upgrade

- Verify the tree repo with `first-tree verify`.
- Use `first-tree upgrade` in a source/workspace root to refresh local
  integration.
- Use `first-tree upgrade --tree-path ...` to refresh the tree repo metadata
  plus its installed tree-repo skill.

## Publish Rule

`first-tree publish` is tree-centric:

- it publishes the tree repo
- it refreshes locally bound source/workspace repos with the published tree URL
- it opens a code PR only when exactly one source/workspace repo is being refreshed

That keeps shared trees workable for multi-repo workspaces without forcing
`publish` back into a one-source-only model.
