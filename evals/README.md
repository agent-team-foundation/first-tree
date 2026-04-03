# Eval Harness

This directory holds maintainer-only eval tooling for the `first-tree` source
repo. It is intentionally not part of the distributed
`skills/first-tree-cli-framework` package.

## What Lives Here

- `cases/`: eval definitions
- `fixtures/`: repo-specific verification scripts
- `helpers/`: sandboxing, session orchestration, parsing, and reporting
- `scripts/`: developer utilities for creating, updating, listing, and
  aggregating eval runs
- `tests/`: fast helper coverage
- `context-tree-eval.test.ts`: the end-to-end eval entrypoint behind `pnpm eval`

## Running Evals

Run evals only when `EVALS=1` is set.

```bash
EVALS=1 EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm eval
EVALS=1 EVALS_CASES='pydantic-importstring-error' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm eval
EVALS=1 EVALS_MODEL='claude-opus-4' EVALS_TRIALS=3 EVALS_CASES='...' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm eval
```

`pnpm test` already covers `evals/tests/` helper tests. Use `pnpm eval` only
for full end-to-end impact measurement.

## Outputs

- JSON run artifacts with transcripts
- HTML reports for individual and aggregated runs

Aggregate reports with:

```bash
npx tsx evals/scripts/aggregate-report.ts ~/.context-tree/evals/file1.json file2.json
```
