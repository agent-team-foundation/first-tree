---
name: first-tree-cli-framework
description: Work on the `first-tree` CLI repo and its shipped `.context-tree` framework. Use when Codex needs to modify or validate `context-tree` commands (`init`, `verify`, `upgrade`, `help onboarding`), update `.context-tree/` templates/workflows/scripts/docs, maintain validator or rule logic around `NODE.md`, `AGENT.md`, `members/`, `owners`, `soft_links`, `progress.md`, or `CODEOWNERS`, or understand the full Context Tree maintenance model implemented in this repo.
---

# First Tree CLI Framework

## Overview

Use this skill when the task depends on the exact behavior of the `first-tree` CLI or the Context Tree framework it ships to user repos. This skill is designed to be portable: if someone copies `skills/first-tree-cli-framework` into another environment, they can still learn the model, inspect a bundled snapshot of the relevant repo files, and get explicit CLI install/run instructions.

## Non-Negotiables

- Treat `first-tree` as the template source and CLI, not as a Context Tree repo itself.
- Preserve the contract that the CLI is a harness for agents: it scaffolds, prints task lists, and validates state; it does not replace human approval or perform all maintenance automatically.
- Keep `.context-tree/` generic. Anything in that directory can be copied into user repos by `context-tree init`.
- Keep decision knowledge in the tree and execution detail in source systems. Re-check this boundary in `references/context-tree-maintenance-principles.md` whenever a change makes it blurry.

## Quick Start

1. Read `references/portable-quickstart.md`.
2. Read `references/repo-snapshot/AGENTS.md` and `references/repo-snapshot/README.md`.
3. Read `references/context-tree-maintenance-principles.md` for the operating model.
4. Read `references/context-tree-source-map.md` to locate the exact bundled files for the task.
5. Run `bash ./scripts/locate-context-tree-source.sh <topic>` when you want a task-specific reading list before opening files.
6. Use `./scripts/run-local-cli.sh <command>` from this skill directory:
   - inside a live `first-tree` checkout, it builds and runs the local CLI
   - outside the repo, it falls back to an installed `context-tree` binary if available
7. If you are maintaining the skill inside the live repo and you change the framework or source references, refresh the bundled snapshot with `bash ./scripts/sync-portable-snapshot.sh`.

## Command Workflow

- Run `./scripts/run-local-cli.sh --help` to confirm top-level usage.
- Run `./scripts/run-local-cli.sh help onboarding` to inspect the onboarding document wired through `src/onboarding.ts`.
- Run `./scripts/run-local-cli.sh init` to exercise framework copy, template rendering, upstream remote setup, and progress generation.
- Run `./scripts/run-local-cli.sh verify` to exercise progress checks plus node/member validation.
- Run `./scripts/run-local-cli.sh upgrade` to exercise upstream version comparison and upgrade task generation.
- Run `bash ./scripts/locate-context-tree-source.sh --list` to see the supported reading topics.
- Prefer the local runner while editing this repo. Use a published/global `context-tree` binary only when the task is explicitly about consumer-side usage outside the repo.

## Portable Snapshot

- `references/repo-snapshot/` contains a bundled snapshot of the key `first-tree` repo materials that this skill depends on.
- The snapshot includes:
  - the full current `.context-tree/` directory
  - docs that explain the product and onboarding model
  - CLI source files, rule modules, validator modules, and tests used by this skill
- When the skill is copied elsewhere, treat the snapshot as the portable source of truth.
- When the skill is used inside a live `first-tree` checkout, compare the snapshot against the live repo before making changes so you do not reason from stale copies.

## Task Playbooks

### CLI, Rules, and Validators

- Inspect the bundled command module in `references/repo-snapshot/src/` and the paired test file in `references/repo-snapshot/tests/`.
- If a change alters generated task text, also review `references/repo-snapshot/src/rules/*.ts`, `references/repo-snapshot/.context-tree/templates/`, and the bundled onboarding docs the task text points at.
- If a change alters validation behavior, inspect both `references/repo-snapshot/src/validators/*.ts` and any bundled workflow or template content that teaches users how to satisfy those checks.

### Framework Payload

- Read `references/repo-snapshot/.context-tree/principles.md`, `references/repo-snapshot/.context-tree/ownership-and-naming.md`, templates, workflows, and helper scripts before editing.
- Remember that framework edits affect every repo initialized or upgraded from `first-tree`.
- Keep workflow files, helper scripts, rule text, docs, and the bundled snapshot aligned. If one changes and the others still teach the old behavior, treat that as an incomplete change.

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

- `references/portable-quickstart.md`: installation and usage guidance for a copied skill folder.
- `references/context-tree-maintenance-principles.md`: the maintenance philosophy, ownership model, member model, and validation invariants.
- `references/context-tree-source-map.md`: the authoritative file-by-file map for the bundled snapshot and nearby helper scripts.
- `references/repo-snapshot/`: the portable snapshot, including the full `.context-tree/` contents from this repo.
