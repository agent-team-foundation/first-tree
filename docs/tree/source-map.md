# Source Map

This document is the quickest reading path for contributors working in the
restructured workspace.

## Start Here

1. [README.md](../README.md)
2. [docs/cli-restructure-migration.md](./cli-restructure-migration.md)
3. [docs/skill-topology.md](./skill-topology.md)
4. [docs/onboarding.md](./onboarding.md)

## CLI Entry

- [`apps/cli/src/index.ts`](../apps/cli/src/index.ts): root program, version,
  global flags, all-commands appendix
- [`apps/cli/src/commands/index.ts`](../apps/cli/src/commands/index.ts): top-level command registration
- [`apps/cli/src/commands/tree/index.ts`](../apps/cli/src/commands/tree/index.ts): proposal-aligned tree surface
- [`apps/cli/src/commands/github/index.ts`](../apps/cli/src/commands/github/index.ts): public `github scan` entry
- [`apps/cli/src/commands/github/scan-binding.ts`](../apps/cli/src/commands/github/scan-binding.ts): tree-binding fail-closed logic

## GitHub Scan Runtime

- [`packages/github-scan/src/cli.ts`](../packages/github-scan/src/cli.ts): package-local CLI entry
- [`packages/github-scan/src/github-scan/cli.ts`](../packages/github-scan/src/github-scan/cli.ts): dispatcher and help text
- [`packages/github-scan/src/github-scan/engine/commands/`](../packages/github-scan/src/github-scan/engine/commands): command implementations
- [`packages/github-scan/src/github-scan/engine/daemon/`](../packages/github-scan/src/github-scan/engine/daemon): long-running runtime
- [`packages/github-scan/src/github-scan/engine/runtime/`](../packages/github-scan/src/github-scan/engine/runtime): parsing, config, paths, task state
- [`packages/github-scan/README.md`](../packages/github-scan/README.md): package-level overview

## Canonical Skills

- [`skills/first-tree/`](../skills/first-tree): whitepaper and routing skill
- [`skills/first-tree-onboarding/`](../skills/first-tree-onboarding): onboarding workflow skill
- [`skills/first-tree-sync/`](../skills/first-tree-sync): drift audit skill
- [`skills/first-tree-write/`](../skills/first-tree-write): source-driven tree writing skill
- [`skills/first-tree-github-scan/`](../skills/first-tree-github-scan): notification-handling agent skill
- [`skills/github-scan/`](../skills/github-scan): operator handbook for the daemon CLI

## Tests

- [`apps/cli/tests/`](../apps/cli/tests): umbrella CLI tests
- [`packages/github-scan/tests/`](../packages/github-scan/tests): GitHub scan runtime tests

## Historical Reference

The old backup repo still holds the fuller pre-workspace implementation and the
older README voice. Use it as a reference when porting behavior back, but land
new code under the proposal's current public names.
