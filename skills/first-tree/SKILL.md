---
name: first-tree
description: Maintain the canonical `first-tree` skill and CLI distributed by the `first-tree` npm package. Use when modifying `first-tree` commands (`init`, `publish`, `verify`, `upgrade`, `help onboarding`), the installed skill payload under `assets/framework/`, maintainer references, or the build, packaging, test, and CI wiring that supports the framework.
---

# First Tree

Use this skill when the task depends on the exact behavior of the
`first-tree` CLI or the installed `.agents/skills/first-tree/` and
`.claude/skills/first-tree/` payloads that `first-tree init` ships to user
repos.

## Source Of Truth

- `skills/first-tree/` is the only canonical copy.
- `references/` holds the explanatory docs the skill should load on demand.
- `assets/framework/` holds the runtime payload that gets installed into user
  repos.
- `engine/` holds the canonical framework and CLI behavior.
- `scripts/` holds maintenance helpers for validating and running the skill.
- In maintainer docs, use `first-tree` for the CLI, `skills/first-tree/` for
  the bundled source path, and `.agents/skills/first-tree/` /
  `.claude/skills/first-tree/` for installed user-repo paths.

## When To Read What

1. Start with `references/source-map.md` to locate the right files.
2. Read the user-facing reference that matches the task:
   - `references/onboarding.md`
   - `references/about.md`
   - `references/source-workspace-installation.md`
   - `references/principles.md`
   - `references/ownership-and-naming.md`
   - `references/upgrade-contract.md`
3. Read the maintainer reference that matches the shell or validation surface:
   - `references/maintainer-architecture.md`
   - `references/maintainer-thin-cli.md`
   - `references/maintainer-build-and-distribution.md`
   - `references/maintainer-testing.md`
4. Open `engine/` when changing `init`, `verify`, `upgrade`, command routing,
   repo inspection, rules, runtime helpers, or validators.
5. Open `assets/framework/` only when the task changes shipped templates,
   workflows, prompts, examples, or helper scripts.
6. Open `tests/` when changing validation coverage or maintainer workflows.
7. Use `./scripts/run-local-cli.sh <command>` when you need to exercise the
   live CLI from this repo.

## Working Modes

### Maintaining `first-tree`

- Treat this repo as the distribution source for one canonical skill plus a
  thin CLI shell, not as a tree repo.
- Keep command behavior, validator behavior, shipped assets, maintainer
  references, and package shell aligned.
- If the task is to refresh the `first-tree-all` workspace mirror skill, treat
  that as a maintainer sync step, not as normal `first-tree upgrade` behavior.
  From the `first-tree-all` superproject, update the `first-tree` submodule
  from `https://github.com/agent-team-foundation/first-tree` and repoint the
  root `.agents/skills/first-tree` and `.claude/skills/first-tree` mirrors;
  prefer `bash scripts/sync-first-tree-skill.sh --remote`.
- If root README/AGENTS/CI text explains something non-obvious, migrate that
  information into `references/` and trim the root file back down.
- If you change runtime assets or skill references, run `pnpm validate:skill`.

### Working In A User Tree Repo

- When the task is to "install and use first-tree" in an existing
  source/workspace repo, start with
  `references/source-workspace-installation.md` and follow that workflow
  end-to-end before improvising.
- When a user asks to install first-tree for an existing source/workspace repo,
  the current repo keeps only the installed skill plus a
  managed `FIRST-TREE-SOURCE-INTEGRATION:` section in `AGENTS.md` and
  `CLAUDE.md`, plus `FIRST_TREE.md`. Do not create `NODE.md`, `members/`, or
  tree-scoped `AGENTS.md` / `CLAUDE.md` there.
- `first-tree init` defaults to creating or reusing a sibling dedicated tree
  repo when invoked from a source/workspace repo. It installs the bundled skill
  into the source/workspace repo, links `FIRST_TREE.md` to
  `.agents/skills/first-tree/references/about.md` there, and scaffolds tree
  files only in the dedicated tree repo. Use `--here` to initialize the current
  repo in place when you are already inside the tree repo.
- `first-tree publish --open-pr` is the default second-stage command after
  `init` for source/workspace installs. Run it from the dedicated tree repo
  once the initial tree version is ready to push.
- Never run `first-tree init --here` in a source/workspace repo unless the
  user explicitly wants that repo itself to become the dedicated Context Tree.
  `--here` is for when you have already switched into the `*-tree` repo (or an
  older dedicated `*-context` repo).
- `first-tree init --seed-members contributors` is an explicit bootstrap aid:
  it seeds `members/*/NODE.md` from GitHub contributors when available, and
  falls back to local git history when GitHub metadata is unavailable.
- `first-tree init` does not install this skill into the target tree repo.
  Dedicated tree repos keep `.first-tree/` metadata plus `NODE.md`,
  `AGENTS.md`, `CLAUDE.md`, and `members/NODE.md`.
