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
- The tracked `.agents/skills/first-tree` and `.claude/skills/first-tree`
  entries in this repo are local alias symlinks for agent discovery; edit
  `skills/first-tree/`, not the aliases.
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
FIRST-TREE-SOURCE-INTEGRATION: dedicated tree repo `ADHD-tree`
FIRST-TREE-TREE-REPO-URL: `https://github.com/agent-team-foundation/first-tree-context.git`
FIRST-TREE-LOCAL-TREE-CONFIG: `.first-tree/local-tree.json`

This repo is a source/workspace repo. Keep all Context Tree files only in the dedicated `first-tree-context` repo.

Before every task:
- Read `.first-tree/local-tree.json` first. If it exists, resolve its `localPath` value from this repo root and treat that checkout as the canonical local tree repo.
- If that configured checkout exists locally, update it before you read anything else.
- If the configured checkout is missing, clone a temporary working copy from `https://github.com/agent-team-foundation/first-tree-context.git` into `.first-tree/tmp/first-tree-context/`, use it for the current task, and delete it before you finish.
- Never commit `.first-tree/local-tree.json` or anything under `.first-tree/tmp/` to this repo. They are local-only workspace state.

After every task:
- Always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, or ownership, open a PR in the tree repo first. Then open the source/workspace code PR.
- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.
<!-- END FIRST-TREE-SOURCE-INTEGRATION -->
