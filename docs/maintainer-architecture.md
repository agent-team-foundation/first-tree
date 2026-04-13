# Maintainer Architecture

This repo ships one canonical skill plus one thin CLI package.

## Core Model

The user-facing system is now built around three explicit objects:

1. `source/workspace root`
2. `tree repo`
3. `binding`

Bindings are stored in:

- source/workspace roots: `.first-tree/source.json` and `.first-tree/workspace.json`
- tree repos: `.first-tree/tree.json` and `.first-tree/bindings/<source-id>.json`

The tree repo may also generate a human/agent-facing `source-repos.md` index
from those bindings, but the JSON files remain the canonical machine-readable
source of truth.

That replaces the old one-source-at-a-time mental model that depended too
heavily on one mutable bootstrap file.

## Canonical Layers

1. `skills/first-tree/` owns user knowledge.
2. `assets/framework/` owns shipped runtime assets.
3. `src/engine/` owns behavior.
4. `tests/` own the main validation surface.
5. root package files own only packaging / shell concerns.

## Non-Negotiables

- keep `.agents/skills/first-tree/` and `.claude/skills/first-tree/` as alias
  symlinks in this source repo
- keep source/workspace roots free of tree content
- keep canonical tree-side metadata limited to `.first-tree/tree.json` and
  `.first-tree/bindings/`; any root-level repo index must be derived from those
  files instead of becoming a second source of truth
- keep shared-tree behavior expressed through bindings, not heuristics alone
- update docs, code, and tests together whenever the binding schema changes

## End-State Target

- `inspect` classifies before mutating
- `bind` owns source/tree connection
- `init` is a high-level wrapper, not the only place where all logic lives
- `workspace sync` handles member repos explicitly
- `publish` treats the tree repo as primary and refreshes local bindings second
