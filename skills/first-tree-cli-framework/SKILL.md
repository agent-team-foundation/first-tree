---
name: first-tree-cli-framework
description: Work on the `first-tree` CLI repo and its shipped `.context-tree` framework. Use when Codex needs to modify or validate `context-tree` commands (`init`, `verify`, `upgrade`, `help onboarding`), update `.context-tree/` templates/workflows/scripts/docs, maintain validator or rule logic around `NODE.md`, `AGENT.md`, `members/`, `owners`, `soft_links`, `progress.md`, or `CODEOWNERS`, or understand the full Context Tree maintenance model implemented in this repo.
---

# First Tree CLI Framework

## Overview

Use this skill when the task lives inside the `first-tree` repository or depends on the exact behavior of the framework that `first-tree` ships to user repos. Treat the repo as two coupled products: the CLI under `src/` and the framework payload under `.context-tree/`.

## Non-Negotiables

- Treat `first-tree` as the template source and CLI, not as a Context Tree repo itself.
- Preserve the contract that the CLI is a harness for agents: it scaffolds, prints task lists, and validates state; it does not replace human approval or perform all maintenance automatically.
- Keep `.context-tree/` generic. Anything in that directory can be copied into user repos by `context-tree init`.
- Keep decision knowledge in the tree and execution detail in source systems. Re-check this boundary in `references/context-tree-maintenance-principles.md` whenever a change makes it blurry.

## Quick Start

1. Read `../../AGENTS.md` and `../../README.md`.
2. Read `references/context-tree-maintenance-principles.md` for the operating model.
3. Read `references/context-tree-source-map.md` to locate the exact source files for the task.
4. Run `bash ./scripts/locate-context-tree-source.sh <topic>` when you want a task-specific reading list before opening files.
5. Use `./scripts/run-local-cli.sh <command>` from this skill directory when you need repo-local CLI behavior. The script builds the local CLI and runs `node dist/cli.js ...` from the repo root.
6. After edits, run the smallest relevant check first, then the default repo checks: `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Command Workflow

- Run `./scripts/run-local-cli.sh --help` to confirm top-level usage.
- Run `./scripts/run-local-cli.sh help onboarding` to inspect the onboarding document wired through `src/onboarding.ts`.
- Run `./scripts/run-local-cli.sh init` to exercise framework copy, template rendering, upstream remote setup, and progress generation.
- Run `./scripts/run-local-cli.sh verify` to exercise progress checks plus node/member validation.
- Run `./scripts/run-local-cli.sh upgrade` to exercise upstream version comparison and upgrade task generation.
- Run `bash ./scripts/locate-context-tree-source.sh --list` to see the supported reading topics.
- Prefer the local runner while editing this repo. Use a published/global `context-tree` binary only when the task is explicitly about consumer-side usage outside the repo.

## Task Playbooks

### CLI, Rules, and Validators

- Inspect the command module in `src/` and the paired test file in `tests/`.
- If a change alters generated task text, also review `src/rules/*.ts`, `.context-tree/templates/`, and the onboarding docs the task text points at.
- If a change alters validation behavior, inspect both `src/validators/*.ts` and any workflow or template content that teaches users how to satisfy those checks.

### Framework Payload

- Read `.context-tree/principles.md`, `.context-tree/ownership-and-naming.md`, templates, workflows, and helper scripts before editing.
- Remember that framework edits affect every repo initialized or upgraded from `first-tree`.
- Keep workflow files, helper scripts, rule text, and docs aligned. If one changes and the others still teach the old behavior, treat that as an incomplete change.

### Tree-Model Questions

- Start with `references/context-tree-maintenance-principles.md`.
- Follow the authoritative file links from `references/context-tree-source-map.md` instead of relying on memory.
- If philosophy and implementation disagree, diagnose the mismatch explicitly and then align docs to code or code to docs before stopping.

## Validation

- Default repo checks: `pnpm typecheck`, `pnpm test`, `pnpm build`
- Targeted CLI smoke checks:
  - `./scripts/run-local-cli.sh --version`
  - `./scripts/run-local-cli.sh help onboarding`
  - `./scripts/run-local-cli.sh --help`
- When changing `.context-tree/generate-codeowners.ts`, cover inheritance, additive leaf owners, and wildcard handling in tests.
- When changing validators, cover hard errors plus warnings/infos where applicable.

## References

- `references/context-tree-maintenance-principles.md`: the maintenance philosophy, ownership model, member model, and validation invariants.
- `references/context-tree-source-map.md`: the authoritative file-by-file map for CLI commands, rules, validators, templates, workflows, and helper scripts.
