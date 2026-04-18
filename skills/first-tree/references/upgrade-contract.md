# Upgrade Contract

This file describes the installed layout in user repos and how
`first-tree skill upgrade` and `first-tree tree upgrade` refresh it.

## Two Distribution Channels

The `first-tree` npm package ships two things:

1. **CLI tools** — engine, runtime, validators, helpers, templates, and
   workflows. Users invoke them with `npx -p first-tree first-tree <command>`.
2. **Skill payload** — `SKILL.md`, `references/`, and `VERSION`. This is copied
   into user repos and refreshed by `first-tree tree upgrade`.

The skill payload contains knowledge only. Executable behavior stays in the CLI.

## Versioning

Three-level: `major.minor.patch`.

- `major` — milestone resets
- `minor` — shipped skill payload changes
- `patch` — CLI/runtime behavior changes

The installed skill `VERSION` tracks `major.minor`.

## Installed Layout

In a source/workspace root, `first-tree tree init` / `first-tree tree bind` produce:

```text
.agents/skills/first-tree/
.claude/skills/first-tree
WHITEPAPER.md
AGENTS.md
CLAUDE.md
.first-tree/
  source.json             # includes workspace members for workspace roots
```

In a tree repo, `first-tree tree bootstrap` produces:

```text
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

## Wipe-And-Replace Upgrade

`first-tree skill upgrade` in any repo/workspace root:

1. wipes previous installed skill locations
2. reinstalls `.agents/skills/first-tree/`
3. recreates the `.claude/skills/first-tree` symlink
4. also installs the product skills under `.agents/skills/{tree,breeze,gardener}/`
5. preserves everything outside the skill directories

`first-tree tree upgrade` in a source/workspace root additionally refreshes
`WHITEPAPER.md`, the managed `FIRST-TREE-SOURCE-INTEGRATION:` block, and other
source/workspace integration files while preserving `.first-tree/source.json`.

`first-tree tree upgrade --tree-path ...` in a tree repo refreshes tree-side
metadata such as `.first-tree/VERSION` plus the installed tree-repo skill.

## What Gets Preserved

- tree content: `NODE.md`, domains, members, leaf nodes
- user-authored content outside the managed framework markers
- source/workspace binding metadata
- local checkout guidance in `.first-tree/source.json`

## Command Intent

- `first-tree tree inspect`
  - classify the current root before onboarding
- `first-tree tree init`
  - high-level onboarding wrapper
  - creates a dedicated tree by default for a single repo
  - prefers a shared tree for workspace roots
- `first-tree tree bootstrap`
  - low-level tree bootstrap for an explicit tree checkout
- `first-tree tree bind`
  - connect a source/workspace root to an existing tree repo
- `first-tree tree workspace sync`
  - bind child repos to the same shared tree
- `first-tree tree publish`
  - publish the tree repo
  - refresh locally bound source/workspace repos with the published URL
- `first-tree tree verify`
  - validate the tree repo
- `first-tree tree upgrade`
  - refresh local integration or tree metadata
- `first-tree skill install`
  - install the four shipped skills only
- `first-tree skill upgrade`
  - wipe and reinstall the four shipped skills only

## Invariants

- the installed skill is read-only knowledge and may be overwritten on upgrade
- tree content remains decision-focused
- workspace child repos should share one tree, not create many parallel trees
- shared tree bindings should live in `.first-tree/bindings/`, not in a single
  overwrite-prone bootstrap file
- source/workspace roots should keep referencing the tree through binding
  metadata and `.first-tree/source.json`
