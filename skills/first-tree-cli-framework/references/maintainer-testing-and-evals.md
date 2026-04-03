# Testing And Evals

Use this reference when validating framework behavior or changing the testing
surface.

## Core Checks

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
```

### What Each Check Covers

- `pnpm validate:skill` verifies the canonical skill structure and sync rules.
- `pnpm typecheck` catches TypeScript boundary and import issues.
- `pnpm test` runs unit tests and lightweight eval-helper tests.
- `pnpm build` checks the thin CLI bundle.

## Targeted Unit Tests

Examples:

```bash
pnpm test -- skills/first-tree-cli-framework/tests/rules.test.ts
pnpm test -- skills/first-tree-cli-framework/tests/verify.test.ts
pnpm test -- skills/first-tree-cli-framework/tests/skill-artifacts.test.ts
```

If a future refactor changes these paths again, keep the command semantics and
coverage expectations documented here.

## Eval Harness

Eval cases live under `skills/first-tree-cli-framework/evals/cases/*.yaml`.
Each case defines:

- the target repo and commit
- the task prompt
- the verification script
- optional condition labels for comparing tree/CLI variants

Run evals only when `EVALS=1` is set.

```bash
EVALS=1 EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval
EVALS=1 EVALS_CASES='pydantic-importstring-error' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval
EVALS=1 EVALS_MODEL='claude-opus-4' EVALS_TRIALS=3 EVALS_CASES='...' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval
```

### Eval Outputs

- JSON run artifacts with transcripts
- HTML reports for single runs and aggregated runs

Aggregate reports with:

```bash
npx tsx skills/first-tree-cli-framework/evals/scripts/aggregate-report.ts ~/.context-tree/evals/file1.json file2.json
```

## Change Discipline

- Update this reference whenever test entrypoints, eval env vars, or report
  locations change.
- If a maintainer would need oral history to know which checks matter, that
  knowledge belongs here.
