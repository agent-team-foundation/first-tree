# Maintainer Architecture

This reference explains how to maintain the `first-tree` source repo itself.

## What This Repo Ships

- One canonical skill: `skills/first-tree/`
- One pair of tracked local alias entrypoints:
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/`, both
  symlinked back to `skills/first-tree/` in this repo
- One thin CLI package: the `first-tree` command distributed by the `first-tree`
  npm package
- The published package carries that canonical skill directly; normal install
  and upgrade flows should not depend on cloning this source repo

This repo is not a user context tree. User decision content lives in the repos
that install the framework.

When a source/workspace repo installs first-tree, that repo should keep only
the local skill integration plus the managed
`FIRST-TREE-SOURCE-INTEGRATION:` section. Tree content still belongs only in a
dedicated `*-tree` repo. Existing bound `*-context` repos are still supported
and should be preserved.

## Canonical Layers

1. `SKILL.md` defines when to use the skill and the maintainer workflow.
2. `references/` stores the knowledge an agent needs to maintain the framework
   and the thin CLI without reading repo-local prose.
3. `assets/framework/` stores the runtime payload that gets installed into user
   repos.
4. `engine/` stores the canonical framework and CLI behavior.
5. `tests/` store the canonical skill validation surface.
6. The root repo may also keep maintainer-only developer tooling such as
   `evals/` when that tooling should not ship with the skill.
7. The root CLI/package files are implementation shell code. They should call
   into the skill-owned engine and validation surface, not become a second
   source of framework knowledge.

## Non-Negotiables

- Treat `skills/first-tree/` as the only canonical source.
- Keep `.agents/skills/first-tree/` and `.claude/skills/first-tree/` as
  symlink aliases only; do not turn them into copied mirrors in this repo.
- If a maintainer needs information to safely change behavior, move that
  information into `references/`; do not leave it only in root `README.md`,
  `AGENTS.md`, CI comments, or PR descriptions.
- Keep runtime assets generic. They are copied into every user tree.
- Keep the CLI thin. Command semantics, upgrade rules, layout contracts, and
  maintainer guidance should belong to the skill.
- Keep the user tree decision-focused. Execution detail stays in source systems.

## Change Discipline

- Path or layout changes: update `references/upgrade-contract.md`, task text,
  validators, and tests together.
- Shipped payload changes: update `assets/framework/`, the maintainer references
  that describe the contract, and the validation surface together.
- Thin shell changes: update the relevant maintainer reference before or during
  the code change so the skill remains self-sufficient.

## End-State Target

- skill owns knowledge, runtime payload, framework engine, and the canonical
  framework test surface
- root owns only the light CLI/bootstrap/build shell plus maintainer-only
  developer tooling such as `evals/`

When deciding where a new file should live, bias toward the skill unless the
file is purely package-tooling shell code.
