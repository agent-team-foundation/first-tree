# Agent Instructions for first-tree

This repo distributes the `first-tree` npm package: a thin umbrella CLI with
three primary product namespaces (`tree`, `breeze`, `gardener`), one
maintenance namespace (`skill`), and four lightweight skill payloads
(`first-tree` entry point + one per product). It is not a user context tree.
Maintaining this repo is different from using it — see the user-facing
`skills/first-tree/SKILL.md` for what gets shipped as the entry-point skill.

## Start Here

1. `docs/source-map.md` — maintainer entrypoint; it points to canonical Context Tree nodes first, then local implementation notes
2. `src/products/manifest.ts` — the single source of truth for the CLI
   namespaces; all dispatch, version reporting, and skill management reads from
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
  - `src/cli.ts` — top-level umbrella dispatcher (`first-tree <namespace> <command>`); delegates to the manifest
  - `src/products/manifest.ts` — the CLI namespace manifest (kind, name,
    description, lazy entrypoint, auto-upgrade, assets/skill flags)
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
  - `src/meta/skill-tools/` — maintenance namespace for skill inspection and
    repair (`list`, `doctor`, `link`); it ships no product skill payload of
    its own
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

Single release gate — CI runs this exact command and `prepublishOnly`
reruns it before `npm publish`:

```bash
pnpm release:check
```

Individual steps if you want to iterate on one layer:

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
pnpm test:dist     # post-build binary smoke (requires a prior pnpm build)
pnpm test:release  # pack + npm install <tarball> smoke
pnpm test:agent    # LLM-judge + real-Claude skill behaviour (needs `claude` CLI; uses your subscription locally or ANTHROPIC_API_KEY in CI; out-of-band from release:check)
```

See `docs/testing/overview.md` for the layered gate contract. The
agent-e2e tier runs on a weekly cron via `.github/workflows/agent-e2e.yml`
and can be dispatched manually before a release; it is not part of
every-PR CI.

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
## First Tree integration

> Managed block — regenerated by `first-tree` tooling. Do not edit by hand.

This repo is bound to an existing shared Context Tree. Keep all Context Tree files only in the shared `first-tree-context` repo.

### Binding

- **Tree repo:** `first-tree-context` (shared)
- **Binding mode:** `shared-source`
- **Entrypoint:** `/repos/first-tree`
- **Tree repo URL:** <https://github.com/agent-team-foundation/first-tree-context>
- **Source state:** `.first-tree/source.json`

<!--
FIRST-TREE-SOURCE-INTEGRATION: source repo bound to shared tree repo `first-tree-context`
FIRST-TREE-TREE-REPO: `first-tree-context`
FIRST-TREE-TREE-MODE: `shared`
FIRST-TREE-BINDING-MODE: `shared-source`
FIRST-TREE-TREE-REPO-URL: `https://github.com/agent-team-foundation/first-tree-context`
FIRST-TREE-ENTRYPOINT: `/repos/first-tree`
FIRST-TREE-SOURCE-STATE: `.first-tree/source.json`
-->

### Before every task

- Read `.first-tree/source.json` first. If it exists, resolve its `tree.localPath` value from this repo root and treat that checkout as the canonical local tree repo.
- If that configured checkout exists locally, update it before you read anything else.
- If the configured checkout is missing, clone a temporary working copy from `https://github.com/agent-team-foundation/first-tree-context` into `.first-tree/tmp/first-tree-context/`, use it for the current task, and delete it before you finish.
- Never commit anything under `.first-tree/tmp/` to this repo. It is local-only workspace state.

### After every task

- Always ask whether the tree needs updating.
- If the task changed decisions, constraints, rationale, ownership, or shared workspace relationships, open a PR in the tree repo first. Then open the source/workspace code PR.
- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.
<!-- END FIRST-TREE-SOURCE-INTEGRATION -->
