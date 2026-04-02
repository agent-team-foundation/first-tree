# Agent Instructions for seed-tree

This repo is the **template source and CLI** for Context Tree. It is NOT a context tree itself.

## Repo Structure

- `src/` — TypeScript source for the `context-tree` CLI
  - `src/rules/` — Rule modules that generate situation-aware task lists
  - `src/validators/` — Node, member, and CODEOWNERS validation
- `.context-tree/` — Framework files shipped to users' tree repos by `context-tree init`
- `tests/` — Unit tests (Vitest)
- `docs/` — Introduction and documentation

## Key Concepts

- The CLI is a **harness for the agent** — it generates situation-aware task lists, not executes them
- `.context-tree/` is the framework directory that gets copied wholesale into users' repos
- Templates in `.context-tree/templates/` are rendered to `NODE.md`, `AGENT.md`, `members/NODE.md` in users' repos
- The CLI is installed via npm (`npx context-tree`) — it is never bundled in `.context-tree/`

## Before Making Changes

1. Read [docs/onboarding.md](docs/onboarding.md) — the full onboarding guide for setting up a context tree
2. Read `.context-tree/principles.md` — the core ideas that Context Tree is built on
3. Read `.context-tree/ownership-and-naming.md` — how nodes and ownership work

## Repo-Local Skill

- Use `.codex/skills/first-tree-cli-framework/SKILL.md` when working on `src/cli.ts`, `src/init.ts`, `src/verify.ts`, `src/upgrade.ts`, `.context-tree/`, or any task that needs the exact Context Tree maintenance model implemented in this repo. The skill includes a local CLI runner plus references for rules, validators, templates, workflows, and framework philosophy.

## Rules

- **Framework files** (`.context-tree/`) must stay generic — no org-specific content. These get copied to every user's tree.
- **CLI rules** (`src/rules/`) are TypeScript modules exporting `evaluate(repo): RuleResult`. Add new rules by adding a file and registering it in `src/rules/index.ts`.
- **Zero runtime dependencies** — the CLI uses only Node.js built-in modules.
- **Tests are mandatory** — run `pnpm test` before submitting changes. All tests must pass.

## Testing

```bash
pnpm test                            # all tests
pnpm test tests/rules.test.ts        # specific test file
pnpm typecheck                       # type check
```
