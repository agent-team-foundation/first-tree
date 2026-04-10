# Agent Instructions for first-tree

This repo distributes the `first-tree` npm package: a thin CLI plus a
lightweight skill payload. It is not a user context tree. Maintaining this
repo is different from using it — see the user-facing `skills/first-tree/SKILL.md`
for what gets shipped.

## Start Here

1. `docs/source-map.md` — index of every maintainer-facing file
2. `skills/first-tree/SKILL.md` — the user-facing skill payload (read this so
   you understand what ships to user repos)
3. The specific maintainer reference linked from the source map
4. `skills/first-tree/references/source-workspace-installation.md` for the
   user-facing install contract (also shipped to user repos)

## Rules

- Treat the source repo as a TypeScript project, not a tree repo:
  - `src/engine/` is the canonical CLI behavior (bundled into dist)
  - `assets/framework/` is the runtime asset payload (templates, workflows,
    prompts, helpers, examples) read by the CLI at runtime
  - `skills/first-tree/` is the lightweight skill payload that gets copied
    verbatim to user repos via `copyCanonicalSkill`. It contains only
    `SKILL.md`, `VERSION`, and `references/` (user-facing references only).
  - `docs/` holds maintainer-only references (source-map, maintainer-*)
  - `tests/` holds the test suite
- The tracked `.agents/skills/first-tree` and `.claude/skills/first-tree`
  entries in this repo are local alias symlinks for agent discovery; edit
  `skills/first-tree/`, not the aliases.
- Use `first-tree` for both the npm package and CLI command, and
  `skills/first-tree/` when you mean the bundled skill payload path.
- Never put engine code, test code, helpers, or maintainer docs inside
  `skills/first-tree/` — that directory ships to user repos as-is.
- Keep source/workspace installs limited to local skill integration; `NODE.md`,
  `members/`, and tree-scoped `AGENTS.md` belong only in a dedicated
  `*-context` repo. See `skills/first-tree/references/source-workspace-installation.md`.
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
FIRST-TREE-SOURCE-INTEGRATION: workspace member bound to shared tree repo `first-tree-context`
FIRST-TREE-TREE-REPO: `ADHD-tree`
FIRST-TREE-TREE-MODE: `shared`
FIRST-TREE-BINDING-MODE: `workspace-member`
FIRST-TREE-TREE-REPO-URL: `https://github.com/agent-team-foundation/first-tree-context`
FIRST-TREE-ENTRYPOINT: `/workspaces/first-tree-all/repos/first-tree`
FIRST-TREE-WORKSPACE-ID: `first-tree-all`
FIRST-TREE-LOCAL-TREE-CONFIG: `.first-tree/local-tree.json`

This repo is a workspace member. Keep all Context Tree files only in the shared `first-tree-context` repo and follow the workspace root's binding for shared context updates in workspace `first-tree-all`.

Before every task:
- Read `.first-tree/local-tree.json` first. If it exists, resolve its `localPath` value from this repo root and treat that checkout as the canonical local tree repo.
- If that configured checkout exists locally, update it before you read anything else.
- If the configured checkout is missing, clone a temporary working copy from `https://github.com/agent-team-foundation/first-tree-context` into `.first-tree/tmp/first-tree-context/`, use it for the current task, and delete it before you finish.
- Never commit `.first-tree/local-tree.json` or anything under `.first-tree/tmp/` to this repo. They are local-only workspace state.

After every task:
- Always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, ownership, or shared workspace relationships, open a PR in the tree repo first. Then open the source/workspace code PR.
- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.
<!-- END FIRST-TREE-SOURCE-INTEGRATION -->
