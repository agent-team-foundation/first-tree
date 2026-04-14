# Thin CLI Shell

Authoritative decision node: `first-tree-skill-cli/thin-cli-shell.md` in the
bound Context Tree.

Use this local reference when changing `src/cli.ts` or the command adapters in
`src/engine/commands/`.

## Shell Responsibilities

The shell should:

- parse commands and flags
- expose help and version
- handle `--skip-version-check`
- dispatch into `src/engine/commands/`
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
- `sync`
- `review`
- `generate-codeowners`
- `invite`
- `join`
- `inject-context`
- `help`

## Local Touchpoints

- `src/cli.ts` — usage text, global flags, and dispatch
- `src/engine/commands/*.ts` — thin command adapters
- `tests/thin-cli.test.ts` — direct CLI smoke coverage
- `tests/cli-e2e.test.ts` — end-to-end command workflow coverage

## Rules For Shell Changes

- Keep onboarding semantics in the skill references and tree nodes, not only in
  `src/cli.ts`.
- If command behavior changes, update the relevant tree node and shipped
  reference docs before relying on the code to explain it.
- Keep root prose short; detailed implementation notes belong here, while
  decision-grade operational knowledge belongs in the tree.
