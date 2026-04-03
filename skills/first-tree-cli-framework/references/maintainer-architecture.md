# Maintainer Architecture

This reference explains how to maintain the `first-tree` source repo itself.

## What This Repo Ships

- One canonical skill: `skills/first-tree-cli-framework/`
- One thin CLI package: the `context-tree` command distributed by the `first-tree`
  npm package

This repo is not a user context tree. User decision content lives in the repos
that install the framework.

## Canonical Layers

1. `SKILL.md` defines when to use the skill and the maintainer workflow.
2. `references/` stores the knowledge an agent needs to maintain the framework
   and the thin CLI without reading repo-local prose.
3. `assets/framework/` stores the runtime payload that gets installed into user
   repos.
4. `engine/` stores the canonical framework and CLI behavior.
5. The root CLI/package files are implementation shell code. They should call
   into the skill-owned engine, not become a second source of framework
   knowledge.

## Non-Negotiables

- Treat `skills/first-tree-cli-framework/` as the only canonical source.
- If a maintainer needs information to safely change behavior, move that
  information into `references/`; do not leave it only in root `README.md`,
  `AGENT.md`, CI comments, or PR descriptions.
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

The intended end state is:

- skill owns knowledge, runtime payload, framework engine, tests, and evals
- root owns only the light CLI/bootstrap/build shell needed to distribute and
  execute the skill

When deciding where a new file should live, bias toward the skill unless the
file is purely package-tooling shell code.
