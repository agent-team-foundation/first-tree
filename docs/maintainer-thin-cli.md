# Thin CLI Shell

Use this reference when changing the root CLI/package shell.

## Shell Responsibilities

The shell should:

- parse commands and flags
- expose help and version
- dispatch into `src/engine/`
- stay thin

## Current CLI Surface

Top-level user commands:

- `inspect`
- `init`
- `bind`
- `workspace`
- `publish`
- `verify`
- `upgrade`
- `review`
- `generate-codeowners`
- `inject-context`
- `help`

## Rules For Shell Changes

- keep onboarding semantics in the skill references, not only in `src/cli.ts`
- if `inspect` / `bind` / `workspace sync` / `publish` behavior changes, update
  `skills/first-tree/references/onboarding.md`,
  `skills/first-tree/references/source-workspace-installation.md`, and
  `skills/first-tree/references/upgrade-contract.md`
- keep root prose short; detailed operational knowledge belongs in the skill
