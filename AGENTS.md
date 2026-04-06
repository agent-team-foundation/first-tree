# Agent Instructions for first-tree

This repo ships the canonical `first-tree` skill plus a thin
`first-tree` CLI. It is not a user context tree.

## Start Here

1. `skills/first-tree/SKILL.md`
2. `skills/first-tree/references/source-map.md`
3. The specific maintainer reference linked from the source map

## Rules

- Treat `skills/first-tree/` as the only canonical source of
  framework knowledge.
- Use `first-tree` for both the npm package and CLI command, and
  `skills/first-tree/` when you mean the bundled skill path.
- Keep source/workspace installs limited to local skill integration; `NODE.md`,
  `members/`, and tree-scoped `AGENTS.md` belong only in a dedicated
  `*-context` repo. See `skills/first-tree/references/source-workspace-installation.md`.
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
# End-to-end: check envs -> create trees -> run evals -> report
npx tsx evals/scripts/run-eval.ts --tree-repo agent-team-foundation/eval-context-trees

# Check runtime environments only (verify.sh validation)
npx tsx evals/scripts/check-env.ts
npx tsx evals/scripts/check-env.ts --cases nanobot-exectool-regex

# Run evals with multiple trials
npx tsx evals/scripts/run-eval.ts --trials 3 --cases pydantic-importstring-error
```

<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->
FIRST-TREE-SOURCE-INTEGRATION:

This repo is a source/workspace repo. Keep all Context Tree files only in the dedicated `first-tree-context` repo/submodule.

Before every task:
- If this workspace already tracks the Context Tree as a git submodule, sync submodules to the commits recorded by the current superproject and read the tracked tree first (preferred path: `first-tree-context/`).
- If that submodule directory exists but is not initialized locally, initialize only that submodule; do not update every submodule in the workspace.
- If the tree has not been published back to this workspace as a tracked submodule yet, work from the sibling dedicated `first-tree-context` bootstrap repo instead.

After every task:
- Always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, or ownership, open a PR in the tree repo first. Then update this repo's Context Tree submodule pointer and open the source/workspace code PR.
- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.
<!-- END FIRST-TREE-SOURCE-INTEGRATION -->
