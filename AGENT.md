# Agent Instructions for seed-tree

This repo is the **template source and CLI** for Context Tree. It is NOT a context tree itself.

## Repo Structure

- `context_tree_cli/` — Python package for the `context-tree` CLI (pip-installable)
- `.context-tree/` — Framework files shipped to users' tree repos by `context-tree init`
- `tests/` — Unit tests for both the CLI and the framework scripts
- `docs/` — Introduction and documentation

## Key Concepts

- The CLI is a **harness for the agent** — it generates situation-aware task lists, not executes them
- `.context-tree/` is the framework directory that gets copied wholesale into users' repos
- Templates in `.context-tree/templates/` are rendered to `NODE.md`, `AGENT.md`, `members/NODE.md` in users' repos
- The CLI is never bundled in `.context-tree/` — it's always the pip-installed `context-tree` command

## Before Making Changes

1. Read [docs/onboarding.md](docs/onboarding.md) — the full onboarding guide for setting up a context tree
2. Read `.context-tree/principles.md` — the core ideas that Context Tree is built on
3. Read `.context-tree/ownership-and-naming.md` — how nodes and ownership work

## Rules

- **Framework files** (`.context-tree/`) must stay generic — no org-specific content. These get copied to every user's tree.
- **CLI rules** (`context_tree_cli/rules/`) are Python functions returning `{"group", "order", "tasks"}`. Add new rules by adding a new file and registering it in `rules/__init__.py`.
- **Zero external dependencies** — the CLI and all scripts use Python stdlib only.
- **Tests are mandatory** — run `uv run pytest` before submitting changes. All 111+ tests must pass.

## Testing

```bash
uv run pytest              # all tests
uv run pytest tests/test_cli_rules.py -v  # specific test file
uv run context-tree verify # run the CLI against this repo (will show expected failures for dev dirs)
```
