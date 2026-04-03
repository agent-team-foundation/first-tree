# Agent Instructions for first-tree

This repo is the **template source and CLI** for Context Tree. It is NOT a context tree itself.

## Repo Structure

- `src/` — TypeScript source for the `context-tree` CLI
  - `src/rules/` — Rule modules that generate situation-aware task lists
  - `src/validators/` — Node, member, and CODEOWNERS validation
- `src/runtime/` — Shared path, install, adapter, and upgrade helpers
- `skills/first-tree-cli-framework/` — Canonical skill source for docs and shipped runtime assets
- `.context-tree/` — Temporary exported mirror of the shipped runtime assets during the single-skill migration
  - `tests/` — Unit tests (Vitest)
  - `docs/` — Introduction and documentation

## Key Concepts

- The CLI is a **harness for the agent** — it generates situation-aware task lists, not executes them
- `skills/first-tree-cli-framework/` is the single canonical source; `assets/framework/` is the shipped runtime payload
- `.context-tree/` is currently an exported compatibility mirror while the refactor converges
- Templates in `skills/first-tree-cli-framework/assets/framework/templates/` ultimately render `NODE.md`, `AGENT.md`, `members/NODE.md` in users' repos
- The npm package is `first-tree`, and it installs the `context-tree` command. Use `npx first-tree ...` for one-off runs or `npm install -g first-tree` to put `context-tree` on your PATH.

## Before Making Changes

1. Read [docs/onboarding.md](docs/onboarding.md) — the full onboarding guide for setting up a context tree
2. Read `skills/first-tree-cli-framework/references/principles.md` — the core ideas that Context Tree is built on
3. Read `skills/first-tree-cli-framework/references/ownership-and-naming.md` — how nodes and ownership work

## Repo-Local Skill

- Use `skills/first-tree-cli-framework/SKILL.md` as the source-of-truth skill when working on `src/cli.ts`, `src/init.ts`, `src/verify.ts`, `src/upgrade.ts`, `src/runtime/`, or any task that needs the exact Context Tree maintenance model implemented in this repo.
- `.agents/skills/first-tree-cli-framework/` and `.claude/skills/first-tree-cli-framework/` are generated mirrors for agent discovery. Do not edit those mirrors directly; refresh them from the source skill with `bash skills/first-tree-cli-framework/scripts/sync-skill-artifacts.sh`.

## Rules

- **Canonical runtime assets** (`skills/first-tree-cli-framework/assets/framework/`) must stay generic — no org-specific content. These get copied to every user's tree.
- **CLI rules** (`src/rules/`) are TypeScript modules exporting `evaluate(repo): RuleResult`. Add new rules by adding a file and registering it in `src/rules/index.ts`.
- **Zero runtime dependencies** — the CLI uses only Node.js built-in modules.
- **Tests are mandatory** — run `pnpm test` before submitting changes. All tests must pass.

## Testing

```bash
pnpm test                            # all tests
pnpm test tests/rules.test.ts        # specific test file
pnpm typecheck                       # type check
```

## Evals

Eval cases live in `evals/cases/*.yaml`. Each case defines a bug-fix task, a repo+commit to clone, a verification script, and optional context tree versions for A/B comparison.

### Running evals

```bash
# Run a single case (baseline + tree conditions)
EVALS=1 EVALS_CASES='pydantic-importstring-error' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval

# Run all cases
EVALS=1 EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval

# Override model or number of trials
EVALS=1 EVALS_MODEL='claude-opus-4' EVALS_TRIALS=3 EVALS_CASES='...' EVALS_TREE_REPO='...' pnpm run eval
```

Results are saved to `~/.context-tree/evals/` as JSON (with transcript) and HTML (report).

### Generating reports

Each eval run automatically produces an HTML report alongside the JSON. To aggregate multiple runs into one report:

```bash
npx tsx evals/scripts/aggregate-report.ts ~/.context-tree/evals/file1.json file2.json ...
```

### Managing context trees for evals

```bash
# Create a new context tree for a repo at a specific commit
npx tsx evals/scripts/create-tree.ts --repo org/repo --commit <sha> --cli-version <first-tree-sha> --tree-repo agent-team-foundation/eval-context-trees

# List existing trees
npx tsx evals/scripts/list-trees.ts --tree-repo agent-team-foundation/eval-context-trees
```

### Key env vars

| Variable | Description |
|----------|-------------|
| `EVALS=1` | Required to enable evals (otherwise skipped) |
| `EVALS_CASES` | Comma-separated case IDs to run |
| `EVALS_TREE_REPO` | GitHub repo slug for context trees |
| `EVALS_CONDITIONS` | Filter conditions (e.g. `baseline,cli-v0.0.2`) |
| `EVALS_TRIALS` | Number of trials per condition (default: 1) |
| `EVALS_MODEL` | Model to use (default: `claude-sonnet-4-6`) |