- The default source/workspace workflow is: run `first-tree init` from the
  source repo, draft the first tree version in `<repo>-tree`, then run
  `first-tree publish --open-pr` from that dedicated tree repo. If the source
  repo is already bound to a legacy `<repo>-context`, keep reusing that repo
  name instead of renaming it.
- After the initial scaffold is in place, treat `progress.md` as the source of
  truth for onboarding status. Before deep tree population, report
  setup/integration progress separately from tree-content baseline coverage,
  ask the user whether to continue, and if they confirm, expand the tree with
  wave-based parallel sub-tasks or subagents by top-level domain.
- After `first-tree publish` succeeds, treat the source/workspace repo's
  submodule checkout as the canonical local working copy for the tree. The
  temporary sibling bootstrap checkout can be deleted when you no longer need
  it.
- For day-to-day tasks after publish, start from the tracked tree submodule in
  the source/workspace repo. Sync submodules to the commits recorded by the
  current superproject, initialize only that tree submodule if it is missing
  locally, and fall back to the sibling bootstrap checkout only before publish
  has connected the tree back as a submodule.
- At task close-out, always ask whether the tree needs updating. If the task
  changed decisions, constraints, rationale, or ownership, send the tree PR
  first, then update the source repo's submodule pointer and send the
  source/workspace code PR. If the task changed only implementation detail,
  skip the tree PR and send only the source/workspace code PR.
- If the dedicated tree repo was initialized manually with `first-tree init --here`
  and does not have bootstrap metadata yet, pass `--source-repo PATH` to
  `first-tree publish`.
- If permissions, auth, or local filesystem constraints block the dedicated
  repo workflow, stop and report the blocker. Do not fall back to in-place tree
  bootstrap in the source/workspace repo.
- `first-tree upgrade` refreshes the installed skill from the copy bundled
  with the currently running `first-tree` package. In a source/workspace repo
  it refreshes only the local skill, the `FIRST_TREE.md` symlink, plus the
  `FIRST-TREE-SOURCE-INTEGRATION:` section; upgrade the dedicated tree repo
  separately with `--tree-path`. Dedicated tree repos refresh only
  `.first-tree/`. To pick up a newer framework, run a newer package version
  first. It also migrates older repos that still use `skills/first-tree/`.
- The user's tree content lives outside the skill; the skill only carries the
  reusable framework payload plus maintenance guidance.
- The tree still stores decisions, constraints, and ownership; execution detail
  stays in source systems.

## Non-Negotiables

- Preserve the CLI contract that it scaffolds, prints task lists, and validates
  state; it does not fully automate tree maintenance.
- Keep shipped assets generic. They must not contain org-specific content.
- Keep decision knowledge in the tree and execution detail in source systems.
- Keep the skill as the only canonical knowledge source. The root CLI/package
  shell must not become a second source of framework semantics.
- Keep the CLI name written as `first-tree` in maintainer and user-facing
  docs so command examples stay aligned with the published package.
- Keep normal `init` / `upgrade` flows self-contained. They must work from the
  skill bundled in the current package without cloning the source repo or
  relying on network access.
- Keep workspace-level mirror sync separate from runtime install/upgrade
  behavior. A `first-tree-all` maintainer may explicitly update the
  `first-tree` submodule from GitHub and repoint root mirror symlinks, but that
  is not a requirement for routine skill use in source/workspace repos.
- Make upgrade behavior explicit. If you change installed paths, update
  `references/upgrade-contract.md`, task text, and tests together.

## Validation

- Repo checks: `pnpm typecheck`, `pnpm test`, `pnpm build`
- Packaging check: `pnpm pack` when changing package contents or install/upgrade
  behavior
- Skill checks:
  - `pnpm validate:skill`
  - `python3 ./skills/first-tree/scripts/quick_validate.py ./skills/first-tree`
  - `bash ./skills/first-tree/scripts/check-skill-sync.sh`

## Key Files

- `assets/framework/manifest.json`: runtime asset contract
- `assets/framework/templates/`: generated scaffolds
- `assets/framework/workflows/`: CI templates
- `assets/framework/helpers/`: shipped helper scripts and review tooling
- `assets/framework/helpers/summarize-progress.js`: optional onboarding
  checkpoint helper for turning `progress.md` into a setup-vs-tree summary
- `engine/`: canonical framework and CLI behavior
- `tests/`: canonical unit and structure validation
- `references/source-map.md`: canonical reading index
- `references/source-workspace-installation.md`: source/workspace install
  contract
- `references/maintainer-architecture.md`: source-repo architecture and
  invariants
- `references/maintainer-thin-cli.md`: root shell contract
- `references/maintainer-build-and-distribution.md`: packaging and release
  guidance
- `references/maintainer-testing.md`: validation workflow
- `references/upgrade-contract.md`: installed layout and upgrade semantics
