# Agent Instructions for first-tree

This repo ships the canonical `first-tree` skill plus a thin
`context-tree` CLI. It is not a user context tree.

## Start Here

1. `skills/first-tree/SKILL.md`
2. `skills/first-tree/references/source-map.md`
3. The specific maintainer reference linked from the source map

## Rules

- Treat `skills/first-tree/` as the only canonical source of
  framework knowledge.
- Use `first-tree` for the npm package, `context-tree` for the CLI command, and
  `skills/first-tree/` when you mean the bundled skill path.
- Keep root CLI/package files thin. If a maintainer needs information to change
  behavior safely, move that information into the skill references.
- Keep shipped runtime assets generic.

## Validation

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Maintainer-only eval tooling lives in `evals/`. See `evals/README.md` before
running `EVALS=1 pnpm eval`.

### Eval quick reference

```bash
# End-to-end: check envs → create trees → run evals → report
npx tsx evals/scripts/run-eval.ts --tree-repo agent-team-foundation/eval-context-trees

# Check runtime environments only (verify.sh validation)
npx tsx evals/scripts/check-env.ts
npx tsx evals/scripts/check-env.ts --cases nanobot-exectool-regex

# Run evals with multiple trials
npx tsx evals/scripts/run-eval.ts --trials 3 --cases pydantic-importstring-error
```
