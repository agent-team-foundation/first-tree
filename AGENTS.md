# Agent Instructions for first-tree

This repo distributes the `first-tree` npm package: a thin umbrella CLI that
dispatches into three product namespaces (`tree`, `breeze`, `gardener`) plus
four lightweight skill payloads (`first-tree` entry point + one per product).
It is not a user context tree. Maintaining this repo is different from using
it — see the user-facing `skills/first-tree/SKILL.md` for what gets shipped
as the entry-point skill.

## Start Here

1. `docs/source-map.md` — maintainer entrypoint; it points to canonical Context Tree nodes first, then local implementation notes
2. `src/products/manifest.ts` — the single source of truth for the three
   products; all dispatch, version reporting, and skill management reads from
   here
3. `skills/first-tree/SKILL.md` — the user-facing entry-point skill (read
   this so you understand what ships to user repos and how it routes to the
   product skills)
4. The specific Context Tree node or repo-local maintainer reference linked
   from the source map
5. `skills/first-tree/references/source-workspace-installation.md` for the
   user-facing install contract (also shipped to user repos)

## Rules

- Treat the source repo as a TypeScript project, not a tree repo.
- Canonical layout:
  - `src/cli.ts` — top-level umbrella dispatcher (`first-tree <product> <command>`); delegates to the manifest
  - `src/products/manifest.ts` — the product manifest (name, description,
    lazy entrypoint, auto-upgrade, assets/skill flags)
  - `src/products/<name>/` — one folder per product (`tree`, `breeze`,
    `gardener`). Each has the same shape:
    - `VERSION` — product version (separate from npm package version)
    - `cli.ts` — thin arg-routing dispatcher, lazy-loads everything heavy
    - `engine/commands/` — one file per subcommand
    - `engine/runtime/` — runtime config, constants, paths (breeze calls
      this `runtime/` too; it used to be `core/` before the shape was
      unified)
    - `engine/` root — business-logic modules (domain specific)
    - Product-specific extras: `engine/daemon/` (breeze), `engine/rules/`
      and `engine/validators/` (tree)
  - `assets/<name>/` — runtime payloads read by the CLI at runtime. Only
    `tree` ships real assets today; `breeze` ships just the SSE dashboard
    HTML; `gardener` ships none.
  - `skills/<name>/` — user-facing skill payloads. Four of them:
    - `skills/first-tree/` — entry-point skill with all the shared
      `references/` (whitepaper, principles, ownership, onboarding,
      source-workspace-installation, upgrade-contract)
    - `skills/tree/`, `skills/breeze/`, `skills/gardener/` — one-file
      operational handbooks (`SKILL.md` + `VERSION`) for each product CLI
  - `docs/` — source-repo implementation notes and file maps; canonical
    design/architecture decisions belong in the bound Context Tree under
    `first-tree-skill-cli/`
  - `tests/` — the test suite
- The tracked `.agents/skills/<name>` and `.claude/skills/<name>` entries in
  this repo are local alias symlinks for agent discovery — there is one
  alias per skill (four of each). Edit `skills/<name>/`, not the aliases.
- Use `first-tree` for both the npm package and the CLI command. Use
  `skills/first-tree/` when you mean the entry-point skill payload;
  `skills/<product>/` when you mean a product operational handbook.
- Never put engine code, test code, helpers, or maintainer docs inside
  `skills/<name>/` — those directories ship to user repos as-is.
- Keep source/workspace installs limited to local skill integration; `NODE.md`,
  `members/`, and tree-scoped `AGENTS.md` belong only in a dedicated
  `*-context` repo. See `skills/first-tree/references/source-workspace-installation.md`.
- When a maintainer note becomes decision-grade knowledge other repos should
  discover, move it into `first-tree-context/first-tree-skill-cli/` and leave a
  thin repo-local pointer in `docs/`.
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
FIRST-TREE-TREE-REPO: `first-tree-context`
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
