# CLI Restructure Migration

This workspace follows the proposal in
`first-tree-context/proposals/first-tree-cli-restructure.20260501.md`.

The proposal reshapes the public CLI around two namespaces:

- `first-tree tree`
- `first-tree github`

Inside `github`, the first command group is `scan`, which takes over the old
GitHub inbox / automation runtime previously described as `breeze`.

## Public Path Changes

| Previous path                      | New path                               | Notes                                                                                                    |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `first-tree breeze <subcommand>`   | `first-tree github scan <subcommand>`  | public rename; implementation currently lives in `packages/github-scan`                                  |
| `first-tree skill <subcommand>`    | `first-tree tree skill <subcommand>`   | skill maintenance moves under the tree namespace                                                         |
| `first-tree gardener <subcommand>` | `first-tree-sync` / `first-tree-write` | gardener logic is split into sync and write workflows; `github scan` only routes notifications into them |

## Current Workspace Status

| Surface                                                 | Current state                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tree inspect` / `tree status`                          | implemented in `apps/cli`                                                                                                         |
| `tree help onboarding`                                  | implemented as the current onboarding narrative                                                                                   |
| `tree bind` / `integrate` / `workspace sync` / `verify` | implemented in `apps/cli`                                                                                                         |
| `tree codeowners` / `claude-hook` / `inject`            | implemented in `apps/cli`                                                                                                         |
| `tree init` / `bootstrap` / `publish`                   | implemented in `apps/cli`                                                                                                         |
| `tree upgrade` / `review`                               | implemented in `apps/cli`                                                                                                         |
| `tree skill ...`                                        | implemented for install, upgrade, list, doctor, and link against the canonical shipped `skills/` payloads                         |
| `github scan ...`                                       | implemented by wiring the public CLI to `packages/github-scan`, with runner prompts now pointing at the shipped First Tree skills |
| `first-tree-sync` / `first-tree-write`                  | canonical gardener-logic replacement skills are now the target shape                                                              |

## GitHub Scan Binding Contract

The proposal requires `github scan` to fail closed when it cannot resolve a
Context Tree binding.

This workspace now enforces that rule at the CLI entry for:

- `install`
- `start`
- `run`
- `daemon`
- `run-once`
- `poll`

Resolution order:

1. `--tree-repo <owner/repo>`
2. managed First Tree integration block in `AGENTS.md` / `CLAUDE.md`,
   discovered from the current working directory upward
3. legacy `.first-tree/source.json` fallback during migration

If neither exists, the command stops with an actionable error that points the
user to `first-tree tree bind ...` or `--tree-repo <owner/repo>`.

The following commands remain diagnosable without a binding:

- `status`
- `doctor`
- `stop`
- `cleanup`
- `watch`
- hook/internal entry points such as `statusline` and `status-manager`

## Remaining Port-Back Work

The biggest gaps between this workspace and the historical main branch are:

1. land the remaining tree adoption sweep and release-note updates around the 20260501 proposal
2. deepen the sync/write runtime beyond prompt-level routing into richer tree-task orchestration as the new skills mature

## Contributor Rule Of Thumb

When porting code from the old main branch, prefer:

- proposal names over historical names
- public migration clarity over short-term compatibility hacks
- updating tests and docs in the same PR as the code move
